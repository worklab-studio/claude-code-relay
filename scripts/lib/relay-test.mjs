/**
 * Shared helpers for the repeatable end-to-end runners (scripts/smoke/run.mjs and
 * scripts/e2e.mjs): start a throwaway hub on PGlite, build throwaway git repos,
 * replay the real hook bundle (packages/plugin/dist/hook.mjs) with a stdin
 * payload, talk to the hub with the §10.4 headers, and drive the MCP bundle
 * over stdio with a minimal JSON-RPC client. Plain Node >= 18, no dependencies.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOOK = join(ROOT, 'packages/plugin/dist/hook.mjs');
export const MCP = join(ROOT, 'packages/plugin/dist/mcp.mjs');
export const FIXTURES = join(ROOT, 'scripts/smoke');
export const TSX = join(ROOT, 'node_modules/.bin/tsx');

export const TEAM_TOKEN = 'demo';

// ---------------------------------------------------------------- misc

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Fresh canonical temp dir (RELAY_TEST_TMP > os.tmpdir()). */
export function tmpRoot(prefix) {
  const base = process.env.RELAY_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  return realpathSync(mkdtempSync(join(base, prefix)));
}

export function rmrf(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------- checks

export class Checker {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = [];
    this.warnings = [];
  }
  /** Record a check; returns the condition. */
  check(label, cond, detail) {
    if (cond) {
      this.passed += 1;
      console.log(`  ok   ${label}`);
    } else {
      this.failed.push(label + (detail ? ` — ${detail}` : ''));
      console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
    return Boolean(cond);
  }
  /** A check that aborts the run when it fails (later steps depend on it). */
  must(label, cond, detail) {
    if (!this.check(label, cond, detail)) throw new Error(`${this.name}: ${label}${detail ? ` — ${detail}` : ''}`);
  }
  warn(label) {
    this.warnings.push(label);
    console.log(`  warn ${label}`);
  }
  summary() {
    const total = this.passed + this.failed.length;
    console.log(`\n${this.name}: ${this.passed}/${total} checks passed${this.warnings.length ? `, ${this.warnings.length} warning(s)` : ''}`);
    for (const f of this.failed) console.log(`  FAILED: ${f}`);
    for (const w of this.warnings) console.log(`  warning: ${w}`);
    return this.failed.length === 0;
  }
}

// ---------------------------------------------------------------- git

export function git(cwd, args, env = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Author/committer env for a throwaway identity. */
export function authorEnv(name, email) {
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** Init a repo at `dir` from an existing tree (or an empty one), one commit by `email`. */
export function initRepo(dir, { name = 'Seed', email = 'seed@demo', message = 'init', origin = null } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', name]);
  git(dir, ['config', 'user.email', email]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return realpathSync(dir);
}

/** Bare origin + N clones with their own git identities (like scripts/demo.sh). */
export function makeOrigin(root, seedDir, devs) {
  const origin = join(root, 'origin.git');
  git(root, ['init', '-q', '--bare', origin]);
  git(seedDir, ['remote', 'add', 'origin', origin]);
  git(seedDir, ['push', '-q', 'origin', 'HEAD:main']);
  const clones = {};
  for (const d of devs) {
    const dir = join(root, `app-${d.handle}`);
    git(root, ['clone', '-q', origin, dir]);
    git(dir, ['config', 'user.name', d.name]);
    git(dir, ['config', 'user.email', d.email]);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['config', 'pull.rebase', 'false']);
    clones[d.handle] = realpathSync(dir);
  }
  return { origin, clones };
}

/** Copy examples/demo-repo into `dir` (the .relay.json is part of the fixture). */
export function copyDemoRepo(dir) {
  cpSync(join(ROOT, 'examples/demo-repo'), dir, { recursive: true });
  return dir;
}

/** The repo shape the scripts/smoke fixtures reference (billing.ts / invoices.tsx). */
export function writeSmokeTree(dir, relayJson) {
  mkdirSync(join(dir, 'packages/contracts/src'), { recursive: true });
  mkdirSync(join(dir, 'apps/app/src'), { recursive: true });
  mkdirSync(join(dir, 'apps/dashboard/src'), { recursive: true });
  mkdirSync(join(dir, 'prisma'), { recursive: true });
  writeFileSync(join(dir, 'packages/contracts/package.json'), JSON.stringify({ name: '@acme/contracts', version: '0.0.0', private: true }, null, 2) + '\n');
  writeFileSync(join(dir, 'packages/contracts/src/billing.ts'), 'export interface Invoice {\n  id: string\n  total: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n');
  writeFileSync(join(dir, 'apps/app/src/service.ts'), "import { createInvoice } from '@acme/contracts'\nexport const x = createInvoice\n");
  writeFileSync(join(dir, 'apps/dashboard/src/invoices.tsx'), "import type { Invoice } from '../../../packages/contracts/src/billing'\nexport const y: Invoice | null = null\n");
  writeFileSync(join(dir, 'prisma/schema.prisma'), 'model Invoice {\n  id    String @id\n  total Int\n}\n');
  writeFileSync(join(dir, 'README.md'), '# smoke\n');
  if (relayJson) writeFileSync(join(dir, '.relay.json'), JSON.stringify(relayJson, null, 2) + '\n');
}

// ---------------------------------------------------------------- hub

/** Something answers on 127.0.0.1:port (a wildcard/IPv6 listener too, which a bind test alone would miss). */
function portAnswers(port) {
  return new Promise((res) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      res(v);
    };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function portFree(port) {
  if (await portAnswers(port)) return false;
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

export async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 50; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${preferred}..${preferred + 49}`);
}

async function health(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${url}/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.db ? body : null;
  } catch {
    return null;
  }
}

/**
 * Start apps/api/scripts/dev.ts (the `pnpm dev` entry) on a fresh PGlite dir.
 * ANTHROPIC_API_KEY is stripped so handoffs stay heuristic and nothing leaves
 * the machine. Returns { url, port, stop, log }.
 */
export async function startHub({ dataDir, port = null, seed = true, env = {} } = {}) {
  const existing = process.env.RELAY_HUB;
  if (existing) {
    const h = await health(existing);
    if (!h) throw new Error(`RELAY_HUB=${existing} is not a Relay hub`);
    return { url: existing, port: new URL(existing).port, external: true, stop: async () => undefined, log: () => '' };
  }
  if (!existsSync(TSX)) throw new Error('node_modules/.bin/tsx missing: run pnpm install');
  const chosen = port ?? (await pickPort(Number(process.env.RELAY_TEST_PORT ?? 8787)));
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, '..', `hub-${chosen}.log`);
  const chunks = [];
  const childEnv = { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_PORT: String(chosen), RELAY_HOST: '127.0.0.1', RELAY_TEAM_TOKEN: TEAM_TOKEN, RELAY_ADMIN_TOKEN: 'demo-admin', ...(seed ? {} : { RELAY_NO_SEED: '1' }), ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.DATABASE_URL;
  const child = spawn(TSX, ['scripts/dev.ts'], { cwd: join(ROOT, 'apps/api'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => chunks.push(c.toString()));
  child.stderr.on('data', (c) => chunks.push(c.toString()));
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const url = `http://127.0.0.1:${chosen}`;
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (exited) break;
    if (await health(url)) {
      return {
        url,
        port: chosen,
        external: false,
        log: () => chunks.join(''),
        stop: async () => {
          if (exited) return;
          child.kill('SIGTERM');
          const t0 = Date.now();
          while (!exited && Date.now() - t0 < 8000) await sleep(100);
          if (!exited) child.kill('SIGKILL');
          try {
            writeFileSync(logPath, chunks.join(''));
          } catch {
            /* ignore */
          }
        },
      };
    }
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`hub did not come up on ${url}:\n${chunks.join('').slice(-2000)}`);
}

/** Hub request with the §10.4 headers. Returns { status, body, headers }. */
export async function hub(url, { dev, session = null, method = 'GET', path, query = {}, body = undefined, token = TEAM_TOKEN, client = 'cli' }) {
  const u = new URL(url + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const headers = { authorization: `Bearer ${token}`, 'x-relay-dev': dev, 'x-relay-client': client, 'x-relay-proto': '1', 'content-type': 'application/json' };
  if (session) headers['x-relay-session'] = session;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
  } finally {
    clearTimeout(t);
  }
}

/** Poll until `fn` returns a truthy value or the timeout passes (returns the last value). */
export async function waitFor(fn, { timeoutMs = 10_000, everyMs = 200 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  return last;
}

// ---------------------------------------------------------------- hooks

export function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

export function substitute(value, vars) {
  const text = JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (_m, k) => (k in vars ? vars[k] : `{{${k}}}`));
  return JSON.parse(text);
}

/**
 * Run `node dist/hook.mjs <args>` with `stdin` (string or object) and `env`
 * (PATH/HOME are filled in). Resolves { code, stdout, stderr, ms, json }.
 */
export function runHook(args, stdin, env, { cwd = undefined, bundle = HOOK } = {}) {
  const input = stdin === null ? null : typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--no-warnings', bundle, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.RELAY_HOME ?? process.env.HOME ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      let json = null;
      if (stdout.trim()) {
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
      }
      resolveRun({ code, stdout, stderr, ms: Date.now() - started, json });
    });
    child.on('error', () => resolveRun({ code: -1, stdout, stderr: stderr + '\nspawn failed', ms: Date.now() - started, json: null }));
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** hookSpecificOutput of a run (or null). */
export function hso(r) {
  return r.json && typeof r.json === 'object' && r.json.hookSpecificOutput && typeof r.json.hookSpecificOutput === 'object' ? r.json.hookSpecificOutput : null;
}

/** Outbox entries of a RELAY_HOME ({id, kind, endpoint, body}). */
export function listOutbox(home) {
  const dir = join(home, 'outbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(join(dir, f)))
    .filter((e) => e && typeof e === 'object');
}

export function readMeta(home, sessionId) {
  return readJson(join(home, 'sessions', sessionId, 'meta.json'));
}

export function hasMark(home, sessionId, kind, key = '') {
  const dir = join(home, 'sessions', sessionId, 'marks');
  if (!existsSync(dir)) return false;
  const name = key ? `${kind}.${key}` : kind;
  return readdirSync(dir).some((f) => f === name || (key && f.startsWith(name)));
}

export function listMarks(home, sessionId) {
  const dir = join(home, 'sessions', sessionId, 'marks');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Standard hook environment for one developer's "Claude Code" (see scripts/smoke/README.md). */
export function hookEnv({ home, hubUrl, dev, pid = process.pid, sessionId = null, extra = {} }) {
  return {
    RELAY_HOME: home,
    RELAY_HUB: hubUrl,
    RELAY_TOKEN: TEAM_TOKEN,
    RELAY_DEV: dev,
    CLAUDE_PID: String(pid),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}),
    RELAY_NO_BG: '1',
    RELAY_DEBUG: '1',
    ...extra,
  };
}

/** Stdin builders (docs/research/hooks.md); `base` = {session_id, cwd, transcript_path}. */
export const stdin = {
  sessionStart: (b, source = 'startup', extra = {}) => ({ ...b, hook_event_name: 'SessionStart', source, model: 'claude-opus-5', ...extra }),
  prompt: (b, prompt, extra = {}) => ({ ...b, hook_event_name: 'UserPromptSubmit', prompt, prompt_id: b.prompt_id ?? 'p-' + Math.random().toString(36).slice(2, 10), permission_mode: 'default', ...extra }),
  preEdit: (b, filePath, extra = {}) => ({
    ...b,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b', replace_all: false },
    tool_use_id: 'toolu_' + Math.random().toString(36).slice(2, 10),
    prompt_id: b.prompt_id ?? 'p1',
    permission_mode: 'default',
    ...extra,
  }),
  preRead: (b, filePath) => ({ ...b, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: filePath }, tool_use_id: 'toolu_read', prompt_id: 'p1', permission_mode: 'default' }),
  postEdit: (b, filePath, extra = {}) => ({
    ...b,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
    tool_response: { filePath, oldString: 'a', newString: 'b', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false },
    tool_use_id: 'toolu_' + Math.random().toString(36).slice(2, 10),
    duration_ms: 12,
    prompt_id: 'p1',
    permission_mode: 'acceptEdits',
    ...extra,
  }),
  postGit: (b, command, stdout = '') => ({
    ...b,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'git' },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
    tool_use_id: 'toolu_git',
    duration_ms: 140,
    prompt_id: 'p1',
    permission_mode: 'acceptEdits',
  }),
  stop: (b, message) => ({ ...b, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [], prompt_id: 'p1', permission_mode: 'acceptEdits' }),
  sessionEnd: (b, reason = 'prompt_input_exit') => ({ ...b, hook_event_name: 'SessionEnd', reason }),
};

