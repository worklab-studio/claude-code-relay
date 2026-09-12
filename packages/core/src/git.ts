/**
 * Async git wrappers (§4.0 rule 7): `execFile('git', ['-C', cwd, ...])` with a
 * per-call timeout, optional shared AbortSignal, GIT_TERMINAL_PROMPT=0 and
 * GIT_OPTIONAL_LOCKS=0. Never spawnSync/execSync (rule 1); never throws — every
 * helper resolves to a value or null. Synchronous hooks may only use the
 * rev-parse class (`revParseSet`, `gitBranch`, ...); everything else belongs in
 * async hooks and workers.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { BUDGET_MS, LIMITS, type Sha } from './protocol.js';
import { escapeRegExp, truncateLines } from './util.js';

export interface GitRunOptions {
  timeoutMs?: number;
  /** a shared hook-level deadline; aborting kills the child */
  signal?: AbortSignal;
  /** stdin for pipelines such as patch-id */
  input?: string;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

const GIT_ENV_OVERRIDES = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } as const;

/** Run `git -C <cwd> <args>`; resolves on every path (§4.0 rule 1). */
export function runGit(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? BUDGET_MS.gitRevParse;
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ ok: false, code: null, stdout: '', stderr: 'aborted', timedOut: true, ms: 0 });
      return;
    }
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (r: GitResult): void => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: null, stdout: '', stderr: 'aborted', timedOut: true, ms: Date.now() - started });
    };
    try {
      child = execFile(
        'git',
        ['-C', cwd, ...args],
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
          env: { ...(opts.env ?? process.env), ...GIT_ENV_OVERRIDES },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const ms = Date.now() - started;
          if (error) {
            const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string | null };
            const timedOut = Boolean(e.killed) || e.signal === 'SIGKILL' || e.signal === 'SIGTERM';
            finish({
              ok: false,
              code: typeof e.code === 'number' ? e.code : null,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? e.message ?? ''),
              timedOut,
              ms,
            });
            return;
          }
          finish({ ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: false, ms });
        },
      );
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (child.stdin) {
        child.stdin.on('error', () => undefined);
        if (opts.input !== undefined) child.stdin.end(opts.input);
        else child.stdin.end();
      }
    } catch (err) {
      finish({ ok: false, code: null, stdout: '', stderr: String(err), timedOut: false, ms: Date.now() - started });
    }
  });
}

function firstLine(r: GitResult): string | null {
  if (!r.ok) return null;
  const first = r.stdout.split('\n')[0]?.trim() ?? '';
  return first.length ? first : null;
}

/** First line of stdout, trimmed; null on failure or empty. */
async function line(cwd: string, args: string[], opts?: GitRunOptions): Promise<string | null> {
  return firstLine(await runGit(cwd, args, opts));
}

// ---------------------------------------------------------------------------
// rev-parse class (allowed on synchronous hooks, <= 300 ms each)
// ---------------------------------------------------------------------------

export interface RevParseSet {
  toplevel: string | null;
  gitDir: string | null;
  commonDir: string | null;
  head: Sha | null;
  /** `detached@<sha7>` on a detached HEAD (§5.3) */
  branch: string | null;
  originUrl: string | null;
  userEmail: string | null;
  /** a member still timed out (or the caller's signal aborted) after the retry: nulls above may be holes, not facts */
  incomplete: boolean;
}

const REV_PARSE_ARGS: ReadonlyArray<readonly string[]> = [
  ['rev-parse', '--show-toplevel'],
  ['rev-parse', '--git-dir'],
  ['rev-parse', '--git-common-dir'],
  ['rev-parse', 'HEAD'],
  ['rev-parse', '--abbrev-ref', 'HEAD'],
  ['remote', 'get-url', 'origin'],
  ['config', 'user.email'],
];

/**
 * The parallel rev-parse phase of SessionStart / self-heal (§4.1 step 1, §4.0 rule 10).
 * Seven git processes start at once; on a cold or loaded machine one of them can miss
 * the 300 ms budget while the others succeed, which would leave the session with
 * `branch: unknown` and no author filter. Members that timed out (not those that
 * failed, e.g. no origin or no user.email) are retried once, unless the caller's
 * signal is already aborted.
 */
