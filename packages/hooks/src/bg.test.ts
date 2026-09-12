import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJournal,
  hasMark,
  listOutbox,
  loadFold,
  makeCurrentFile,
  readAncestry,
  readBreaker,
  readRepoState,
  readSnapshot,
  refreshWantedAgeMs,
  sessionDir,
  writeCurrentFile,
  writeOutbox,
  writeRefreshWanted,
  writeSnapshot,
  type CommitEvent,
  type DepIndex,
  type EventsRequest,
  type SessionEndRequest,
} from '@relay/core';
import { T0, git, iso, makeChangeSet, makeRepo, makeRuntime, makeSnapshot, seedMeta, tmpDir } from '../test/helpers.js';
import { runBg } from './bg.js';

const SID = 'sess-bg';

describe('bg worker', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'), { email: 'deepak@acme.dev', name: 'Deepak' });
  });
  afterEach(() => cleanup());

  it('bg prompt: posts the WAL entry with dirty paths, drains old entries oldest first, stops at the first transient failure', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const meta = seedMeta(home, SID, repo, { branch: 'main', startSha: head });
    writeFileSync(join(repo, 'apps/app/src/service.ts'), 'changed\n');
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lock\n'); // generated: excluded from dirty
    const presence = { id: SID, repo: meta.repo, branch: 'main', worktree: null, area: 'app', objective: 'x', objectiveSource: 'prompt' as const };
    const entry = writeOutbox(home, { sessionId: SID, kind: 'events', endpoint: '/v1/events', body: { session: presence, events: [{ id: 'ev1', at: iso(T0), type: 'prompt', promptId: 'p1', objective: 'x', objectiveSource: 'prompt', dirty: [], branch: 'main' }] } })!;
    // two old entries: the first succeeds, the second fails transiently, the third must stay untouched
    const old1 = writeOutbox(home, { sessionId: SID, kind: 'events', endpoint: '/v1/events', body: { session: presence, events: [] }, now: T0 - 120_000, at: iso(T0 - 120_000) })!;
    const old2 = writeOutbox(home, { sessionId: SID, kind: 'events', endpoint: '/v1/events', body: { session: presence, events: [] }, now: T0 - 110_000, at: iso(T0 - 110_000) })!;
    const old3 = writeOutbox(home, { sessionId: SID, kind: 'events', endpoint: '/v1/events', body: { session: presence, events: [] }, now: T0 - 100_000, at: iso(T0 - 100_000) })!;
    let n = 0;
    const { rt, ff } = makeRuntime(home, 'bg', {
      args: ['prompt', '--session', SID, '--cwd', repo, '--entry', entry.id],
      now: () => T0,
      handle: (call) => {
        if (call.path !== '/v1/events') return { status: 200, body: {} };
        n += 1;
        return n === 3 ? { status: 503, body: { error: 'down' } } : { status: 200, body: { snapshot: makeSnapshot(T0, { me: { dev: 'deepak', sessionId: SID } }), inbox: [] } };
      },
    });
    await runBg(rt);
    const first = ff.calls[0]!;
    expect(first.path).toBe('/v1/events');
    const body = first.body as EventsRequest;
    expect(body.replay).toBeUndefined();
    expect(body.events[0]).toMatchObject({ type: 'prompt', dirty: ['apps/app/src/service.ts'], branch: 'main' });
    expect(body.session.branch).toBe('main');
    const drained = ff.calls.filter((c) => c.path === '/v1/events').slice(1);
    expect(drained.map((c) => (c.body as EventsRequest).replay)).toEqual([true, true]);
    const remaining = listOutbox(home).entries.map((e) => e.id);
    expect(remaining).toEqual([old2.id, old3.id]); // entry sent, old1 sent, old2 failed (kept), old3 untouched
    expect(remaining).not.toContain(old1.id);
    expect(readSnapshot(home, meta.repoKey)?.serverTime).toBe(iso(T0));
    expect(readBreaker(home).count).toBe(1);
  });

  it('bg refresh: fetches the snapshot, clears refresh-wanted, sweeps dead sessions and posts crash ends', async () => {
    const meta = seedMeta(home, SID, repo, { branch: 'main' });
    writeRefreshWanted(home);
    // a dead session: pid 2147483000 is not alive; the live one is our own pid
    const deadDir = sessionDir(home, 'sess-dead');
    seedMeta(home, 'sess-dead', repo, { branch: 'main' });
    appendJournal(deadDir, { t: 'edit', at: iso(T0), path: 'apps/app/src/service.ts', tool: 'Edit', toolUseId: null });
    writeCurrentFile(home, makeCurrentFile({ home, pid: 2147483000, sessionId: 'sess-dead', cwd: repo, repoKey: meta.repoKey, dev: 'deepak' }));
    writeCurrentFile(home, makeCurrentFile({ home, pid: process.pid, sessionId: SID, cwd: repo, repoKey: meta.repoKey, dev: 'deepak' }));
    const { rt, ff } = makeRuntime(home, 'bg', {
      args: ['refresh', '--session', SID, '--cwd', repo],
      handle: (call) => (call.path.startsWith('/v1/snapshot') ? { status: 200, body: makeSnapshot(T0, { me: { dev: 'deepak', sessionId: SID } }) } : { status: 200, body: { ok: true } }),
    });
    await runBg(rt);
    expect(ff.calls[0]?.path).toBe('/v1/snapshot?repo=github.com%2Facme%2Fapp');
    expect(refreshWantedAgeMs(home)).toBeNull();
    const end = ff.calls.find((c) => c.path === '/v1/session/end');
    expect(end).toBeDefined();
    const body = end?.body as SessionEndRequest;
    expect(body).toMatchObject({ sessionId: 'sess-dead', reason: 'crash' });
    expect(body.files).toEqual([{ path: 'apps/app/src/service.ts', area: 'apps/app', edits: 1 }]);
    expect(end?.headers['x-relay-session']).toBe('sess-dead');
    expect(hasMark(deadDir, 'ended')).toBe(true);
    expect(loadFold(deadDir).ended?.reason).toBe('crash');
    const { listCurrentFiles } = await import('@relay/core');
    expect(listCurrentFiles(home).map((f) => f.sessionId)).toEqual([SID]);
    // idempotent: a second sweep does not end it again
    const again = makeRuntime(home, 'bg', { args: ['refresh', '--session', SID, '--cwd', repo], handle: () => ({ status: 200, body: makeSnapshot(T0) }) });
    await runBg(again.rt);
    expect(again.ff.calls.filter((c) => c.path === '/v1/session/end')).toHaveLength(0);
  });

  it('bg session-start: presence post, author-filtered commit backfill, depindex upload, ancestry + auto-ack, single-flight lock', async () => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    const meta = seedMeta(home, SID, repo, { branch: 'main', startSha: head0, gitEmails: ['deepak@acme.dev'] });
    // one own commit and one foreign commit made outside Claude
    writeFileSync(join(repo, 'packages/contracts/src/billing.ts'), 'export interface Invoice {\n  id: string\n  amountDue: number\n}\n');
    git(repo, 'commit', '-qam', 'contracts: amountDue');
    const own = git(repo, 'rev-parse', 'HEAD');
    git(repo, '-c', 'user.email=priya@acme.dev', '-c', 'user.name=Priya', 'commit', '-q', '--allow-empty', '-m', 'priya: pulled');
    // a change set whose commit is an ancestor of HEAD -> merged -> auto-ack
    const cs = makeChangeSet('cs_merged', ['apps/dashboard/src/invoices.tsx'], { impacts: [{ id: 'imp_m', rev: 1, path: 'packages/contracts/src/billing.ts', symbols: ['Invoice'], summary: 's', hunk: null, blobId: null, commitSha: own, status: 'committed' }] });
    writeSnapshot(home, meta.repoKey, makeSnapshot(T0, { me: { dev: 'deepak', sessionId: SID }, changeSets: [cs] }), { now: T0 });

    const { rt, ff } = makeRuntime(home, 'bg', {
      args: ['session-start', '--session', SID, '--cwd', repo],
      handle: (call) => (call.path === '/v1/events' ? { status: 200, body: { snapshot: makeSnapshot(T0, { me: { dev: 'deepak', sessionId: SID }, changeSets: [cs] }), inbox: [] } } : { status: 200, body: { ok: true } }),
    });
    await runBg(rt);
    const paths = ff.calls.map((c) => c.path);
    expect(paths[0]).toBe('/v1/events'); // presence-only
    expect((ff.calls[0]?.body as EventsRequest).events).toEqual([]);
    const commitPost = ff.calls.find((c) => c.path === '/v1/events' && (c.body as EventsRequest).events.some((e) => e.type === 'commit'));
    const commits = (commitPost?.body as EventsRequest).events.filter((e): e is CommitEvent => e.type === 'commit');
    expect(commits.map((c) => c.sha)).toEqual([own]); // priya's commit is never reported
    expect(commits[0]?.contracts[0]?.path).toBe('packages/contracts/src/billing.ts');
    expect(readRepoState(home, meta.repoKey).lastReportedSha['main']).toBe(git(repo, 'rev-parse', 'HEAD'));
    const dep = ff.calls.find((c) => c.path === '/v1/depindex');
    expect(dep).toBeDefined();
    const idx = dep?.body as DepIndex;
    expect(idx.repo).toBe('github.com/acme/app');
    expect(idx.imports['@acme/contracts']).toEqual(['apps/app/src/service.ts']);
    expect(readRepoState(home, meta.repoKey).depindexHead).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(readAncestry(home, meta.repoKey)?.merged['cs_merged']).toBe(true);
    expect(ff.calls.find((c) => c.path === '/v1/ack')?.body).toEqual({ id: 'cs_merged', auto: true });

    // second worker in the same repo while the lock is held: skipped
    const { acquireBgLock } = await import('@relay/core');
    const release = acquireBgLock(home, 'session-start', meta.repoKey)!;
    const other = makeRuntime(home, 'bg', { args: ['session-start', '--session', SID, '--cwd', repo] });
    await runBg(other.rt);
    expect(other.ff.calls).toHaveLength(0);
    release();
  });

  it('bg session-end: posts the entry with a 5 s budget and deletes it on 2xx; a 401 discards it', async () => {
    seedMeta(home, SID, repo, { branch: 'main' });
    const body: SessionEndRequest = { sessionId: SID, reason: 'other', at: iso(T0), files: [], commits: [], draft: null };
    const e1 = writeOutbox(home, { sessionId: SID, kind: 'session_end', endpoint: '/v1/session/end', body })!;
    const a = makeRuntime(home, 'bg', { args: ['session-end', '--entry', e1.id, '--session', SID, '--cwd', repo], handle: () => ({ status: 200, body: { ok: true } }) });
    await runBg(a.rt);
    expect(a.ff.calls[0]?.path).toBe('/v1/session/end');
    expect(a.ff.calls[0]?.body).toEqual(body);
    expect(listOutbox(home).entries).toHaveLength(0);
    const e2 = writeOutbox(home, { sessionId: SID, kind: 'session_end', endpoint: '/v1/session/end', body })!;
    const b = makeRuntime(home, 'bg', { args: ['session-end', '--entry', e2.id, '--session', SID, '--cwd', repo], handle: () => ({ status: 401, body: { error: 'bad_token' } }) });
    await runBg(b.rt);
    expect(listOutbox(home).entries).toHaveLength(0);
    expect(readBreaker(home).configError?.status).toBe(401);
    // unknown job or missing session: nothing happens
    const c = makeRuntime(home, 'bg', { args: ['nonsense'] });
    await runBg(c.rt);
    expect(c.ff.calls).toHaveLength(0);
  });
});
