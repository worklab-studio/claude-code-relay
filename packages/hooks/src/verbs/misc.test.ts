import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJournal, hasMark, listOutbox, loadFold, readMeta, readPending, sessionDir, writePending, writeSnapshot, type EventsRequest, type SessionEndRequest } from '@relay/core';
import { T0, iso, makeChangeSet, makeRepo, makeRuntime, makeSnapshot, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { runCwd } from './cwd.js';
import { runMute } from './mute.js';
import { runPreRead } from './pre-read.js';
import { runSessionEnd } from './session-end.js';
import { runTask } from './tasks.js';

const SID = 'sess-misc';

describe('pre-read / tasks / cwd / session-end', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = join(home, 'repo');
    mkdirSync(join(repo, 'apps/dashboard/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/dashboard/src/invoices.tsx'), 'x');
  });
  afterEach(() => cleanup());

  it('pre-read prints the JIT note only for a listed dependent while pending is non-empty, then rewrites pending', async () => {
    const meta = seedMeta(home, SID, repo);
    const dep = 'apps/dashboard/src/invoices.tsx';
    const snap = makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID }, changeSets: [makeChangeSet('cs_r1', [dep])] });
    writeSnapshot(home, meta.repoKey, snap, { now });
    const dir = sessionDir(home, SID);
    const { rt } = makeRuntime(home, 'pre-read', { now: () => now });
    expect(await runPreRead(rt, stdin.preRead(SID, repo, join(repo, dep)))).toBeNull(); // no pending file yet
    writePending(dir, ['cs_r1']);
    expect(await runPreRead(rt, stdin.preRead(SID, repo, join(repo, 'README.md')))).toBeNull(); // not a dependent
    const out = await runPreRead(rt, stdin.preRead(SID, repo, join(repo, dep)));
    const ctx = (out?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    expect(ctx).toContain('IMPACT cs_r1');
    expect(ctx).toContain('Dependents in your repo: apps/dashboard/src/invoices.tsx');
    expect(hasMark(dir, 'jit', 'cs_r1')).toBe(true);
    expect(readPending(dir)).toEqual([]); // rewritten from the marks
    expect(await runPreRead(rt, stdin.preRead(SID, repo, join(repo, dep)))).toBeNull();
  });

  it('task-created / task-completed journal lines drive the objective and queue task events', async () => {
    seedMeta(home, SID, repo);
    const { rt } = makeRuntime(home, 'task-created', { now: () => now });
    expect(await runTask(rt, stdin.task(SID, repo, 'TaskCreated', '1', 'Relay exp task'))).toBeNull();
    let fold = loadFold(sessionDir(home, SID));
    expect(fold.tasks.open).toEqual([{ id: '1', subject: 'Relay exp task', at: iso(now) }]);
    const entries = listOutbox(home).entries;
    expect(entries).toHaveLength(1);
    const body = entries[0]?.body as EventsRequest;
    expect(body.events[0]).toMatchObject({ type: 'task', taskId: '1', subject: 'Relay exp task', status: 'created' });
    expect(body.session.objective).toBe('Relay exp task');
    expect(body.session.objectiveSource).toBe('task');
    expect(entries[0]?.ephemeral).toBe(false);
    expect(await runTask(rt, stdin.task(SID, repo, 'TaskCompleted', '1', 'Relay exp task'))).toBeNull();
    fold = loadFold(sessionDir(home, SID));
    expect(fold.tasks.open).toEqual([]);
    expect(fold.tasks.done.map((t) => t.subject)).toEqual(['Relay exp task']);
    // unknown shape: silent
    expect(await runTask(rt, { session_id: SID, hook_event_name: 'TaskCreated', cwd: repo } as never)).toBeNull();
  });

  it('cwd inside the same repo is a no-op; leaving the repo heals meta, journals and re-appends env exports', async () => {
    const real = makeRepo(join(home, 'other'), { origin: 'https://github.com/acme/dashboard' });
    seedMeta(home, SID, repo);
    const envFile = join(home, 'env.sh');
    writeFileSync(envFile, '');
    const { rt } = makeRuntime(home, 'cwd', { now: () => now, env: { CLAUDE_ENV_FILE: envFile } });
    expect(await runCwd(rt, stdin.cwd(SID, repo, join(repo, 'apps')))).toBeNull();
    expect(readMeta(sessionDir(home, SID))?.repo).toBe('github.com/acme/app');
    expect(listOutbox(home).entries).toHaveLength(0);
    expect(readFileSync(envFile, 'utf8')).toContain("export RELAY_DEV='deepak'");
    expect(await runCwd(rt, stdin.cwd(SID, repo, real))).toBeNull();
    const meta = readMeta(sessionDir(home, SID))!;
    expect(meta.repo).toBe('github.com/acme/dashboard');
    expect(meta.repoRoot).toBe(real);
    expect(meta.branch).toBe('main');
    const fold = loadFold(sessionDir(home, SID));
    expect(fold.foldedLines).toBe(1);
    const body = listOutbox(home).entries[0]?.body as EventsRequest;
    expect(body.events[0]).toMatchObject({ type: 'cwd', from: repo, to: real, repo: 'github.com/acme/dashboard' });
    expect(body.session.repo).toBe('github.com/acme/dashboard');
  });

  it('session-end: end line, ended mark, WAL entry from the fold, detached worker spawn, no git/fetch', async () => {
    seedMeta(home, SID, repo);
    const dir = sessionDir(home, SID);
    appendJournal(dir, { t: 'edit', at: iso(now - 5000), path: 'apps/dashboard/src/invoices.tsx', tool: 'Edit', toolUseId: null });
    appendJournal(dir, { t: 'edit', at: iso(now - 4000), path: 'apps/dashboard/src/invoices.tsx', tool: 'Edit', toolUseId: null });
    appendJournal(dir, { t: 'commit', at: iso(now - 3000), sha: 'c'.repeat(40), subject: 'dashboard: table', files: ['apps/dashboard/src/invoices.tsx'], contracts: [], pushed: true });
    const { rt, ff, spawned } = makeRuntime(home, 'session-end', { now: () => now, git: { gitHead: async () => { throw new Error('git must not run'); } } });
    const started = Date.now();
    expect(await runSessionEnd(rt, stdin.sessionEnd(SID, repo, 'prompt_input_exit'))).toBeNull();
    expect(Date.now() - started).toBeLessThan(300);
    expect(ff.calls).toHaveLength(0);
    expect(hasMark(dir, 'ended')).toBe(true);
    expect(loadFold(dir).ended).toEqual({ at: iso(now), reason: 'prompt_input_exit' });
    const entries = listOutbox(home).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'session_end', endpoint: '/v1/session/end', sessionId: SID, ephemeral: false });
    const body = entries[0]?.body as SessionEndRequest;
    expect(body).toMatchObject({ sessionId: SID, reason: 'prompt_input_exit', at: iso(now), draft: null });
    expect(body.files).toEqual([{ path: 'apps/dashboard/src/invoices.tsx', area: 'apps/dashboard', edits: 2 }]);
    expect(body.commits).toEqual([{ sha: 'c'.repeat(40), subject: 'dashboard: table', pushed: true }]);
    expect(spawned).toEqual([{ job: 'session-end', args: ['--entry', entries[0]!.id, '--session', SID, '--cwd', repo] }]);
  });

  it('mute: adds, lists and removes per-machine mutes for the repo found from cwd', async () => {
    const real = makeRepo(join(home, 'muted'), { origin: 'git@github.com:acme/app.git' });
    const a = makeRuntime(home, 'mute', { args: ['@priya'] });
    expect(await runMute(a.rt, real)).toMatch(/^Relay: muted @priya \(dev\) for github\.com\/acme\/app on this machine/);
    const b = makeRuntime(home, 'mute', { args: ['packages/contracts/**'] });
    expect(await runMute(b.rt, real)).toContain('(glob)');
    const c = makeRuntime(home, 'mute', { args: [] });
    expect(await runMute(c.rt, real)).toBe('Relay mutes for github.com/acme/app: @priya (dev), packages/contracts/** (glob)');
    const d = makeRuntime(home, 'mute', { args: ['@priya', '--undo'] });
    expect(await runMute(d.rt, real)).toContain('unmuted @priya');
    expect(await runMute(makeRuntime(home, 'mute', { args: [] }).rt, real)).toBe('Relay mutes for github.com/acme/app: packages/contracts/** (glob)');
  });
});