export async function revParseSet(cwd: string, opts?: GitRunOptions): Promise<RevParseSet> {
  const o = { timeoutMs: BUDGET_MS.gitRevParse, ...opts };
  const first = await Promise.all(REV_PARSE_ARGS.map((args) => runGit(cwd, [...args], o)));
  const values: Array<string | null> = first.map((r) => firstLine(r));
  const timedOut: boolean[] = first.map((r) => r.timedOut);
  const retry = first.map((r, i) => (r.timedOut && !opts?.signal?.aborted ? i : -1)).filter((i) => i >= 0);
  if (retry.length > 0) {
    const again = await Promise.all(retry.map((i) => runGit(cwd, [...(REV_PARSE_ARGS[i] as readonly string[])], o)));
    again.forEach((r, k) => {
      const i = retry[k] as number;
      values[i] = firstLine(r);
      timedOut[i] = r.timedOut;
    });
  }
  const [toplevel, gitDir, commonDir, head, abbrev, originUrl, userEmail] = values as [string | null, string | null, string | null, string | null, string | null, string | null, string | null];
  const incomplete = timedOut.some(Boolean) || opts?.signal?.aborted === true;
  return { toplevel, gitDir, commonDir, head, branch: branchName(abbrev, head), originUrl, userEmail, incomplete };
}

/** The newest commit reachable from HEAD committed at or before `iso` (HEAD as it was then, on one branch); null when none. */
export async function gitHeadBefore(cwd: string, iso: string, opts?: GitRunOptions): Promise<Sha | null> {
  const v = await line(cwd, ['rev-list', '-1', `--before=${iso}`, 'HEAD'], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  return v && /^[0-9a-f]{40}$/.test(v) ? v : null;
}

/** `HEAD` from `--abbrev-ref` means detached (§5.3). */
export function branchName(abbrev: string | null, head: Sha | null): string | null {
  if (!abbrev) return head ? `detached@${head.slice(0, 7)}` : null;
  if (abbrev === 'HEAD') return head ? `detached@${head.slice(0, 7)}` : 'detached';
  return abbrev;
}

export async function gitToplevel(cwd: string, opts?: GitRunOptions): Promise<string | null> {
  return line(cwd, ['rev-parse', '--show-toplevel'], opts);
}

export async function gitHead(cwd: string, opts?: GitRunOptions): Promise<Sha | null> {
  return line(cwd, ['rev-parse', 'HEAD'], opts);
}

export async function gitBranch(cwd: string, opts?: GitRunOptions): Promise<string | null> {
  const [abbrev, head] = await Promise.all([line(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], opts), gitHead(cwd, opts)]);
  return branchName(abbrev, head);
}

export async function gitOriginUrl(cwd: string, opts?: GitRunOptions): Promise<string | null> {
  return line(cwd, ['remote', 'get-url', 'origin'], opts);
}

export async function gitUserEmail(cwd: string, opts?: GitRunOptions): Promise<string | null> {
  return line(cwd, ['config', 'user.email'], opts);
}

