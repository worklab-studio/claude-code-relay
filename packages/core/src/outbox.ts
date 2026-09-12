/**
 * Outbox = write-ahead log (§4.0 rule 6, §10.3): `outbox/<ulid>.json` is
 * written (tmp + rename) BEFORE every POST and deleted on 2xx, so a hook
 * killed mid-request leaves its body behind instead of losing it. The drain
 * plan is pure (`planDrain`); `drainOutbox` runs it with a caller-supplied
 * sender, oldest first, cap 200, stopping at the first transient failure. An
 * entry that keeps failing is dropped after LIMITS.outboxMaxAttempts sends so a
 * poison body cannot block the entries behind it for seven days.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIMITS,
  LOCAL_PATHS,
  isOutboxEntry,
  type DepIndex,
  type EventsRequest,
  type OutboxEntry,
  type OutboxKind,
  type RelayEvent,
  type SessionEndRequest,
  type SessionStartRequest,
} from './protocol.js';
import { ulid, ulidTime } from './ulid.js';
import { nowIso, parseIso, readJson, removeFile, writeJsonAtomic } from './util.js';

export function outboxDir(home: string): string {
  return join(home, LOCAL_PATHS.outboxDir);
}

export function outboxPath(home: string, id: string): string {
  return join(outboxDir(home), `${id}.json`);
}

/** Event types whose bodies are stale after 24 h (prompt / edit / turn_end / cwd / presence-only). */
const EPHEMERAL_EVENT_TYPES: ReadonlySet<string> = new Set(['prompt', 'edit', 'turn_end', 'cwd']);

/** An events body with only ephemeral event types (or none: presence-only) is ephemeral (§4.0 rule 6). */
export function isEphemeralEvents(events: readonly RelayEvent[]): boolean {
  return events.every((e) => EPHEMERAL_EVENT_TYPES.has(e.type));
}

/** Default ephemeral flag per kind/body. */
export function defaultEphemeral(kind: OutboxKind, body: OutboxEntry['body']): boolean {
  if (kind === 'events') return isEphemeralEvents((body as EventsRequest).events ?? []);
  if (kind === 'session_start') return true; // a replayed session start has no value after a day
  return false;
}

export interface WriteOutboxInput {
  sessionId: string;
  kind: OutboxKind;
  endpoint: string;
  body: SessionStartRequest | EventsRequest | SessionEndRequest | DepIndex;
  ephemeral?: boolean;
  at?: string;
  now?: number;
}

/** Write a WAL entry; returns the entry (with its id) or null when the write failed. */
export function writeOutbox(home: string, input: WriteOutboxInput): OutboxEntry | null {
  const now = input.now ?? Date.now();
  const entry: OutboxEntry = {
    v: 1,
    id: ulid(now),
    sessionId: input.sessionId,
    at: input.at ?? nowIso(now),
    kind: input.kind,
    endpoint: input.endpoint,
    ephemeral: input.ephemeral ?? defaultEphemeral(input.kind, input.body),
    body: input.body,
  };
  return writeJsonAtomic(outboxPath(home, entry.id), entry) ? entry : null;
}

export function deleteOutbox(home: string, id: string): boolean {
  return removeFile(outboxPath(home, id));
}

/** All entries, oldest first (ULID order); malformed files are skipped (and reported as `broken`). */
export function listOutbox(home: string): { entries: OutboxEntry[]; broken: string[] } {
  let names: string[];
  try {
    names = readdirSync(outboxDir(home)).filter((n) => /^[0-9A-Z]{26}\.json$/i.test(n)).sort();
  } catch {
    return { entries: [], broken: [] };
  }
  const entries: OutboxEntry[] = [];
  const broken: string[] = [];
  for (const n of names) {
    const v = readJson(join(outboxDir(home), n));
    if (isOutboxEntry(v)) entries.push(v);
    else broken.push(n.slice(0, -5));
  }
  return { entries, broken };
}

export interface DrainPlan {
  send: OutboxEntry[];
  /** ids to delete without sending (too old) */
  drop: string[];
  /** ids skipped this run (younger than 30 s: may still be in flight) */
  skip: string[];
}

