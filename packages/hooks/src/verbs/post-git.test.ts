import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFold, readMeta, readRepoState, sessionDir, type BranchEvent, type CommitEvent, type EventsRequest } from '@relay/core';
import { T0, git, makeRepo, makeRuntime, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { runPostGit } from './post-git.js';

const SID = 'sess-post-git';
const BILLING = 'packages/contracts/src/billing.ts';

describe('post-git', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'), { email: 'deepak@acme.dev', name: 'Deepak' });
  });
  afterEach(() => cleanup());

  it('own commit on the same branch: commit event with contract records, patch id and journal line; foreign commits are ignored', async () => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    seedMeta(home, SID, repo, { branch: 'main', startSha: head0, gitEmails: ['deepak@acme.dev'] });
    // a teammate's commit (as if pulled) followed by an own commit touching a contract
    git(repo, '-c', 'user.email=priya@acme.dev', '-c', 'user.name=Priya', 'commit', '-q', '--allow-empty', '-m', 'priya: unrelated');
    writeFileSync(join(repo, BILLING), 'export interface Invoice {\n  id: string\n  amountDue: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n');
    writeFileSync(join(repo, 'README.md'), '# demo\nchanged\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'contracts: rename total');
    const head1 = git(repo, 'rev-parse', 'HEAD');

    const { rt, ff } = makeRuntime(home, 'post-git', { now: () => now });
    const out = await runPostGit(rt, stdin.postGit(SID, repo, 'git add -A && git commit -m "contracts: rename total"'));
    expect(out).toBeNull();
    const body = ff.calls[0]?.body as EventsRequest;
    expect(body.events).toHaveLength(1);
    const c = body.events[0] as CommitEvent;
    expect(c).toMatchObject({ type: 'commit', sha: head1, authorEmail: 'deepak@acme.dev', subject: 'contracts: rename total', branch: 'main' });
    expect(c.files.sort()).toEqual(['README.md', BILLING]);
    expect(c.patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(c.contracts).toHaveLength(1);
    expect(c.contracts[0]).toMatchObject({ path: BILLING, symbols: expect.arrayContaining(['Invoice']) });
    expect(c.contracts[0]?.blobId).toBe(git(repo, 'rev-parse', `${head1}:${BILLING}`));
    expect(c.contracts[0]?.hunk).toContain('+  amountDue: number');
    const fold = loadFold(sessionDir(home, SID));
    expect(fold.commits.map((x) => x.sha)).toEqual([head1]);
    expect(readRepoState(home, fold ? readMeta(sessionDir(home, SID))!.repoKey : '').lastReportedSha['main']).toBe(head1);

    // a second run with no new commits posts nothing
    const { rt: rt2, ff: ff2 } = makeRuntime(home, 'post-git', { now: () => now + 1 });
    expect(await runPostGit(rt2, stdin.postGit(SID, repo, 'git status'))).toBeNull();
    expect(ff2.calls).toHaveLength(0);
  });

  it('incomplete meta (SessionStart rev-parse timeout) is repaired first: the commit is reported, not a branch switch', async () => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    // what a timed-out SessionStart leaves behind: branch unknown, no start sha, no author filter
    seedMeta(home, SID, repo, { branch: 'unknown', startSha: null, gitEmail: null, gitEmails: [], startedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 1100)); // git commit dates have 1 s resolution; the session began before this commit
    writeFileSync(join(repo, BILLING), 'export interface Invoice {\n  id: string\n  amountDue: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n');
    git(repo, 'commit', '-qam', 'contracts: rename total');
    const head1 = git(repo, 'rev-parse', 'HEAD');
    const { rt, ff } = makeRuntime(home, 'post-git', { now: () => Date.now() });
    await runPostGit(rt, stdin.postGit(SID, repo, 'git commit -am "contracts: rename total"'));
    const meta = readMeta(sessionDir(home, SID))!;
    expect(meta.branch).toBe('main');
    expect(meta.gitEmails).toEqual(['deepak@acme.dev']);
    expect(meta.startSha).toBe(head0);
    const body = ff.calls[0]?.body as EventsRequest;
    expect(body.events.map((e) => e.type)).toEqual(['commit']);
    expect((body.events[0] as CommitEvent).sha).toBe(head1);
  });

  it('branch change: branch event, startSha reset to the merge-base, lastStopSha cleared, no cross-branch commit scan', async () => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    seedMeta(home, SID, repo, { branch: 'main', startSha: head0, lastStopSha: head0, gitEmails: ['deepak@acme.dev'] });
    git(repo, 'checkout', '-q', '-b', 'feat/currency');
    writeFileSync(join(repo, 'README.md'), '# demo\nfeature\n');
    git(repo, 'commit', '-qam', 'feature work');
    const { rt, ff } = makeRuntime(home, 'post-git', { now: () => now });
    await runPostGit(rt, stdin.postGit(SID, repo, 'git checkout -b feat/currency'));
    const body = ff.calls[0]?.body as EventsRequest;
    expect(body.events.map((e) => e.type)).toEqual(['branch']);
    expect(body.events[0] as BranchEvent).toMatchObject({ type: 'branch', branch: 'feat/currency', worktree: null, startSha: head0 });
    expect(body.session.branch).toBe('feat/currency');
    const meta = readMeta(sessionDir(home, SID))!;
    expect(meta.branch).toBe('feat/currency');
    expect(meta.startSha).toBe(head0);
    expect(meta.lastStopSha).toBeNull();
    expect(readRepoState(home, meta.repoKey).lastReportedSha['feat/currency']).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('git push with HEAD on a remote emits a push event and marks journal commits pushed', async () => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    seedMeta(home, SID, repo, { branch: 'main', startSha: head0, gitEmails: ['deepak@acme.dev'] });
    const { rt, ff } = makeRuntime(home, 'post-git', { now: () => now, git: { gitHeadOnRemote: async () => true } });
    await runPostGit(rt, stdin.postGit(SID, repo, 'git push origin main'));
    const body = ff.calls[0]?.body as EventsRequest;
    expect(body.events).toEqual([expect.objectContaining({ type: 'push', branch: 'main', sha: head0 })]);
    // not pushed when no remote contains HEAD
    const { rt: rt2, ff: ff2 } = makeRuntime(home, 'post-git', { now: () => now, git: { gitHeadOnRemote: async () => false } });
    expect(await runPostGit(rt2, stdin.postGit(SID, repo, 'git push'))).toBeNull();
    expect(ff2.calls).toHaveLength(0);
  });

  it('git failure or a repo without commits: exit silently', async () => {
    seedMeta(home, SID, repo, { branch: 'main' });
    const { rt, ff } = makeRuntime(home, 'post-git', { git: { gitHead: async () => null } });
    expect(await runPostGit(rt, stdin.postGit(SID, repo, 'git log'))).toBeNull();
    expect(ff.calls).toHaveLength(0);
  });
});
