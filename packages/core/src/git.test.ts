import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { buildDepIndex, findDependents } from './depindex.js';
import {
  authorRegex,
  branchName,
  gitBlobAt,
  gitBranch,
  gitCommitFiles,
  gitDiffU0,
  gitDirtyPaths,
  gitGrep,
  gitHashObject,
  gitHeadOnRemote,
  gitIsAncestor,
  gitIsTracked,
  gitLsFiles,
  gitMergeBase,
  gitOwnCommits,
  gitPatchId,
  gitRecentShas,
  gitHeadBefore,
  isGeneratedPath,
  parsePorcelain,
  revParseSet,
  runGit,
} from './git.js';
import { ensureSessionMeta, isMetaIncomplete, readMeta, repairSessionMeta, writeMeta, ensureSessionDir } from './journal.js';
import { readEnv } from './config.js';
import { normalizeOriginUrl, worktreeName } from './repo.js';

const DEEPAK = { GIT_AUTHOR_NAME: 'Deepak', GIT_AUTHOR_EMAIL: 'deepak@example.com', GIT_COMMITTER_NAME: 'Deepak', GIT_COMMITTER_EMAIL: 'deepak@example.com' };
const PRIYA = { GIT_AUTHOR_NAME: 'Priya', GIT_AUTHOR_EMAIL: 'priya@acme.com', GIT_COMMITTER_NAME: 'Priya', GIT_COMMITTER_EMAIL: 'priya@acme.com' };

let root = '';
let repo = '';
let cleanup: () => void = () => undefined;
const git = (args: string[], env: Record<string, string> = DEEPAK, cwd = repo): string =>
  execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' }).trim();