/** Drain rules (§4.0 rule 6): skip < 30 s, drop ephemeral > 24 h and everything > 7 d, cap 200, oldest first. */
export function planDrain(entries: readonly OutboxEntry[], now: number = Date.now(), cap: number = LIMITS.outboxDrainPerRun): DrainPlan {
  const plan: DrainPlan = { send: [], drop: [], skip: [] };
  const createdAt = (e: OutboxEntry): number => parseIso(e.at) ?? ulidTime(e.id) ?? now;
  const sorted = [...entries].sort((a, b) => createdAt(a) - createdAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of sorted) {
    const created = createdAt(e);
    const age = now - created;
    if (age < LIMITS.outboxInFlightMs) {
      plan.skip.push(e.id);
      continue;
    }
    if (age > LIMITS.outboxMaxAgeMs || (e.ephemeral && age > LIMITS.outboxEphemeralMaxAgeMs)) {
      plan.drop.push(e.id);
      continue;
    }
    if (plan.send.length < cap) plan.send.push(e);
  }
  return plan;
}

/** The body to replay: `replay: true` on events / session_end; session start and depindex go as-is (§10.4). */
export function replayBody(entry: OutboxEntry): OutboxEntry['body'] {
  if (entry.kind === 'events' || entry.kind === 'session_end') return { ...(entry.body as EventsRequest | SessionEndRequest), replay: true };
  return entry.body;
}

export interface DrainResult {
  sent: string[];
  dropped: string[];
  skipped: string[];
  /** id of the entry whose send failed transiently (drain stops there) */
  failedAt: string | null;
  /** the wall-time budget ran out before the plan was finished */
  outOfTime: boolean;
}

/** Record a failed send on the entry file; returns the new attempt count. */
export function recordOutboxAttempt(home: string, entry: OutboxEntry, error?: string): number {
  const attempts = (entry.attempts ?? 0) + 1;
  const next: OutboxEntry = { ...entry, attempts, ...(error ? { lastError: error.slice(0, 200) } : {}) };
  writeJsonAtomic(outboxPath(home, entry.id), next);
  return attempts;
}

/**
 * Run the plan. `send` returns true on 2xx (entry deleted), false on a
 * transient failure (entry kept with attempts+1; the drain stops there unless
 * the entry just hit LIMITS.outboxMaxAttempts, in which case it is dropped and
 * the drain continues), or 'discard' for a configuration error / permanent
 * rejection (entry deleted, drain continues with the next entry).
 */
export async function drainOutbox(
  home: string,
  send: (entry: OutboxEntry, body: OutboxEntry['body']) => Promise<boolean | 'discard'>,
  opts: { now?: number; cap?: number; budgetMs?: number; maxAttempts?: number } = {},
): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  const maxAttempts = opts.maxAttempts ?? LIMITS.outboxMaxAttempts;
  const deadline = opts.budgetMs === undefined ? null : Date.now() + opts.budgetMs;
  const { entries, broken } = listOutbox(home);
  const plan = planDrain(entries, now, opts.cap);
  const result: DrainResult = { sent: [], dropped: [...broken], skipped: plan.skip, failedAt: null, outOfTime: false };
  for (const id of [...plan.drop, ...broken]) if (deleteOutbox(home, id)) result.dropped.push(id);
  result.dropped = [...new Set(result.dropped)];
  for (const entry of plan.send) {
    if (deadline !== null && Date.now() >= deadline) {
      result.outOfTime = true;
      break;
    }
    let outcome: boolean | 'discard';
    let error: string | undefined;
    try {
      outcome = await send(entry, replayBody(entry));
    } catch (err) {
      outcome = false;
      error = String((err as Error)?.message ?? err);
    }
    if (outcome === true) {
      deleteOutbox(home, entry.id);
      result.sent.push(entry.id);
    } else if (outcome === 'discard') {
      deleteOutbox(home, entry.id);
      result.dropped.push(entry.id);
    } else {
      const attempts = recordOutboxAttempt(home, entry, error);
      if (attempts >= maxAttempts) {
        deleteOutbox(home, entry.id);
        result.dropped.push(entry.id);
        continue;
      }
      result.failedAt = entry.id;
      break;
    }
  }
  return result;
}
