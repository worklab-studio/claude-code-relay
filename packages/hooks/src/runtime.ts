/**
 * Hook runtime: the small dependency object every verb runs against (§4.0
 * rules 1, 4, 7, 12; §4.12). Verbs never touch process.env, child_process or
 * fetch directly — they read `rt.env`, call `rt.git.*`, build hub clients with
 * `rt.fetch` and spawn workers with `rt.spawnBg`, so tests inject fakes and
 * the integration test drives the real bundle.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEADLINE_MS,
  buildDepIndex,
  debugLog,
  findDependents,
  gitBlobAt,
  gitBranch,
  gitCommitFiles,
  gitDiffU0,
  gitDirtyPaths,
  gitHashObject,
  gitHead,
  gitHeadOnRemote,
  gitIsAncestor,
  gitLsRemoteHead,
  gitMergeBase,
  gitOwnCommits,
  gitPatchId,
  gitRecentShas,
  gitShowU0,
  loadTeamConfig,
  readEnv,
  refreshAncestry,
  resolvePluginSha,
  revParseSet,
  type BgJob,
  type RelayEnv,
  type TeamConfig,
} from '@relay/core';

/** The git surface the verbs use (all core helpers resolve, never reject). */
export interface GitApi {
  revParseSet: typeof revParseSet;
  gitHead: typeof gitHead;
  gitBranch: typeof gitBranch;
  gitRecentShas: typeof gitRecentShas;
  gitBlobAt: typeof gitBlobAt;
  gitDirtyPaths: typeof gitDirtyPaths;
  gitOwnCommits: typeof gitOwnCommits;
  gitCommitFiles: typeof gitCommitFiles;
  gitDiffU0: typeof gitDiffU0;
  gitShowU0: typeof gitShowU0;
  gitHashObject: typeof gitHashObject;
  gitPatchId: typeof gitPatchId;
  gitMergeBase: typeof gitMergeBase;
  gitIsAncestor: typeof gitIsAncestor;
  gitHeadOnRemote: typeof gitHeadOnRemote;
  gitLsRemoteHead: typeof gitLsRemoteHead;
  findDependents: typeof findDependents;
  buildDepIndex: typeof buildDepIndex;
  refreshAncestry: typeof refreshAncestry;
}

export const realGit: GitApi = {
  revParseSet,
  gitHead,
  gitBranch,
  gitRecentShas,
  gitBlobAt,
  gitDirtyPaths,
  gitOwnCommits,
  gitCommitFiles,
  gitDiffU0,
  gitShowU0,
  gitHashObject,
  gitPatchId,
  gitMergeBase,
  gitIsAncestor,
  gitHeadOnRemote,
  gitLsRemoteHead,
  findDependents,
  buildDepIndex,
  refreshAncestry,
};

export interface HookRuntime {
  verb: string;
  /** argv after the verb */
  args: string[];
  env: RelayEnv;
  home: string;
  team: TeamConfig | null;
  pluginSha: string | null;
  /** ~/.claude (settings.json, plugin marketplaces) */
  claudeHome: string;
  startedAt: number;
  deadlineMs: number;
  /** aborted shortly before the deadline so in-flight git/fetch calls die first */
  signal: AbortSignal;
  now(): number;
  /** ms left before the deadline (minus a safety margin), never negative */
  remainingMs(): number;
  git: GitApi;
  /** injected into HubClient; undefined -> global fetch */
  fetch: typeof fetch | undefined;
  /** detached `bg <job> ...` worker; returns false when spawning was skipped */
  spawnBg(job: BgJob, args: readonly string[]): boolean;
  log(message: string): void;
  /** re-arm the abort signal (SessionStart shortens it for `compact`) */
  setDeadline(ms: number): void;
}

export interface RuntimeOptions {
  verb: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
  git?: Partial<GitApi>;
  fetch?: typeof fetch;
  spawnBg?: (job: BgJob, args: readonly string[]) => boolean;
  now?: () => number;
  claudeHome?: string;
  /** the running bundle, spawned again for workers (§4.12) */
  bundlePath?: string | null;
}

/** Safety margin between the abort signal and the watchdog exit. */
const SIGNAL_MARGIN_MS = 80;

export function deadlineFor(verb: string): number {
  const known = DEADLINE_MS as Record<string, number>;
  return known[verb] ?? DEADLINE_MS.prompt;
}

/**
 * Build the runtime. `setDeadline` re-arms the abort signal (SessionStart
 * shortens it to 800 ms once stdin says `source: "compact"`).
 */
export function createRuntime(opts: RuntimeOptions): HookRuntime {
  const rawEnv = opts.env ?? process.env;
  const env = readEnv(rawEnv);
  const team = loadTeamConfig(env);
  const claudeHome = opts.claudeHome ?? join(homedir(), '.claude');
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let deadlineMs = opts.deadlineMs ?? deadlineFor(opts.verb);
  let timer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    const delay = Math.max(0, deadlineMs - SIGNAL_MARGIN_MS - (now() - startedAt));
    timer = setTimeout(() => controller.abort(), delay);
    timer.unref();
  };
  arm();
  const bundlePath = opts.bundlePath === undefined ? (process.argv[1] ?? null) : opts.bundlePath;
  const log = (message: string): void => debugLog(env.home, env.debug, opts.verb, message);
  const spawnBg =
    opts.spawnBg ??
    ((job: BgJob, args: readonly string[]): boolean => {
      // RELAY_NO_BG=1 keeps tests and debugging runs from forking workers.
      if (!bundlePath || rawEnv['RELAY_NO_BG'] === '1' || env.disable) return false;
      try {
        const child = spawn(process.execPath, ['--no-warnings', bundlePath, 'bg', job, ...args], {
          detached: true,
          stdio: 'ignore',
          env: { ...rawEnv, RELAY_BG: '1' },
          windowsHide: true,
        });
        child.on('error', () => undefined);
        child.unref();
        log(`spawned bg ${job} ${args.join(' ')}`);
        return true;
      } catch (err) {
        log(`spawn bg ${job} failed: ${String(err)}`);
        return false;
      }
    });
  const rt: HookRuntime = {
    verb: opts.verb,
    args: opts.args ?? [],
    env,
    home: env.home,
    team,
    pluginSha: resolvePluginSha(env, claudeHome),
    claudeHome,
    startedAt,
    get deadlineMs() {
      return deadlineMs;
    },
    signal: controller.signal,
    now,
    remainingMs() {
      return Math.max(0, deadlineMs - SIGNAL_MARGIN_MS - (now() - startedAt));
    },
    git: { ...realGit, ...(opts.git ?? {}) },
    fetch: opts.fetch,
    spawnBg,
    log,
    setDeadline(ms: number) {
      deadlineMs = ms;
      arm();
    },
  };
  return rt;
}

/** `--key value` pairs of a `bg` argument list (`bg prompt --session s1 --cwd /x`). */
export function parseFlags(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i += 1;
    } else out[a.slice(2)] = '1';
  }
  return out;
}
