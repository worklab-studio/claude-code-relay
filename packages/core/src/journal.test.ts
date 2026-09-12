import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import {
  appendJournal,
  createMark,
  emptyFold,
  ensureSessionDir,
  foldEntries,
  hasMark,
  listMarks,
  loadFold,
  markAgeMs,
  markKey,
  promoteAskedToSnooze,
  readAskedMark,
  readJournalEntries,
  readMeta,
  readPending,
  rotateJournalIfLarge,
  serializeJournalEntry,
  sessionDir,
  setMark,
  snoozeUntil,
  withSessionLock,
  writeDraft,
  readDraft,
  writeMeta,
  writePending,
} from './journal.js';
import { LIMITS, SESSION_FILES, type JournalEntry, type SessionMeta } from './protocol.js';

const execFileP = promisify(execFile);
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function home(): string {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

const at = (s: number): string => new Date(Date.parse('2026-09-12T10:00:00Z') + s * 1000).toISOString();

describe('events.jsonl', () => {
  it('appends lines that fold correctly and skips partial lines', () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid1');
    const entries: JournalEntry[] = [
      { t: 'prompt', at: at(0), promptId: 'p1', len: 40, sha1: 'x' },
      { t: 'objective', at: at(1), objective: 'Add currency to invoices', source: 'prompt' },
      { t: 'edit', at: at(2), path: 'packages/contracts/src/billing.ts', tool: 'Edit', toolUseId: 't1' },
      { t: 'edit', at: at(3), path: 'apps/app/src/a.ts', tool: 'Write', toolUseId: 't2' },
      { t: 'edit', at: at(4), path: 'packages/contracts/src/billing.ts', tool: 'Edit', toolUseId: 't3' },
      { t: 'contract', at: at(5), path: 'packages/contracts/src/billing.ts', hash: 'h1', blobId: 'b1', symbols: ['Invoice'], kinds: ['export'], eventId: 'e1' },
      { t: 'task', at: at(6), id: '1', subject: 'Wire FX', status: 'created' },
      { t: 'turn', at: at(7), promptId: 'p1', text: 'Done. Should I also update the dashboard?' },
      { t: 'commit', at: at(8), sha: 'a'.repeat(40), subject: 'contracts: currency', files: ['packages/contracts/src/billing.ts'], contracts: ['packages/contracts/src/billing.ts'] },
      { t: 'task', at: at(9), id: '1', subject: 'Wire FX', status: 'completed' },
      { t: 'end', at: at(10), reason: 'other' },
    ];
    for (const e of entries) expect(appendJournal(dir, e)).toBe(true);
    // a partial line from a concurrent writer
    writeFileSync(join(dir, SESSION_FILES.events), '{"t":"edit","at":"2026', { flag: 'a' });
    expect(readJournalEntries(dir)).toHaveLength(entries.length);
    const f = loadFold(dir);
    expect(f.foldedLines).toBe(entries.length);
    expect(f.edits['packages/contracts/src/billing.ts']).toMatchObject({ count: 2, firstAt: at(2), lastAt: at(4) });
    expect(f.recentPaths).toEqual(['packages/contracts/src/billing.ts', 'apps/app/src/a.ts']);
    expect(f.objective).toMatchObject({ text: 'Add currency to invoices', source: 'prompt', toolCallsSince: 3 });
    expect(f.objective.trail).toHaveLength(1);
    expect(f.contracts['packages/contracts/src/billing.ts']?.hash).toBe('h1');
    expect(f.tasks.open).toEqual([]);
    expect(f.tasks.done).toHaveLength(1);
    expect(f.turns).toHaveLength(1);
    expect(f.lastTurnWasQuestion).toBe(true);
    expect(f.commits).toHaveLength(1);
    expect(f.prompts).toEqual({ count: 1, lastAt: at(0), lastPromptId: 'p1' });
    expect(f.ended).toEqual({ at: at(10), reason: 'other' });
  });

  it('caps lines at 4 KB by trimming text', () => {
    const line = serializeJournalEntry({ t: 'turn', at: at(0), promptId: 'p', text: 'x'.repeat(10_000) });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(LIMITS.journalLineBytes);
    expect(JSON.parse(line).t).toBe('turn');
  });

  it('keeps the trail to 5, turns to 12 and upserts turns by promptId', () => {
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 8; i++) entries.push({ t: 'objective', at: at(i), objective: `o${i}`, source: 'prompt' });
    for (let i = 0; i < 15; i++) entries.push({ t: 'turn', at: at(100 + i), promptId: `p${i}`, text: `t${i}` });
    entries.push({ t: 'turn', at: at(200), promptId: 'p14', text: 'rewritten' });
    const f = foldEntries(entries);
    expect(f.objective.trail.map((o) => o.objective)).toEqual(['o7', 'o6', 'o5', 'o4', 'o3']);
    expect(f.turns).toHaveLength(12);
    expect(f.turns[f.turns.length - 1]?.text).toBe('rewritten');
  });

  it('rotates a large journal into fold.json under the lock', async () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid2');
    for (let i = 0; i < 40; i++) appendJournal(dir, { t: 'edit', at: at(i), path: `p${i}.ts`, tool: 'Edit', toolUseId: null });
    expect(await rotateJournalIfLarge(dir, 1024)).toBe(true);
    expect(existsSync(join(dir, SESSION_FILES.events))).toBe(false);
    appendJournal(dir, { t: 'edit', at: at(99), path: 'late.ts', tool: 'Edit', toolUseId: null });
    const f = loadFold(dir);
    expect(f.foldedLines).toBe(41);
    expect(Object.keys(f.edits)).toHaveLength(41);
    expect(f.recentPaths[0]).toBe('late.ts');
    expect(await rotateJournalIfLarge(dir, 1024)).toBe(false);
  });
});

