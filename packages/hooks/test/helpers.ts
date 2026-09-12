/**
 * Test helpers for the hook verbs: temp $RELAY_HOME, throwaway git repos,
 * seeded meta.json, a recording fake fetch and a runtime with injected deps.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSessionDir,
  realpathBestEffort,
  repoKey,
  writeMeta,
  writeSnapshot,
  type BgJob,
  type SessionMeta,
  type Snapshot,
} from '@relay/core';
import { createRuntime, type GitApi, type HookRuntime, type RuntimeOptions } from '../src/runtime.js';

export { T0, iso, makeChangeSet, makeHeat, makeSession, makeSnapshot } from '../../core/test/fixtures.js';

export function tmpDir(prefix = 'relay-hooks-'): { dir: string; cleanup: () => void } {
  const base = process.env['RELAY_TEST_TMP'] ?? tmpdir();
  const dir = mkdtempSync(join(base, prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** A repo with one commit, a contracts package and an app file, authored by `email`. */
export function makeRepo(root: string, opts: { email?: string; name?: string; origin?: string; relayJson?: unknown } = {}): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', opts.email ?? 'priya@acme.dev');
  git(root, 'config', 'user.name', opts.name ?? 'Priya');
  git(root, 'config', 'commit.gpgsign', 'false');
  if (opts.origin) git(root, 'remote', 'add', 'origin', opts.origin);
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true });
  mkdirSync(join(root, 'apps/app/src'), { recursive: true });
  mkdirSync(join(root, 'apps/dashboard/src'), { recursive: true });
  writeFileSync(join(root, 'packages/contracts/package.json'), JSON.stringify({ name: '@acme/contracts' }));
  writeFileSync(join(root, 'packages/contracts/src/billing.ts'), 'export interface Invoice {\n  id: string\n  total: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n');
  writeFileSync(join(root, 'apps/app/src/service.ts'), "import { createInvoice } from '@acme/contracts'\nexport const x = createInvoice\n");
  writeFileSync(join(root, 'apps/dashboard/src/invoices.tsx'), "import type { Invoice } from '../../../packages/contracts/src/billing'\nexport const y: Invoice | null = null\n");
  writeFileSync(join(root, 'README.md'), '# demo\n');
  if (opts.relayJson !== undefined) writeFileSync(join(root, '.relay.json'), JSON.stringify(opts.relayJson));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return realpathBestEffort(root);
}

export interface SeedMetaOptions {
  dev?: string;
  branch?: string;
  slug?: string;
  startSha?: string | null;
  lastStopSha?: string | null;
  lastStopAt?: string | null;
  gitEmails?: string[];
  gitEmail?: string | null;
  worktree?: string | null;
  startedAt?: string;
}

/** Write sessions/<sid>/meta.json so sync verbs need no git (§4.0 rule 10 short-circuit). */
export function seedMeta(home: string, sessionId: string, repoRoot: string, opts: SeedMetaOptions = {}): SessionMeta {
  const slug = opts.slug ?? 'github.com/acme/app';
  const meta: SessionMeta = {
    v: 1,
    sessionId,
    dev: opts.dev ?? 'deepak',
    identitySource: 'env',
    repo: slug,
    project: 'acme-portal',
    repoKey: repoKey(slug),
    repoRoot,
    cwd: repoRoot,
    branch: opts.branch ?? 'feat/dashboard',
    worktree: opts.worktree ?? null,
    startSha: opts.startSha === undefined ? 'a'.repeat(40) : opts.startSha,
    lastStopSha: opts.lastStopSha ?? null,
    lastStopAt: opts.lastStopAt ?? null,
    client: 'cli',
    host: 'mac',
    pid: 4242,
    startedAt: opts.startedAt ?? new Date(Date.now() - 60_000).toISOString(),
    source: 'startup',
    gitEmail: opts.gitEmail === undefined ? 'deepak@acme.dev' : opts.gitEmail,
    gitEmails: opts.gitEmails ?? ['deepak@acme.dev'],
    configHash: null,
    model: null,
    pluginSha: null,
  };
  const dir = ensureSessionDir(home, sessionId);
  writeMeta(dir, meta);
  return meta;
}

export function seedSnapshot(home: string, meta: Pick<SessionMeta, 'repoKey' | 'dev'>, snapshot: Snapshot, fetchedAtMs: number = Date.now()): void {
  writeSnapshot(home, meta.repoKey, snapshot, { now: fetchedAtMs, myDev: meta.dev });
}