beforeAll(() => {
  const t = tmpHome('relay-git-');
  root = t.home;
  cleanup = t.cleanup;
  repo = join(root, 'app');
  mkdirSync(join(repo, 'packages/contracts/src'), { recursive: true });
  mkdirSync(join(repo, 'apps/dashboard/src'), { recursive: true });
  git(['init', '-q', '-b', 'main'], DEEPAK, repo);
  git(['config', 'user.email', 'deepak@example.com']);
  git(['config', 'user.name', 'Deepak']);
  writeFileSync(join(repo, 'packages/contracts/package.json'), JSON.stringify({ name: '@acme/contracts' }));
  writeFileSync(join(repo, 'packages/contracts/src/billing.ts'), 'export interface Invoice {\n  total: number\n}\nexport function createInvoice(input: InvoiceInput): Invoice {\n  return {} as Invoice\n}\n');
  writeFileSync(join(repo, 'apps/dashboard/src/invoices.tsx'), "import { Invoice } from '@acme/contracts/billing'\nexport const x: Invoice = {} as Invoice\n");
  writeFileSync(join(repo, 'apps/dashboard/src/client.ts'), "import { createInvoice } from '../../../packages/contracts/src/billing'\n");
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lock: 1\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  git(['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
});
afterAll(() => cleanup());

describe('rev-parse class', () => {
  it('collects toplevel, head, branch, origin and email in parallel', async () => {
    const rp = await revParseSet(join(repo, 'apps/dashboard'));
    expect(rp.toplevel).toBe(git(['rev-parse', '--show-toplevel']));
    expect(rp.head).toMatch(/^[0-9a-f]{40}$/);
    expect(rp.branch).toBe('main');
    expect(normalizeOriginUrl(rp.originUrl)).toBe('github.com/acme/app');
    expect(rp.userEmail).toBe('deepak@example.com');
    // git prints --git-dir absolute and --git-common-dir relative to its cwd from a subdirectory
    expect(resolve(join(repo, 'apps/dashboard'), rp.gitDir!)).toBe(join(repo, '.git'));
    expect(resolve(join(repo, 'apps/dashboard'), rp.commonDir!)).toBe(join(repo, '.git'));
    expect(worktreeName(rp.toplevel!, rp.gitDir, rp.commonDir, join(repo, 'apps/dashboard'))).toBeNull();
    const outside = await revParseSet(root);
    expect(outside.toplevel).toBeNull();
    expect(outside.head).toBeNull();
  });

  it('names detached heads and worktrees', async () => {
    expect(branchName('HEAD', 'abcdef0123456789')).toBe('detached@abcdef0');
    expect(branchName(null, null)).toBeNull();
    const sha = git(['rev-parse', 'HEAD']);
    git(['checkout', '-q', '--detach', sha]);
    expect(await gitBranch(repo)).toBe(`detached@${sha.slice(0, 7)}`);
    git(['checkout', '-q', 'main']);
    const wt = join(root, 'wt-feature');
    git(['worktree', 'add', '-q', '-b', 'feat/x', wt]);
    const rp = await revParseSet(wt);
    expect(rp.branch).toBe('feat/x');
    expect(worktreeName(rp.toplevel!, rp.gitDir, rp.commonDir, wt)).toBe('wt-feature');
    git(['worktree', 'remove', '--force', wt]);
  });

  it('never throws and honours an aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runGit(repo, ['rev-parse', 'HEAD'], { signal: ctrl.signal });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    const bad = await runGit(repo, ['not-a-command']);
    expect(bad.ok).toBe(false);
    expect(bad.code).not.toBe(0);
    const missing = await runGit(join(root, 'nope'), ['status']);
    expect(missing.ok).toBe(false);
  });
});

describe('diffs, blobs, commits', () => {
  it('diffs a tracked change with -U0 -w, treats untracked files as all-added, and reports empty diffs', async () => {
    const path = 'packages/contracts/src/billing.ts';
    expect(await gitDiffU0(repo, path)).toBe('');
    writeFileSync(join(repo, path), 'export interface Invoice {\n  amountDue: number\n  currency: Currency\n}\nexport function createInvoice(input: InvoiceInput, currency: Currency): Invoice {\n  return {} as Invoice\n}\n');
    const diff = await gitDiffU0(repo, path);
    expect(diff).toContain('@@');
    expect(diff).toContain('-  total: number');
    expect(diff).toContain('+  currency: Currency');
    expect(diff).toContain('export interface Invoice {');
    writeFileSync(join(repo, 'packages/contracts/src/new.ts'), 'export type Currency = string\n');
    const added = await gitDiffU0(repo, 'packages/contracts/src/new.ts');
    expect(added).toContain('@@ -0,0 +1,1 @@');
    expect(added).toContain('+export type Currency = string');
    expect(await gitIsTracked(repo, 'packages/contracts/src/new.ts')).toBe(false);
    expect(await gitDiffU0(repo, 'does/not/exist.ts')).toBeNull();
    const blob = await gitHashObject(repo, path);
    expect(blob).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitBlobAt(repo, 'HEAD', path)).not.toBe(blob);
    expect(await gitBlobAt(repo, 'HEAD', 'nope.ts')).toBeNull();
  });

  it('lists dirty paths without generated files and parses renames', async () => {
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lock: 2\n');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist/bundle.js'), 'x');
    const dirty = await gitDirtyPaths(repo);
    expect(dirty).toContain('packages/contracts/src/billing.ts');
    expect(dirty).toContain('packages/contracts/src/new.ts');
    expect(dirty).not.toContain('pnpm-lock.yaml');
    expect(dirty).not.toContain('dist/bundle.js');
    expect(isGeneratedPath('node_modules/x/index.js')).toBe(true);
    expect(parsePorcelain('R  old.ts -> new.ts\n M a.ts\n?? "quoted name.ts"\n')).toEqual(['new.ts', 'a.ts', 'quoted name.ts']);
    git(['checkout', '-q', '--', 'pnpm-lock.yaml']);
    rmSync(join(repo, 'dist'), { recursive: true, force: true });
  });

  it('reports only own-author commits, never pulled-in ones (§4.0 rule 7)', async () => {
    const base = git(['rev-parse', 'HEAD']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'contracts: currency on Invoice'], DEEPAK);
    writeFileSync(join(repo, 'apps/dashboard/src/other.ts'), 'export const o = 1\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'dashboard: other (priya)'], PRIYA);
    writeFileSync(join(repo, 'apps/dashboard/src/mine.ts'), 'export const m = 1\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'dashboard: mine'], DEEPAK);
    const own = await gitOwnCommits(repo, { emails: ['DEEPAK@exampleteam.com'], from: base });
    expect(own?.map((c) => c.subject)).toEqual(['dashboard: mine', 'contracts: currency on Invoice']);
    expect(own?.[0]?.authorEmail).toBe('deepak@example.com');
    expect(await gitOwnCommits(repo, { emails: [], from: base })).toEqual([]);
    expect(authorRegex(['a.b@x.com', 'c@y'])).toBe('<(a\\.b@x\\.com|c@y)>');
    const priya = await gitOwnCommits(repo, { emails: ['priya@acme.com'], from: base, cap: 1 });
    expect(priya).toHaveLength(1);
    const sha = own![1]!.sha;
    expect(await gitCommitFiles(repo, sha)).toEqual(['packages/contracts/src/billing.ts', 'packages/contracts/src/new.ts']);
    expect(await gitPatchId(repo, sha)).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitIsAncestor(repo, base, 'HEAD')).toBe(true);
    expect(await gitIsAncestor(repo, 'HEAD', base)).toBe(false);
    expect(await gitIsAncestor(repo, 'f'.repeat(40), 'HEAD')).toBeNull();
    expect(await gitMergeBase(repo, base, 'HEAD')).toBe(base);
    expect((await gitRecentShas(repo, 2)).length).toBe(2);
    expect(await gitHeadOnRemote(repo)).toBe(false);
  });

  it('greps files and lines with a cap, and returns [] on no match', async () => {
    const files = await gitGrep(repo, "from '@acme/contracts", { pathspecs: ['*.ts', '*.tsx'] });
    expect(files).toEqual(['apps/dashboard/src/invoices.tsx']);
    expect(await gitGrep(repo, 'definitely-not-present-zzz')).toEqual([]);
    const lines = await gitGrep(repo, 'export', { mode: 'lines', cap: 2 });
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toMatch(/^[^:]+:\d+:/);
    const ls = await gitLsFiles(repo, ['*.tsx']);
    expect(ls).toEqual(['apps/dashboard/src/invoices.tsx']);
  });

  it('builds the dependency index and finds in-repo dependents', async () => {
    const idx = await buildDepIndex(repo, { repo: 'github.com/acme/app' });
    expect(idx?.imports['@acme/contracts/billing']).toEqual(['apps/dashboard/src/invoices.tsx']);
    expect(idx?.imports['packages/contracts/src/billing']).toEqual(['apps/dashboard/src/client.ts']);
    expect(idx?.symbols['Invoice']).toEqual(['apps/dashboard/src/invoices.tsx']);
    expect(idx?.contractPaths['billing']).toEqual(['apps/dashboard/src/client.ts']);
    const deps = await findDependents(repo, { path: 'packages/contracts/src/billing.ts', packageName: '@acme/contracts', kind: 'ts' });
    expect(deps?.sort()).toEqual(['apps/dashboard/src/client.ts', 'apps/dashboard/src/invoices.tsx']);
    expect(await findDependents(repo, { path: 'apps/dashboard/src/mine.ts' })).toEqual([]);
  });
});

