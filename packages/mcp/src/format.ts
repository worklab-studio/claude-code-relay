/**
 * Tool output shape (§9.2): compact factual text, then one fenced `json`
 * block with the structured payload. Times are absolute (§4.0 rule 15/16).
 * Read tools served from the cache carry a "(cached HH:MMZ)" label (§9.1).
 */
import { hhmm, humanAge, shortTime, snapshotAgeMs, type CachedSnapshot, type Freshness, type HubResult } from '@relay/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Upper bound for the json block; larger payloads are shrunk (hunks dropped, arrays cut). */
export const JSON_BLOCK_MAX_CHARS = 24_000;
const ARRAY_CAP = 25;

export function toolResult(text: string, json: unknown, opts: { isError?: boolean } = {}): CallToolResult {
  const body = `${text.trimEnd()}\n\n\`\`\`json\n${jsonBlock(json)}\n\`\`\``;
  return { content: [{ type: 'text', text: body }], ...(opts.isError ? { isError: true } : {}) };
}

/** Compact JSON; when over the cap, drop `hunk`/`markdown` bodies, then cut arrays, then hard-truncate. */
export function jsonBlock(value: unknown, max: number = JSON_BLOCK_MAX_CHARS): string {
  let text = safeStringify(value);
  if (text.length <= max) return text;
  text = safeStringify(shrink(value, { dropHeavy: true, arrayCap: null }));
  if (text.length <= max) return text;
  text = safeStringify(shrink(value, { dropHeavy: true, arrayCap: ARRAY_CAP }));
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '{"error":"unserializable"}';
  }
}

const HEAVY_KEYS = new Set(['hunk', 'markdown']);

function shrink(value: unknown, opts: { dropHeavy: boolean; arrayCap: number | null }): unknown {
  if (Array.isArray(value)) {
    const items = opts.arrayCap !== null && value.length > opts.arrayCap ? value.slice(0, opts.arrayCap) : value;
    const out = items.map((v) => shrink(v, opts));
    if (items.length < value.length) out.push({ truncated: value.length - items.length });
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (opts.dropHeavy && HEAVY_KEYS.has(k) && typeof v === 'string' && v.length > 200) out[k] = `[${v.length} chars omitted]`;
      else out[k] = shrink(v, opts);
    }
    return out;
  }
  return value;
}

/** `(cached 09:41Z)` from the snapshot's hub clock (§9.1). */
export function cachedLabel(snapshot: Pick<CachedSnapshot, 'serverTime'> | null): string {
  return `(cached ${snapshot ? hhmm(snapshot.serverTime) : '??:??Z'})`;
}

/** Freshness object for a cache-served answer. */
export function cacheFreshness(snapshot: CachedSnapshot | null, breakerOpen: boolean, now: number = Date.now()): Freshness {
  const ageMs = snapshotAgeMs(snapshot, now);
  return { source: 'cache', at: snapshot?.serverTime ?? new Date(now).toISOString(), ...(ageMs !== null ? { ageMs } : {}), breakerOpen };
}

/** One factual line explaining why the hub answer is missing. */
export function hubFailureLine(result: HubResult<unknown> | null, snapshot: CachedSnapshot | null, now: number = Date.now()): string {
  const asOf = snapshot ? `cached snapshot as of ${shortTime(snapshot.serverTime)} (${humanAge(snapshotAgeMs(snapshot, now) ?? 0)} old)` : 'no cached snapshot';
  if (!result) return `Relay hub not configured (no team.json and no RELAY_HUB/RELAY_TOKEN); ${asOf}.`;
  if (result.ok) return '';
  switch (result.kind) {
    case 'timeout':
      return `Relay hub did not answer within ${result.ms} ms; ${asOf}.`;
    case 'breaker':
      return `Relay hub marked unreachable by an earlier failure (breaker open); ${asOf}.`;
    case 'config':
      return `Relay hub rejected the client (${result.status}: ${result.message}); ${asOf}.`;
    case 'unconfigured':
      return `Relay hub not configured; ${asOf}.`;
    case 'network':
      return `Relay hub unreachable (${result.message}); ${asOf}.`;
    case 'http':
      return `Relay hub answered ${result.status ?? 'error'} (${result.message}); ${asOf}.`;
    case 'parse':
      return `Relay hub answered with an unreadable body; ${asOf}.`;
  }
}

/** Honest failure for a write tool (§9.1): text + json, flagged as an error. */
export function writeFailure(tool: string, result: HubResult<unknown> | null): CallToolResult {
  const line = result === null ? `Relay ${tool} not sent: hub not configured (no team.json and no RELAY_HUB/RELAY_TOKEN).` : result.ok ? '' : `Relay ${tool} not sent: ${describeFailure(result)}.`;
  const json = result === null ? { error: 'unconfigured', message: 'hub not configured' } : result.ok ? {} : { error: result.kind, status: result.status, message: result.message, retryable: result.retryable };
  return toolResult(line, json, { isError: true });
}

function describeFailure(result: Extract<HubResult<unknown>, { ok: false }>): string {
  switch (result.kind) {
    case 'timeout':
      return `the hub did not answer within ${result.ms} ms`;
    case 'breaker':
      return 'the hub is marked unreachable (breaker open)';
    case 'config':
      return `the hub rejected the client (${result.status}: ${result.message})`;
    case 'unconfigured':
      return 'the hub is not configured';
    case 'network':
      return `the hub is unreachable (${result.message})`;
    case 'http':
      return `the hub answered ${result.status ?? 'error'} (${result.message})`;
    case 'parse':
      return 'the hub answered with an unreadable body';
  }
}

/** `key: value` pairs joined for a one-line summary; null/undefined/empty values are skipped. */
export function kv(pairs: Array<[string, string | number | null | undefined]>): string {
  return pairs
    .filter((p): p is [string, string | number] => p[1] !== null && p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}