export interface FakeFetchCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
  /** route handler: return a Response-ish {status, body}; default 200 {snapshot} */
  handle: (call: FakeFetchCall) => { status?: number; body?: unknown; delayMs?: number; headers?: Record<string, string> } | 'network-error';
}

export function fakeFetch(handle?: FakeFetch['handle']): FakeFetch {
  const state: FakeFetch = {
    calls: [],
    handle: handle ?? (() => ({ status: 200, body: { ok: true } })),
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(url);
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const call: FakeFetchCall = { method: init?.method ?? 'GET', path: u.pathname + u.search, body, headers };
      state.calls.push(call);
      const r = state.handle(call);
      if (r === 'network-error') throw new TypeError('fetch failed');
      if (r.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, r.delayMs);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
    }) as typeof fetch,
  };
  return state;
}

export interface TestRuntime {
  rt: HookRuntime;
  spawned: Array<{ job: BgJob; args: string[] }>;
  ff: FakeFetch;
}

/** Runtime with a temp home, a fake hub and a recording spawnBg. */
export function makeRuntime(home: string, verb: string, opts: { env?: Record<string, string>; git?: Partial<GitApi>; handle?: FakeFetch['handle']; now?: () => number; deadlineMs?: number; args?: string[]; claudeHome?: string } = {}): TestRuntime {
  const spawned: Array<{ job: BgJob; args: string[] }> = [];
  const ff = fakeFetch(opts.handle);
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    USER: 'tester',
    RELAY_HOME: home,
    RELAY_HUB: 'http://hub.test',
    RELAY_TOKEN: 'rt_test',
    RELAY_DEV: 'deepak',
    CLAUDE_PID: '4242',
    ...(opts.env ?? {}),
  };
  const ro: RuntimeOptions = {
    verb,
    args: opts.args ?? [],
    env,
    git: opts.git,
    fetch: ff.fetch,
    spawnBg: (job, args) => {
      spawned.push({ job, args: [...args] });
      return true;
    },
    now: opts.now,
    deadlineMs: opts.deadlineMs,
    claudeHome: opts.claudeHome ?? join(home, '.claude'),
    bundlePath: null,
  };
  return { rt: createRuntime(ro), spawned, ff };
}

/** Minimal hook stdin builders (docs/research/hooks.md §4). */
export const stdin = {
  sessionStart: (sessionId: string, cwd: string, source = 'startup', extra: Record<string, unknown> = {}) =>
    ({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd, hook_event_name: 'SessionStart', source, ...extra }) as never,
  prompt: (sessionId: string, cwd: string, prompt: string, extra: Record<string, unknown> = {}) =>
    ({ session_id: sessionId, prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt, ...extra }) as never,
  preEdit: (sessionId: string, cwd: string, filePath: string, extra: Record<string, unknown> = {}) =>
    ({ session_id: sessionId, prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' }, tool_use_id: 'toolu_01', ...extra }) as never,
  preRead: (sessionId: string, cwd: string, filePath: string) =>
    ({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: filePath }, tool_use_id: 'toolu_02' }) as never,
  postEdit: (sessionId: string, cwd: string, filePath: string, tool = 'Edit') =>
    ({ session_id: sessionId, prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: filePath }, tool_response: { filePath, type: 'update' }, tool_use_id: 'toolu_01', duration_ms: 12 }) as never,
  postGit: (sessionId: string, cwd: string, command: string) =>
    ({ session_id: sessionId, prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false }, tool_use_id: 'toolu_03' }) as never,
  task: (sessionId: string, cwd: string, event: 'TaskCreated' | 'TaskCompleted', id: string, subject: string) =>
    ({ session_id: sessionId, prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd, hook_event_name: event, task_id: id, task_subject: subject, task_description: 'desc' }) as never,
  cwd: (sessionId: string, oldCwd: string, newCwd: string) =>
    ({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd: newCwd, hook_event_name: 'CwdChanged', old_cwd: oldCwd, new_cwd: newCwd }) as never,
  stop: (sessionId: string, cwd: string, message: string) =>
    ({ session_id: sessionId, prompt_id: 'p1', transcript_path: '/tmp/t.jsonl', cwd, permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [] }) as never,
  sessionEnd: (sessionId: string, cwd: string, reason = 'prompt_input_exit') =>
    ({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd, hook_event_name: 'SessionEnd', reason }) as never,
};