// ---------------------------------------------------------------- MCP over stdio

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC, the transport
 * Claude Code uses for plugin servers). `env` should carry RELAY_HOME/HUB/
 * TOKEN/DEV; the server resolves the live session from current/<ppid>.json,
 * and ppid is this process.
 */
export function mcpClient({ env, cwd, bundle = MCP }) {
  const child = spawn(process.execPath, ['--no-warnings', bundle], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.RELAY_HOME ?? process.env.HOME ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  const stderr = [];
  child.stderr.on('data', (c) => stderr.push(c.toString()));
  child.stdout.on('data', (c) => {
    buffer += c.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) rej(new Error(`rpc ${msg.error.code}: ${msg.error.message}`));
        else res(msg.result);
      }
    }
  });
  const request = (method, params = {}, timeoutMs = 15_000) =>
    new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`rpc ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { res, rej, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  return {
    child,
    stderr: () => stderr.join(''),
    async initialize() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-e2e', version: '0' } });
      notify('notifications/initialized');
      return r;
    },
    listTools: () => request('tools/list'),
    /** Returns { text, json, isError } — the json block is parsed out of the text (```json fence) when present. */
    async call(name, args = {}) {
      const r = await request('tools/call', { name, arguments: args });
      const text = (r.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      let json = null;
      const m = text.match(/```json\n([\s\S]*?)\n```/);
      if (m) {
        try {
          json = JSON.parse(m[1]);
        } catch {
          json = null;
        }
      }
      return { text, json, isError: Boolean(r.isError), raw: r };
    },
    close: () =>
      new Promise((res) => {
        const done = () => res();
        child.once('exit', done);
        child.stdin.end();
        setTimeout(() => {
          child.kill('SIGINT');
          setTimeout(() => {
            child.kill('SIGKILL');
            done();
          }, 1500);
        }, 1500);
      }),
  };
}
