/**
 * Hub HTTP client (§4.0 rule 5, §3.3, §3.4, §10.4): `fetch` with
 * `AbortSignal.timeout`, team-token auth, X-Relay-* headers, snapshot-on-
 * every-response hook, breaker bookkeeping (workers only), WAL-first posting
 * (§4.0 rule 6) and idempotent event ids. Never throws.
 */
import { breakerOpen, readBreaker, recordConfigError, recordSuccess, recordWorkerFailure, writeRefreshWanted } from './breaker.js';
import { deleteOutbox, writeOutbox, type WriteOutboxInput } from './outbox.js';
import {
  BUDGET_MS,
  HTTP_STATUS,
  PROTOCOL_VERSION,
  RELAY_HEADERS,
  isRecord,
  isSnapshot,
  type EventBase,
  type HubErrorBody,
  type HubWarning,
  type OutboxEntry,
  type RelayEvent,
  type RequestClient,
  type Snapshot,
} from './protocol.js';
import { ulid } from './ulid.js';
import { nowIso } from './util.js';

export type HubFailureKind = 'timeout' | 'network' | 'http' | 'config' | 'parse' | 'breaker' | 'unconfigured';

export type HubResult<T> =
  | { ok: true; status: number; data: T; warn: HubWarning[]; ms: number; snapshot: Snapshot | null }
  | { ok: false; status: number | null; kind: HubFailureKind; message: string; ms: number; body?: HubErrorBody | null; retryable: boolean };

export interface HubClientOptions {
  hub: string;
  token: string;
  dev: string;
  client: RequestClient;
  sessionId?: string | null;
  pluginSha?: string | null;
  /** $RELAY_HOME; enables breaker files, WAL and refresh-wanted */
  home?: string | null;
  /** called with every `snapshot` found in a 2xx body (§4.0 rule 8) */
  onSnapshot?: (snapshot: Snapshot) => void;
  /** injectable for tests */
  fetch?: typeof fetch;
  /** sync hooks never open the breaker; workers do (§4.0 rule 5) */
  role?: 'sync' | 'worker';
}

export interface RequestOptions {
  budgetMs?: number;
  /** skip the breaker check (the breaker is consulted by default) */
  ignoreBreaker?: boolean;
  signal?: AbortSignal;
}

/** Combine the budget with an optional outer deadline (older Node lacks AbortSignal.any). */
function budgetSignal(budgetMs: number, outer?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(budgetMs);
  if (!outer) return timer;
  const ctrl = new AbortController();
  const abort = (): void => ctrl.abort();
  timer.addEventListener('abort', abort, { once: true });
  outer.addEventListener('abort', abort, { once: true });
  if (outer.aborted) ctrl.abort();
  return ctrl.signal;
}