/** `git rev-parse <rev>:<path>` — blob id at a revision; null when absent. */
export async function gitBlobAt(cwd: string, rev: string, path: string, opts?: GitRunOptions): Promise<Sha | null> {
  return line(cwd, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`], opts);
}

/** Last `n` SHAs on the current branch, newest first (§4.1 step 3). */
export async function gitRecentShas(cwd: string, n: number = LIMITS.recentShas, opts?: GitRunOptions): Promise<Sha[]> {
  const r = await runGit(cwd, ['log', '--format=%H', `-n${n}`], opts);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/.test(s));
}

// ---------------------------------------------------------------------------
// Async-hook / worker class
// ---------------------------------------------------------------------------

/** Paths that `git status` may list but that are never "dirty work" (§4.2 step 4). */
export const GENERATED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|__pycache__|target|\.venv|venv)\//,
  /\.(min\.js|min\.css|map|log|tsbuildinfo)$/,
  /(^|\/)\.DS_Store$/,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((re) => re.test(path));
}

/** Parse `git status --porcelain` (v1) output into repo-relative paths (renames -> new name). */
export function parsePorcelain(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue;
    let rest = raw.slice(3);
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    if (rest) out.push(rest.replace(/\/$/, ''));
  }
  return out;
}

/** `git status --porcelain` -> dirty paths, generated paths excluded, capped (§4.2 step 4, §4.8 step 2). */
export async function gitDirtyPaths(
  cwd: string,
  opts: GitRunOptions & { cap?: number } = {},
): Promise<string[] | null> {
  const r = await runGit(cwd, ['status', '--porcelain', '--untracked-files=all', '--no-renames'], {
    timeoutMs: BUDGET_MS.gitDiff,
    ...opts,
  });
  if (!r.ok) return null;
  const cap = opts.cap ?? LIMITS.dirtyPathsCap;
  return parsePorcelain(r.stdout).filter((p) => !isGeneratedPath(p)).slice(0, cap);
}

export interface OwnCommit {
  sha: Sha;
  authorEmail: string;
  subject: string;
}

/** Extended regex for `--author`: `<(a@b|c@d)>` anchored on the email brackets (§4.0 rule 7). */
export function authorRegex(emails: readonly string[]): string | null {
  const parts = emails.map((e) => e.trim()).filter(Boolean).map(escapeRegExp);
  return parts.length ? `<(${parts.join('|')})>` : null;
}

/**
 * Own commits in `<from>..<to>`: `git log --author=<regex> --no-merges`, never
 * a raw range (§4.0 rule 7). `from` null -> the whole branch (capped).
 */
export async function gitOwnCommits(
  cwd: string,
  params: { emails: readonly string[]; from: string | null; to?: string; cap?: number },
  opts?: GitRunOptions,
): Promise<OwnCommit[] | null> {
  const author = authorRegex(params.emails);
  if (!author) return [];
  const cap = params.cap ?? LIMITS.commitBackfillCap;
  const range = params.from ? `${params.from}..${params.to ?? 'HEAD'}` : (params.to ?? 'HEAD');
  const r = await runGit(
    cwd,
    ['log', '--no-merges', '--extended-regexp', '--regexp-ignore-case', `--author=${author}`, '--format=%H%x09%ae%x09%s', `-n${cap}`, range],
    { timeoutMs: BUDGET_MS.gitDiff, ...opts },
  );
  if (!r.ok) return null;
  const out: OwnCommit[] = [];
  for (const l of r.stdout.split('\n')) {
    const [sha, authorEmail, ...subject] = l.split('\t');
    if (sha && /^[0-9a-f]{40}$/.test(sha)) out.push({ sha, authorEmail: authorEmail ?? '', subject: subject.join('\t') });
  }
  return out;
}

/** Files touched by one commit. */
export async function gitCommitFiles(cwd: string, sha: Sha, opts?: GitRunOptions): Promise<string[] | null> {
  const r = await runGit(cwd, ['diff-tree', '-r', '--no-commit-id', '--name-only', sha], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (!r.ok) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Is `path` tracked at HEAD? */
export async function gitIsTracked(cwd: string, path: string, opts?: GitRunOptions): Promise<boolean> {
  const r = await runGit(cwd, ['ls-files', '--error-unmatch', '--', path], opts);
  return r.ok;
}

/**
 * `git diff -U0 -w HEAD -- <path>` capped at `maxBytes` (§4.5 step 2). An
 * untracked file becomes one synthetic all-`+` hunk. Null on git failure.
 */
export async function gitDiffU0(
  cwd: string,
  path: string,
  opts: GitRunOptions & { maxBytes?: number } = {},
): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? 4096;
  const r = await runGit(cwd, ['diff', '-U0', '-w', '--no-color', '--no-ext-diff', 'HEAD', '--', path], {
    timeoutMs: BUDGET_MS.gitDiff,
    ...opts,
  });
  if (r.ok) {
    if (r.stdout.trim().length > 0) return truncateLines(r.stdout, maxBytes);
    // empty: either unchanged or untracked
    const tracked = await gitIsTracked(cwd, path, opts);
    if (tracked) return '';
    return syntheticAddedDiff(cwd, path, maxBytes);
  }
  // `HEAD` may not exist in a fresh repo: treat as untracked
  if (/bad revision|ambiguous argument 'HEAD'|unknown revision/i.test(r.stderr)) return syntheticAddedDiff(cwd, path, maxBytes);
  return null;
}

async function syntheticAddedDiff(cwd: string, path: string, maxBytes: number): Promise<string | null> {
  try {
    const text = await readFile(`${cwd}/${path}`, 'utf8');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const body = lines.map((l) => `+${l}`).join('\n');
    return truncateLines(`--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}`, maxBytes);
  } catch {
    return null;
  }
}

/** `git show -U0 -w --format= <sha> -- <files>` capped (§4.6). */
export async function gitShowU0(
  cwd: string,
  sha: Sha,
  files: readonly string[],
  opts: GitRunOptions & { maxBytes?: number } = {},
): Promise<string | null> {
  if (!files.length) return '';
  const r = await runGit(cwd, ['show', '-U0', '-w', '--no-color', '--format=', sha, '--', ...files], {
    timeoutMs: BUDGET_MS.gitDiff,
    ...opts,
  });
  return r.ok ? truncateLines(r.stdout, opts.maxBytes ?? 8192) : null;
}

/** File content at a revision (`git show <rev>:<path>`), capped; null when absent. */
export async function gitShowFile(
  cwd: string,
  rev: string,
  path: string,
  opts: GitRunOptions & { maxBytes?: number } = {},
): Promise<string | null> {
  const r = await runGit(cwd, ['show', `${rev}:${path}`], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  return r.ok ? r.stdout.slice(0, opts.maxBytes ?? 256 * 1024) : null;
}

/** Blob id of the working-tree file (`git hash-object <path>`, §4.5 step 2). */
export async function gitHashObject(cwd: string, path: string, opts?: GitRunOptions): Promise<Sha | null> {
  return line(cwd, ['hash-object', '--', path], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
}

/** `git diff-tree -p <sha> | git patch-id --stable` -> rebase-safe identity (§4.6). */
export async function gitPatchId(cwd: string, sha: Sha, opts?: GitRunOptions): Promise<string | null> {
  const diff = await runGit(cwd, ['diff-tree', '-p', '--no-color', sha], { timeoutMs: BUDGET_MS.gitDiff, maxBuffer: 16 * 1024 * 1024, ...opts });
  if (!diff.ok || !diff.stdout) return null;
  const pid = await runGit(cwd, ['patch-id', '--stable'], { timeoutMs: BUDGET_MS.gitDiff, ...opts, input: diff.stdout });
  if (!pid.ok) return null;
  const first = pid.stdout.split('\n')[0]?.trim().split(' ')[0] ?? '';
  return /^[0-9a-f]{40}$/.test(first) ? first : null;
}

/** `git merge-base <a> <b>`; null when unrelated or failing. */
export async function gitMergeBase(cwd: string, a: string, b: string, opts?: GitRunOptions): Promise<Sha | null> {
  return line(cwd, ['merge-base', a, b], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
}

/** `git merge-base --is-ancestor <sha> <of>`: true/false, or null when git could not answer (unknown sha, timeout). */
export async function gitIsAncestor(cwd: string, sha: Sha, of = 'HEAD', opts?: GitRunOptions): Promise<boolean | null> {
  const r = await runGit(cwd, ['merge-base', '--is-ancestor', sha, of], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (r.ok) return true;
  if (r.timedOut) return null;
  if (r.code === 1) return false;
  return null;
}

/** Does any remote branch contain HEAD (push detection, §4.6)? */
export async function gitHeadOnRemote(cwd: string, opts?: GitRunOptions): Promise<boolean | null> {
  const r = await runGit(cwd, ['branch', '-r', '--contains', 'HEAD'], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (!r.ok) return null;
  return r.stdout.trim().length > 0;
}

export interface GitGrepOptions extends GitRunOptions {
  /** extra pathspecs such as `:!node_modules`, `'*.ts'` */
  pathspecs?: readonly string[];
  cap?: number;
  /** `-l` (default) lists files; `-n` returns `file:line:text` lines */
  mode?: 'files' | 'lines';
}

/**
 * `git grep -I -E <pattern> -- <pathspecs>`. Files mode returns paths (cap 50)
 * or null on timeout/failure; lines mode returns raw `path:line:text` lines.
 */
export async function gitGrep(cwd: string, pattern: string, opts: GitGrepOptions = {}): Promise<string[] | null> {
  const mode = opts.mode ?? 'files';
  const args = ['grep', '-I', '-E', '--no-color', mode === 'files' ? '-l' : '-n', '-e', pattern, '--', ...(opts.pathspecs ?? [])];
  const r = await runGit(cwd, args, { timeoutMs: BUDGET_MS.gitGrep, maxBuffer: 32 * 1024 * 1024, ...opts });
  if (r.ok) {
    const lines = r.stdout.split('\n').filter(Boolean);
    return opts.cap ? lines.slice(0, opts.cap) : lines;
  }
  if (r.code === 1 && !r.timedOut) return []; // no matches
  return null;
}

/** Tracked files (optionally filtered by pathspecs), for the dependency index (§7.4). */
export async function gitLsFiles(cwd: string, pathspecs: readonly string[] = [], opts?: GitRunOptions): Promise<string[] | null> {
  const r = await runGit(cwd, ['ls-files', '-z', '--', ...pathspecs], { timeoutMs: BUDGET_MS.gitGrep, maxBuffer: 32 * 1024 * 1024, ...opts });
  if (!r.ok) return null;
  return r.stdout.split('\0').filter(Boolean);
}

/** `git ls-remote <remote> HEAD` in a marketplace clone (§3.4 plugin-behind check). */
export async function gitLsRemoteHead(dir: string, remote = 'origin', opts?: GitRunOptions): Promise<Sha | null> {
  const r = await runGit(dir, ['ls-remote', remote, 'HEAD'], { timeoutMs: 1000, ...opts });
  if (!r.ok) return null;
  const sha = r.stdout.split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Commits between two SHAs on the current branch (any author), for ancestry refresh. */
export async function gitRevList(cwd: string, range: string, cap = 200, opts?: GitRunOptions): Promise<Sha[] | null> {
  const r = await runGit(cwd, ['rev-list', `-n${cap}`, range], { timeoutMs: BUDGET_MS.gitDiff, ...opts });
  if (!r.ok) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Basename helper re-exported for worktree naming call sites. */
export { basename as pathBasename };
