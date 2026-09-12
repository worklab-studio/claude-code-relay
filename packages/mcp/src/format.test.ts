import { describe, expect, it } from 'vitest';
import { parseResult } from '../test/harness.js';
import { cachedLabel, hubFailureLine, jsonBlock, toolResult, writeFailure } from './format.js';

describe('toolResult (§9.2 text + json block)', () => {
  it('renders text then one fenced json block that parses back', () => {
    const r = parseResult(toolResult('Relay status at 09:41:07Z (live): ok', { a: 1, b: [1, 2] }));
    expect(r.head).toBe('Relay status at 09:41:07Z (live): ok');
    expect(r.json).toEqual({ a: 1, b: [1, 2] });
    expect(r.isError).toBe(false);
    expect(parseResult(toolResult('x', {}, { isError: true })).isError).toBe(true);
  });
});

describe('jsonBlock shrinking', () => {
  it('keeps small payloads verbatim', () => {
    expect(jsonBlock({ hunk: 'x'.repeat(300) }, 10_000)).toBe(JSON.stringify({ hunk: 'x'.repeat(300) }));
  });
  it('drops hunk/markdown bodies first, then cuts arrays, then hard-truncates', () => {
    const big = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, hunk: 'h'.repeat(500), note: 'n' })) };
    const stage1 = jsonBlock(big, 20_000);
    expect(stage1).toContain('[500 chars omitted]');
    expect(stage1.length).toBeLessThanOrEqual(20_000);
    const parsed1 = JSON.parse(stage1) as { items: unknown[] };
    expect(parsed1.items).toHaveLength(100);
    const stage2 = jsonBlock(big, 3_000);
    const parsed2 = JSON.parse(stage2) as { items: Array<{ truncated?: number }> };
    expect(parsed2.items).toHaveLength(26);
    expect(parsed2.items[25]).toEqual({ truncated: 75 });
    const stage3 = jsonBlock(big, 200);
    expect(stage3.length).toBe(200);
    expect(stage3.endsWith('…')).toBe(true);
  });
});

describe('labels and failure lines', () => {
  const snap = { serverTime: '2026-09-12T09:41:07.000Z', fetchedAt: '2026-09-12T09:41:10.000Z' };
  it('cachedLabel uses the hub clock', () => {
    expect(cachedLabel(snap)).toBe('(cached 09:41Z)');
    expect(cachedLabel(null)).toBe('(cached ??:??Z)');
  });
  it('hubFailureLine names the failure kind and the cache age', () => {
    const now = Date.parse('2026-09-12T09:53:10Z');
    const s = { ...snap } as never;
    expect(hubFailureLine({ ok: false, status: null, kind: 'timeout', message: 't', ms: 5000, retryable: true }, s, now)).toBe('Relay hub did not answer within 5000 ms; cached snapshot as of 09:41:07Z (12m old).');
    expect(hubFailureLine({ ok: false, status: null, kind: 'breaker', message: 'b', ms: 0, retryable: true }, null, now)).toContain('breaker open); no cached snapshot.');
    expect(hubFailureLine({ ok: false, status: 401, kind: 'config', message: 'bad token', ms: 3, retryable: false }, null, now)).toContain('401: bad token');
    expect(hubFailureLine(null, null, now)).toContain('not configured');
  });
  it('writeFailure is an error result with the reason in text and json', () => {
    const r = parseResult(writeFailure('notify', { ok: false, status: 503, kind: 'http', message: 'HTTP 503', ms: 4, retryable: true }));
    expect(r.isError).toBe(true);
    expect(r.head).toBe('Relay notify not sent: the hub answered 503 (HTTP 503).');
    expect(r.json).toEqual({ error: 'http', status: 503, message: 'HTTP 503', retryable: true });
    expect(parseResult(writeFailure('claim', null)).head).toContain('hub not configured');
  });
});
