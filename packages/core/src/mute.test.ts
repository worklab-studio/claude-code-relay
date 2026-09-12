import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { addMute, muteKind, readMutes, removeMute } from './mute.js';
import { acquireBgLock } from './journal.js';
import { appendStats, debugLog, hookCounts, readStats } from './log.js';
import { existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function home(): string {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

describe('mutes', () => {
  it('infers kinds and round-trips add/remove', () => {
    const areas = { contracts: { paths: ['packages/contracts/**'] } };
    expect(muteKind('@priya')).toBe('dev');
    expect(muteKind('contracts', areas)).toBe('area');
    expect(muteKind('apps/**/*.tsx')).toBe('glob');
    expect(muteKind('apps/app/src/a.ts')).toBe('path');
    const h = home();
    expect(readMutes(h, 'k')).toEqual([]);
    addMute(h, 'k', '@priya');
    const list = addMute(h, 'k', 'contracts', areas);
    expect(list.map((m) => [m.target, m.kind])).toEqual([['@priya', 'dev'], ['contracts', 'area']]);
    expect(readMutes(h, 'k')).toHaveLength(2);
    expect(removeMute(h, 'k', '@priya').map((m) => m.target)).toEqual(['contracts']);
    addMute(h, 'k', 'contracts', areas); // idempotent
    expect(readMutes(h, 'k')).toHaveLength(1);
  });
});

describe('bg lock', () => {
  it('is single-flight per (job, repoKey) and recovers stale locks', () => {
    const h = home();
    const release = acquireBgLock(h, 'prompt', 'k');
    expect(release).not.toBeNull();
    expect(acquireBgLock(h, 'prompt', 'k')).toBeNull();
    expect(acquireBgLock(h, 'refresh', 'k')).not.toBeNull();
    release!();
    expect(acquireBgLock(h, 'prompt', 'k')).not.toBeNull();
    const stale = join(h, 'bg', 'session-start.k.lock');
    mkdirSync(stale, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(stale, old, old);
    expect(acquireBgLock(h, 'session-start', 'k')).not.toBeNull();
  });
});

describe('log and stats', () => {
  it('writes debug lines only when enabled and counts hooks per event', () => {
    const h = home();
    debugLog(h, false, 'prompt', 'nope');
    expect(existsSync(join(h, 'log', 'relay.log'))).toBe(false);
    debugLog(h, true, 'prompt', 'hello');
    expect(existsSync(join(h, 'log', 'relay.log'))).toBe(true);
    const now = Date.now();
    appendStats(h, { at: new Date(now).toISOString(), event: 'PreToolUse', verb: 'pre-edit', ms: 60, out: 'ask', sessionId: 's1' });
    appendStats(h, { at: new Date(now).toISOString(), event: 'PreToolUse', verb: 'pre-edit', ms: 50, out: 'none', sessionId: 's2' });
    appendStats(h, { at: new Date(now - 2 * 86_400_000).toISOString(), event: 'Stop', verb: 'stop', ms: 5, out: 'none' });
    expect(readStats(h)).toHaveLength(3);
    expect(hookCounts(h, { now })).toEqual({ PreToolUse: 2 });
    expect(hookCounts(h, { now, sessionId: 's1' })).toEqual({ PreToolUse: 1 });
    expect(hookCounts(h, { now, sinceMs: 3 * 86_400_000 })).toEqual({ PreToolUse: 2, Stop: 1 });
  });
});
