import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { breakerOpen, readBreaker, recordConfigError, recordSuccess, recordWorkerFailure, refreshWantedAgeMs, shouldSpawnRefresh, writeRefreshWanted } from './breaker.js';
import { BREAKER, LOCAL_PATHS } from './protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function home(): string {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

describe('breaker', () => {
  it('opens after two consecutive worker failures for 60 s and resets on success', () => {
    const h = home();
    const now = Date.parse('2026-09-12T10:00:00Z');
    expect(readBreaker(h, now).open).toBe(false);
    expect(recordWorkerFailure(h, now).open).toBe(false);
    const s = recordWorkerFailure(h, now);
    expect(s.open).toBe(true);
    expect(s.count).toBe(2);
    expect(s.untilMs).toBe(now + BREAKER.openMs);
    expect(breakerOpen(h, now + BREAKER.openMs - 1)).toBe(true);
    expect(breakerOpen(h, now + BREAKER.openMs + 1)).toBe(false);
    recordSuccess(h);
    expect(readBreaker(h, now)).toMatchObject({ open: false, count: 0, configError: null });
  });

  it('treats 401/426/413 as a 10-minute configuration breaker with a config-error file', () => {
    const h = home();
    const now = Date.parse('2026-09-12T10:00:00Z');
    const s = recordConfigError(h, 401, 'bad token', now);
    expect(s.open).toBe(true);
    expect(s.untilMs).toBe(now + BREAKER.configErrorMs);
    expect(s.configError).toMatchObject({ status: 401, message: 'bad token' });
    expect(existsSync(join(h, LOCAL_PATHS.configError))).toBe(true);
    expect(breakerOpen(h, now + BREAKER.configErrorMs + 1)).toBe(false);
    recordSuccess(h);
    expect(existsSync(join(h, LOCAL_PATHS.configError))).toBe(false);
  });

  it('ignores garbage files', () => {
    const h = home();
    writeRefreshWanted(h);
    expect(refreshWantedAgeMs(h)).toBeLessThan(5000);
    expect(readBreaker(h).open).toBe(false);
  });

  it('decides pre-edit refresh spawning', () => {
    const h = home();
    expect(shouldSpawnRefresh(h, 10_000)).toBe(false); // cache fresh
    expect(shouldSpawnRefresh(h, null)).toBe(true); // no cache
    expect(shouldSpawnRefresh(h, BREAKER.preEditRefreshMs + 1)).toBe(true);
    writeRefreshWanted(h);
    expect(shouldSpawnRefresh(h, BREAKER.preEditRefreshMs + 1)).toBe(false); // debounced
    expect(shouldSpawnRefresh(h, BREAKER.preEditRefreshMs + 1, Date.now() + BREAKER.refreshWantedDebounceMs + 1)).toBe(true);
    recordWorkerFailure(h);
    recordWorkerFailure(h);
    expect(shouldSpawnRefresh(h, null)).toBe(false); // breaker open
  });
});