describe('self-healing meta (§4.0 rule 10)', () => {
  it('builds meta from git and identity, reuses it inside the repo and rebuilds outside', async () => {
    const t = tmpHome();
    try {
      const env = readEnv({ RELAY_HOME: t.home, RELAY_DEV: 'deepak' });
      const first = await ensureSessionMeta({ home: t.home, sessionId: 'sess1', cwd: join(repo, 'apps/dashboard'), env, team: null, pid: 42, source: 'startup' });
      expect(first.healed).toBe(true);
      expect(first.gitOk).toBe(true);
      expect(first.meta).toMatchObject({ dev: 'deepak', identitySource: 'env', repo: 'github.com/acme/app', project: 'acme/app', branch: 'main', worktree: null, pid: 42, source: 'startup' });
      expect(first.meta.repoRoot).toBe(git(['rev-parse', '--show-toplevel']));
      expect(first.meta.gitEmails).toEqual(['deepak@example.com']);
      expect(first.meta.startSha).toBe(git(['rev-parse', 'HEAD']));
      expect(readMeta(join(t.home, 'sessions', 'sess1'))).toEqual(first.meta);
      const again = await ensureSessionMeta({ home: t.home, sessionId: 'sess1', cwd: join(repo, 'packages'), env, team: null });
      expect(again.healed).toBe(false);
      expect(again.meta).toEqual(first.meta);
      const other = join(root, 'other-repo');
      mkdirSync(other, { recursive: true });
      git(['init', '-q', '-b', 'main'], DEEPAK, other);
      const moved = await ensureSessionMeta({ home: t.home, sessionId: 'sess1', cwd: other, env, team: null });
      expect(moved.healed).toBe(true);
      expect(moved.meta.repo).toBe('local/other-repo');
      expect(moved.meta.startedAt).toBe(first.meta.startedAt);
      expect(moved.meta.startSha).toBeNull();
      const nogit = await ensureSessionMeta({ home: t.home, sessionId: 'sess2', cwd: root, env, team: null });
      expect(nogit.gitOk).toBe(false);
      expect(nogit.meta.repo).toMatch(/^local\//);
      expect(nogit.meta.branch).toBe('unknown');
    } finally {
      t.cleanup();
    }
  });
});

describe('rev-parse timeouts and meta repair (§4.0 rule 10 hardening)', () => {
  it('retries members of revParseSet that timed out, not those that merely failed', async () => {
    // a git shim that stalls `rev-parse --abbrev-ref HEAD` once, then behaves; `remote get-url origin` fails fast
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir, { recursive: true });
    const marker = join(shimDir, 'stalled-once');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\ncase "$*" in *"--abbrev-ref HEAD"*) if [ ! -e "${marker}" ]; then : > "${marker}"; sleep 1; fi;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    const noOrigin = join(root, 'no-origin');
    mkdirSync(noOrigin, { recursive: true });
    git(['init', '-q', '-b', 'main'], DEEPAK, noOrigin);
    writeFileSync(join(noOrigin, 'a.txt'), 'a\n');
    git(['add', '-A'], DEEPAK, noOrigin);
    git(['commit', '-q', '-m', 'one'], DEEPAK, noOrigin);
    const env = { ...process.env, PATH: `${shimDir}:${process.env['PATH'] ?? ''}` };
    const rp = await revParseSet(noOrigin, { timeoutMs: 300, env });
    expect(existsSync(marker)).toBe(true); // the first call stalled and was killed at 300 ms
    expect(rp.branch).toBe('main'); // ...and the retry recovered it
    expect(rp.head).toMatch(/^[0-9a-f]{40}$/);
    expect(rp.originUrl).toBeNull(); // a plain failure is not retried (no marker semantics needed: it is just null)
    const aborted = new AbortController();
    aborted.abort();
    const none = await revParseSet(noOrigin, { timeoutMs: 300, env, signal: aborted.signal });
    expect(none.toplevel).toBeNull();
  });

  it('gitHeadBefore returns HEAD as it was at a time', async () => {
    const first = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]!;
    const firstAt = git(['show', '-s', '--format=%cI', first]);
    // git dates have 1 s resolution: the answer is the newest commit not after `firstAt`
    const sha = await gitHeadBefore(repo, firstAt);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Date.parse(git(['show', '-s', '--format=%cI', sha!]))).toBeLessThanOrEqual(Date.parse(firstAt));
    expect(git(['merge-base', '--is-ancestor', first, sha!])).toBe('');
    expect(await gitHeadBefore(repo, '2000-01-01T00:00:00Z')).toBeNull();
  });

  it('repairSessionMeta fills branch, start sha and author emails left unset by a timeout', async () => {
    const t = tmpHome('relay-repair-');
    try {
      const sid = 'repair1';
      const dir = ensureSessionDir(t.home, sid);
      const head = git(['rev-parse', 'HEAD']);
      const headAt = git(['show', '-s', '--format=%cI', head]);
      // the session began just after HEAD was committed; a later commit must not become the start sha
      const startedAt = new Date(Date.parse(headAt) + 1000).toISOString();
      writeMeta(dir, {
        v: 1, sessionId: sid, dev: 'deepak', identitySource: 'env', repo: 'github.com/acme/app', project: 'acme/app', repoKey: 'k', repoRoot: repo, cwd: repo, branch: 'unknown', worktree: null,
        startSha: null, lastStopSha: null, lastStopAt: null, client: 'cli', host: 'mac', pid: 1, startedAt, source: 'startup', gitEmail: null, gitEmails: [], configHash: null, model: null, pluginSha: null,
      });
      expect(isMetaIncomplete(readMeta(dir)!)).toBe(true);
      await new Promise((r) => setTimeout(r, 1100)); // git dates have 1 s resolution
      writeFileSync(join(repo, 'later.txt'), 'later\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'after session start']);
      const team = { hub: 'http://h', team: 't', token: 'x', marketplace: null, members: { deepak: { name: 'Deepak', emails: ['deepak@example.com', 'd@other.dev'] } } };
      const r = await repairSessionMeta({ home: t.home, sessionId: sid, cwd: join(repo, 'apps'), team: team as never });
      expect(r.repaired).toBe(true);
      expect(r.meta).toMatchObject({ dev: 'deepak', branch: 'main', gitEmail: 'deepak@example.com', startSha: head });
      expect(r.meta!.gitEmails).toEqual(['deepak@example.com', 'd@other.dev']);
      expect(isMetaIncomplete(readMeta(dir)!)).toBe(false);
      const again = await repairSessionMeta({ home: t.home, sessionId: sid, cwd: repo, team: null });
      expect(again.repaired).toBe(false); // complete: no git, no rewrite
      expect(await repairSessionMeta({ home: t.home, sessionId: 'nope', cwd: repo, team: null })).toEqual({ meta: null, repaired: false });
    } finally {
      t.cleanup();
    }
  });
});