describe('marks', () => {
  it('creates once, reports exists, reads content and ages', () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid3');
    const key = markKey('apps/app/a.ts', 'priya');
    expect(createMark(dir, 'asked', key, JSON.stringify({ toolUseId: 't', at: at(0), path: 'apps/app/a.ts', dev: 'priya' }))).toBe('created');
    expect(createMark(dir, 'asked', key)).toBe('exists');
    expect(hasMark(dir, 'asked', key)).toBe(true);
    expect(readAskedMark(dir, key)?.dev).toBe('priya');
    expect(markAgeMs(dir, 'asked', key)).toBeLessThan(5000);
    expect(markAgeMs(dir, 'asked', 'nope')).toBeNull();
    expect(createMark(dir, 'ended')).toBe('created');
    expect(listMarks(dir, 'asked')).toEqual([key]);
    // marks dir missing -> recreated on demand
    const dir2 = sessionDir(h, 'sid4');
    expect(createMark(dir2, 'seen', 'n1')).toBe('created');
  });

  it('turns asked into a 30-min snooze on the landing edit', () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid5');
    const key = markKey('a.ts', 'priya');
    const now = Date.parse('2026-09-12T10:00:00Z');
    expect(promoteAskedToSnooze(dir, key, now)).toBe(false);
    createMark(dir, 'asked', key, '{}');
    expect(promoteAskedToSnooze(dir, key, now)).toBe(true);
    expect(hasMark(dir, 'asked', key)).toBe(false);
    expect(snoozeUntil(dir, key, now)).toBe(now + 1_800_000);
    expect(snoozeUntil(dir, key, now + 1_800_001)).toBeNull();
    setMark(dir, 'snooze', key, 'garbage');
    expect(snoozeUntil(dir, key, now)).toBeNull();
  });

  it('exactly one of many parallel in-process callers wins', async () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid6');
    const results = await Promise.all(Array.from({ length: 16 }, () => Promise.resolve().then(() => createMark(dir, 'jit', 'cs_1'))));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'exists')).toHaveLength(15);
  });

  it('exactly one of several parallel processes wins each key', async () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid7');
    const tsx = resolve(process.cwd(), '../../node_modules/.bin/tsx');
    const worker = resolve(process.cwd(), 'test/mark-race-worker.ts');
    if (!existsSync(tsx)) return; // toolchain not present; the in-process test above still covers the logic
    const n = 6;
    const outs = await Promise.all(
      Array.from({ length: n }, () => execFileP(tsx, [worker, dir, 'jit', 'cs'], { timeout: 20_000 }).then((r) => JSON.parse(r.stdout) as string[])),
    );
    for (let i = 0; i < 20; i++) {
      const wins = outs.filter((o) => o[i] === 'created').length;
      expect(wins, `key ${i}`).toBe(1);
      expect(outs.filter((o) => o[i] === 'exists').length).toBe(n - 1);
    }
  }, 30_000);
});

