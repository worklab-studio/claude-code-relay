import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import {
  applySnapshot,
  freshnessOf,
  hubNowMs,
  isPidAlive,
  itemAgeMs,
  listCurrentFiles,
  makeCurrentFile,
  readAncestry,
  readDigest,
  readRepoState,
  readSnapshot,
  snapshotAgeMs,
  stalenessLabel,
  stalenessTier,
  statuslinePath,
  writeAncestry,
  writeCurrentFile,
  writeDigest,
  writeRepoState,
  writeSnapshot,
} from './cache.js';
import { createMark, ensureSessionDir, readPending } from './journal.js';
import { recordWorkerFailure } from './breaker.js';
import { STALENESS, type SnapshotChangeSet } from './protocol.js';
import { T0, iso, makeChangeSet, makeSnapshot } from '../test/fixtures.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function home(): string {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

const cs = (id: string, deps: string[]): SnapshotChangeSet => makeChangeSet(id, deps);

describe('snapshot cache', () => {
  it('writes atomically with fetchedAt and refuses an older serverTime', () => {
    const h = home();
    const r1 = writeSnapshot(h, 'k1', makeSnapshot(T0), { now: T0 + 500 });
    expect(r1).toEqual({ written: true, stale: false });
    const cached = readSnapshot(h, 'k1');
    expect(cached?.fetchedAt).toBe(iso(T0 + 500));
    expect(writeSnapshot(h, 'k1', makeSnapshot(T0 - 1000), { now: T0 + 900 })).toEqual({ written: false, stale: true });
    expect(readSnapshot(h, 'k1')?.serverTime).toBe(iso(T0));
    expect(writeSnapshot(h, 'k1', makeSnapshot(T0), { now: T0 + 1500 }).written).toBe(true); // equal serverTime is accepted
    expect(existsSync(statuslinePath(h, 'k1'))).toBe(true);
    expect(readFileSync(statuslinePath(h, 'k1'), 'utf8')).toMatch(/^relay ●/);
    expect(writeSnapshot(h, 'k1', { ...makeSnapshot(T0), serverTime: 'garbage' }).written).toBe(false);
  });

  it('computes ages as same-clock differences (rule 16)', () => {
    const snap = { ...makeSnapshot(T0), fetchedAt: iso(T0 + 2000) }; // laptop clock 2 s ahead of the hub
    expect(snapshotAgeMs(snap, T0 + 12_000)).toBe(10_000);
    // item stamped 60 s before serverTime, read 10 s after fetch -> 70 s old regardless of skew
    expect(itemAgeMs(snap, iso(T0 - 60_000), T0 + 12_000)).toBe(70_000);
    expect(hubNowMs(snap, T0 + 12_000)).toBe(T0 + 10_000);
    expect(itemAgeMs(snap, null)).toBeNull();
    expect(snapshotAgeMs(null)).toBeNull();
  });

  it('applies the staleness ladder', () => {
    expect(stalenessTier(0, false)).toBe('fresh');
    expect(stalenessTier(STALENESS.fullPolicyMs, false)).toBe('fresh');
    expect(stalenessTier(STALENESS.fullPolicyMs + 1, false)).toBe('degraded');
    expect(stalenessTier(STALENESS.degradedMs + 1, false)).toBe('stale');
    expect(stalenessTier(null, false)).toBe('stale');
    expect(stalenessTier(0, true)).toBe('offline');
    const snap = { ...makeSnapshot(T0), fetchedAt: iso(T0) };
    expect(stalenessLabel('fresh', snap, null)).toBeNull();
    expect(stalenessLabel('degraded', snap, null)).toBe('(presence as of 09:41Z)');
    expect(stalenessLabel('stale', snap, null)).toBe('(presence as of 09:41Z; not refreshed)');
    expect(stalenessLabel('offline', snap, T0 + 60_000)).toBe('(Relay hub unreachable since 09:42Z)');
    const h = home();
    writeSnapshot(h, 'k', makeSnapshot(T0), { now: Date.now() - 1000 });
    expect(freshnessOf(h, readSnapshot(h, 'k')).tier).toBe('fresh');
    recordWorkerFailure(h);
    recordWorkerFailure(h);
    const f = freshnessOf(h, readSnapshot(h, 'k'));
    expect(f.tier).toBe('offline');
    expect(f.label).toMatch(/^\(Relay hub unreachable since /);
  });

  it('derives pending from change sets without jit/seen marks', () => {
    const h = home();
    const dir = ensureSessionDir(h, 's1');
    createMark(dir, 'jit', 'cs_seen');
    const snap = makeSnapshot(T0, { changeSets: [cs('cs_new', ['apps/dashboard/src/invoices.tsx']), cs('cs_seen', ['x.ts']), cs('cs_nodeps', [])] });
    const r = applySnapshot(h, 'k', snap, { sessionId: 's1', now: T0 });
    expect(r.written).toBe(true);
    expect(r.pending).toEqual(['cs_new']);
    expect(readPending(dir)).toEqual(['cs_new']);
    // a stale write still recomputes pending from the newer cached copy
    const r2 = applySnapshot(h, 'k', makeSnapshot(T0 - 5000), { sessionId: 's1', now: T0 + 1 });
    expect(r2.stale).toBe(true);
    expect(r2.pending).toEqual(['cs_new']);
  });

  it('round-trips digest, ancestry and state', () => {
    const h = home();
    expect(readDigest(h, 'k')).toBeNull();
    writeDigest(h, 'k', '<relay-digest freshness="live">x</relay-digest>');
    expect(readDigest(h, 'k')?.digest).toContain('x');
    expect(readAncestry(h, 'k')).toBeNull();
    writeAncestry(h, 'k', { headSha: 'h', at: iso(T0), contains: { a: true }, merged: { cs_1: true } });
    expect(readAncestry(h, 'k')?.contains['a']).toBe(true);
    expect(readRepoState(h, 'k')).toEqual({ v: 1, lastReportedSha: {}, depindexHead: null, depindexAt: null });
    writeRepoState(h, 'k', { v: 1, lastReportedSha: { main: 'abc' }, depindexHead: 'abc', depindexAt: iso(T0) });
    expect(readRepoState(h, 'k').lastReportedSha['main']).toBe('abc');
  });

  it('manages current/<pid>.json and pid liveness', () => {
    const h = home();
    const f = makeCurrentFile({ home: h, pid: 4242, sessionId: 's', cwd: '/x', repoKey: 'k', dev: 'deepak', now: T0 });
    expect(writeCurrentFile(h, f)).toBe(true);
    const g = makeCurrentFile({ home: h, pid: 4343, sessionId: 's2', cwd: '/y', repoKey: 'k', dev: 'deepak', now: T0 + 1000 });
    writeCurrentFile(h, g);
    const list = listCurrentFiles(h);
    expect(list.map((c) => c.pid)).toEqual([4343, 4242]);
    expect(list[0]?.statusline).toBe(statuslinePath(h, 'k'));
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_147_483_000)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });
});