export class HubClient {
  readonly hub: string;
  readonly role: 'sync' | 'worker';
  private readonly opts: HubClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HubClientOptions) {
    this.opts = opts;
    this.hub = opts.hub.replace(/\/+$/, '');
    this.role = opts.role ?? 'sync';
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** Headers of §10.4. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.opts.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      [RELAY_HEADERS.dev]: this.opts.dev,
      [RELAY_HEADERS.client]: this.opts.client,
      [RELAY_HEADERS.proto]: String(PROTOCOL_VERSION),
      ...extra,
    };
    if (this.opts.sessionId) h[RELAY_HEADERS.session] = this.opts.sessionId;
    if (this.opts.pluginSha) h[RELAY_HEADERS.plugin] = this.opts.pluginSha;
    return h;
  }

  get<T>(path: string, query: Record<string, string | undefined> = {}, opts: RequestOptions = {}): Promise<HubResult<T>> {
    const qs = Object.entries(query)
      .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return this.request<T>('GET', qs ? `${path}?${qs}` : path, undefined, opts);
  }

  post<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<HubResult<T>> {
    return this.request<T>('POST', path, body, opts);
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, opts: RequestOptions): Promise<HubResult<T>> {
    const started = Date.now();
    const home = this.opts.home ?? null;
    if (!this.hub || !this.opts.token) {
      return { ok: false, status: null, kind: 'unconfigured', message: 'hub or token not configured', ms: 0, retryable: false };
    }
    if (home && !opts.ignoreBreaker && breakerOpen(home, started)) {
      return { ok: false, status: null, kind: 'breaker', message: 'breaker open', ms: 0, retryable: true };
    }
    const budgetMs = opts.budgetMs ?? (this.role === 'worker' ? BUDGET_MS.workerPost : BUDGET_MS.promptRefresh);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.hub}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: budgetSignal(budgetMs, opts.signal),
      });
    } catch (err) {
      const ms = Date.now() - started;
      const name = isRecord(err) ? String(err['name'] ?? '') : '';
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      this.noteFailure(home, timeout);
      return { ok: false, status: null, kind: timeout ? 'timeout' : 'network', message: String((err as Error)?.message ?? err), ms, retryable: true };
    }
    const ms = Date.now() - started;
    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (res.ok) {
      if (home) recordSuccess(home);
      const warnHeader = res.headers.get(RELAY_HEADERS.warn);
      const warn: HubWarning[] = [];
      if (warnHeader) warn.push(warnHeader);
      if (isRecord(parsed) && Array.isArray(parsed['warn'])) for (const w of parsed['warn']) if (typeof w === 'string') warn.push(w);
      let snapshot: Snapshot | null = null;
      if (isRecord(parsed)) {
        const cand = parsed['snapshot'] !== undefined ? parsed['snapshot'] : parsed;
        if (isSnapshot(cand)) snapshot = cand;
      }
      if (snapshot && this.opts.onSnapshot) {
        try {
          this.opts.onSnapshot(snapshot);
        } catch {
          /* cache write failures never fail the request */
        }
      }
      return { ok: true, status: res.status, data: (parsed ?? text) as T, warn, ms, snapshot };
    }
    const errBody = isRecord(parsed) && typeof parsed['error'] === 'string' ? (parsed as unknown as HubErrorBody) : null;
    const message = errBody?.message ?? errBody?.error ?? `HTTP ${res.status}`;
    const status = res.status;
    if (status === HTTP_STATUS.badToken || status === HTTP_STATUS.clientTooOld || status === HTTP_STATUS.payloadTooLarge) {
      if (home) recordConfigError(home, status, message, Date.now());
      return { ok: false, status, kind: 'config', message, ms, body: errBody, retryable: false };
    }
    // 429 and 5xx count as outages; other 4xx are permanent for this body
    const retryable = status === HTTP_STATUS.rateLimited || status >= 500;
    if (retryable) this.noteFailure(home, false);
    return { ok: false, status, kind: 'http', message, ms, body: errBody, retryable };
  }

  private noteFailure(home: string | null, timeout: boolean): void {
    if (!home) return;
    if (this.role === 'worker') recordWorkerFailure(home);
    else if (timeout) writeRefreshWanted(home);
  }
}

/** New idempotency envelope for a client event (§10.1). */
export function eventBase(now: number = Date.now()): EventBase {
  return { id: ulid(now), at: nowIso(now) };
}

/** Build a typed event with a fresh id and timestamp. */
export function makeEvent<T extends RelayEvent>(fields: Omit<T, 'id' | 'at'> & Partial<EventBase>, now: number = Date.now()): T {
  const base = eventBase(now);
  return { ...base, ...fields } as T;
}

export interface WalPostResult<T> {
  entry: OutboxEntry | null;
  result: HubResult<T>;
}

/**
 * WAL-first POST (§4.0 rule 6): write outbox/<ulid>.json, POST, delete on 2xx.
 * Configuration errors (401/426/413) and permanent 4xx also delete the entry
 * (the body must not be replayed); transient failures leave it for the drain.
 */
export async function postWithWal<T>(
  client: HubClient,
  home: string,
  input: WriteOutboxInput,
  opts: RequestOptions = {},
): Promise<WalPostResult<T>> {
  // A configuration-error breaker (401/426/413) must not build an outbox backlog (§4.0 rule 5).
  const breaker = readBreaker(home);
  if (breaker.open && breaker.configError && !opts.ignoreBreaker) {
    return {
      entry: null,
      result: { ok: false, status: breaker.configError.status, kind: 'config', message: breaker.configError.message, ms: 0, retryable: false },
    };
  }
  const entry = writeOutbox(home, input);
  const result = await client.post<T>(input.endpoint, input.body, opts);
  if (entry && (result.ok || (!result.ok && !result.retryable && result.kind !== 'breaker' && result.kind !== 'unconfigured'))) {
    deleteOutbox(home, entry.id);
  }
  return { entry, result };
}

/** Sender for `drainOutbox`: 2xx -> true, config/permanent -> 'discard', transient -> false. */
export function walSender(client: HubClient, opts: RequestOptions = {}): (entry: OutboxEntry, body: OutboxEntry['body']) => Promise<boolean | 'discard'> {
  return async (entry, body) => {
    const r = await client.post(entry.endpoint, body, opts);
    if (r.ok) return true;
    if (r.kind === 'config' || (r.kind === 'http' && !r.retryable)) return 'discard';
    return false;
  };
}