describe('lock', () => {
  it('serializes holders and proceeds lock-free after the give-up', async () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid8');
    const order: string[] = [];
    const a = withSessionLock(dir, async ({ locked }) => {
      expect(locked).toBe(true);
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 120));
      order.push('a-end');
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = withSessionLock(dir, async ({ locked }) => {
      expect(locked).toBe(true);
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(existsSync(join(dir, SESSION_FILES.lockDir))).toBe(false);
    // held too long -> give up and run lock-free
    mkdirSync(join(dir, SESSION_FILES.lockDir));
    const started = Date.now();
    const r = await withSessionLock(dir, ({ locked }) => locked, { giveUpMs: 150 });
    expect(r).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('recovers a stale lock', async () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid9');
    const lock = join(dir, SESSION_FILES.lockDir);
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const r = await withSessionLock(dir, ({ locked }) => locked, { staleMs: 10_000 });
    expect(r).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('meta, pending, draft', () => {
  it('round-trips meta and rejects malformed files', () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid10');
    const meta: SessionMeta = {
      v: 1, sessionId: 'sid10', dev: 'deepak', identitySource: 'env', repo: 'local/x', project: 'x', repoKey: 'k', repoRoot: '/r', cwd: '/r', branch: 'main', worktree: null,
      startSha: null, lastStopSha: null, lastStopAt: null, client: 'cli', host: 'mac', pid: 1, startedAt: at(0), source: 'startup', gitEmail: null, gitEmails: [], configHash: null, model: null, pluginSha: null,
    };
    expect(writeMeta(dir, meta)).toBe(true);
    expect(readMeta(dir)).toEqual(meta);
    writeFileSync(join(dir, SESSION_FILES.meta), '{"v":1}');
    expect(readMeta(dir)).toBeNull();
  });

  it('pending is deleted when empty and deduped otherwise', () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid11');
    expect(writePending(dir, ['cs_1', 'cs_2', 'cs_1'])).toBe(true);
    expect(readPending(dir)).toEqual(['cs_1', 'cs_2']);
    expect(statSync(join(dir, SESSION_FILES.pending)).size).toBeGreaterThan(0);
    writePending(dir, []);
    expect(existsSync(join(dir, SESSION_FILES.pending))).toBe(false);
    expect(readPending(dir)).toEqual([]);
  });

  it('draft round-trips and stays under 8 KB', () => {
    const h = home();
    const dir = ensureSessionDir(h, 'sid12');
    const draft = { ...emptyDraft(), changed: Array.from({ length: 500 }, (_, i) => ({ path: `p${i}.ts`, area: null, edits: 1 })) };
    expect(writeDraft(dir, draft)).toBe(true);
    expect(readFileSync(join(dir, SESSION_FILES.draft)).length).toBeLessThanOrEqual(LIMITS.draftBytes + 512);
    expect(readDraft(dir)?.quality).toBe('heuristic');
  });
});

function emptyDraft() {
  return {
    at: at(0), quality: 'heuristic' as const, objective: null, areas: [], done: [], changed: [], interfaces_changed: [], decisions: [], blockers: [], next: [], commits: [], notes_to: [],
  };
}

// keep emptyFold referenced for the type import above
void emptyFold;
