/**
 * Integration: spawns packages/plugin/dist/hook.mjs (the real bundle) with the
 * fixtures in scripts/smoke/*.json against a stub hub, then with the hub
 * unreachable and with a hub that stalls. Asserts §4.0 rules 1–3 on every run:
 * exit 0, stdout empty or one JSON object of the documented shape, wall time
 * under the verb's DEADLINE, fail-open and breaker behaviour.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEADLINE_MS, hasMark, listOutbox, readBreaker, readMeta, readSnapshot, refreshWantedAgeMs, sessionDir, type Snapshot } from '@relay/core';
import { T0, git, iso, makeChangeSet, makeHeat, makeRepo, makeSession, makeSnapshot, tmpDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const HOOK = join(ROOT, 'packages/plugin/dist/hook.mjs');
const FIXTURES = join(ROOT, 'scripts/smoke');
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';

interface Fixture {
  verb: string;
  env: Record<string, string>;
  stdin: Record<string, unknown>;
  expect: { exit: number; stdout: 'json' | 'none'; hookEventName?: string; permissionDecision?: string; maxMs?: number };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  json: Record<string, unknown> | null;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;
}

function substitute<T>(value: T, vars: Record<string, string>): T {
  const text = JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
  return JSON.parse(text) as T;
}

function runHook(args: string[], input: string | null, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--no-warnings', HOOK, ...args], { env: { PATH: process.env['PATH'] ?? '', HOME: env['RELAY_HOME'] ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => {
      let json: Record<string, unknown> | null = null;
      if (stdout.trim()) {
        try {
          json = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          json = null;
        }
      }
      resolve({ code, stdout, stderr, ms: Date.now() - started, json });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

interface StubHub {
  server: Server;
  url: string;
  requests: Array<{ method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> }>;
  mode: 'ok' | 'stall';
  close: () => Promise<void>;
}

function stubSnapshot(sessionId: string): Snapshot {
  const now = Date.now();
  return makeSnapshot(now, {
    me: { dev: 'deepak', sessionId },
    sessions: [makeSession('priya', { lastSeenAt: iso(now - 10_000), lastEditAt: iso(now - 20_000) }), makeSession('deepak', { id: sessionId, area: 'dashboard', branch: 'main' })],
    heat: [makeHeat('priya', 'packages/contracts/src/billing.ts', { at: iso(now - 20_000) })],
    inbox: [{ id: 'ntf_smoke', kind: 'note', from: 'priya', body: 'keep `status` — dashboard already consumes it', ref: null, at: iso(now - 60_000), noteKind: 'fyi' }],
    changeSets: [
      makeChangeSet('cs_smoke', ['apps/dashboard/src/invoices.tsx'], { at: iso(now - 30_000) }),
      // normal priority: not delivered by the prompt hook, only just-in-time on a dependent edit/read (§4.3 step 4)
      makeChangeSet('cs_normal', ['apps/dashboard/src/invoices.tsx'], { at: iso(now - 40_000), priority: 'normal', by: 'arjun', branch: 'feat/orders' }),
    ],
  });
}

async function startStub(): Promise<StubHub> {
  const hub: StubHub = { server: null as unknown as Server, url: '', requests: [], mode: 'ok', close: async () => undefined };
  hub.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      hub.requests.push({ method: req.method ?? '', path: req.url ?? '', body, headers: req.headers });
      if (hub.mode === 'stall') return; // never answers: budgets must expire client-side
      const sid = (req.headers['x-relay-session'] as string | undefined) ?? SESSION;
      const snapshot = stubSnapshot(sid);
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const path = (req.url ?? '').split('?')[0];
      if (path === '/v1/session/start') {
        const digest = `<relay-digest team="demo" project="acme-portal" repo="github.com/acme/app" dev="deepak" at="${new Date().toISOString()}" freshness="live" mode="${(body as { mode?: string })?.mode ?? 'full'}">\n## Team now\n- priya · app · feat/currency · working, last event ${iso(Date.now())}\n## Relay\nTools (mcp relay): status, who_is_on.\n</relay-digest>`;
        send(200, { digest, snapshot, minClient: 1 });
      } else if (path === '/v1/events') send(200, { snapshot, inbox: snapshot.inbox });
      else if (path === '/v1/snapshot') send(200, snapshot);
      else if (path === '/v1/session/end' || path === '/v1/depindex') send(200, { ok: true });
      else if (path === '/v1/ack') send(200, { changeSetId: 'cs_smoke', ackedAt: new Date().toISOString(), notifiedAuthor: false });
      else send(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((r) => hub.server.listen(0, '127.0.0.1', r));
  const addr = hub.server.address();
  hub.url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  hub.close = () =>
    new Promise<void>((r) => {
      hub.server.closeAllConnections?.();
      hub.server.close(() => r());
    });
  return hub;
}

const bundleMissing = !existsSync(HOOK);

describe.skipIf(bundleMissing)('dist/hook.mjs against a stub hub (fixtures in scripts/smoke)', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  let hub: StubHub;
  let env: Record<string, string>;
  let vars: Record<string, string>;

  beforeAll(async () => {
    const t = tmpDir('relay-int-');
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'), { email: 'deepak@acme.dev', name: 'Deepak', origin: 'git@github.com:acme/app.git', relayJson: { project: 'acme-portal', areas: { app: { paths: ['apps/app/**'] }, dashboard: { paths: ['apps/dashboard/**'] }, contracts: { paths: ['packages/contracts/**'], shared: true } } } });
    hub = await startStub();
    env = { RELAY_HOME: home, RELAY_HUB: hub.url, RELAY_TOKEN: 'rt_smoke', RELAY_DEV: 'deepak', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: SESSION, RELAY_NO_BG: '1', RELAY_DEBUG: '1' };
    vars = { REPO: repo, HOME: home, SESSION, HUB: hub.url };
  });
  afterAll(async () => {
    await hub.close();
    cleanup();
  });

  async function runFixture(name: string, extraEnv: Record<string, string> = {}): Promise<{ fx: Fixture; r: RunResult }> {
    const fx = substitute(loadFixture(name), vars);
    const r = await runHook([fx.verb], JSON.stringify(fx.stdin), { ...env, ...fx.env, ...extraEnv });
    expect(r.code, `${name}: exit code (stderr: ${r.stderr})`).toBe(fx.expect.exit);
    expect(r.stderr, `${name}: stderr must stay empty`).toBe('');
    const deadline = fx.expect.maxMs ?? (DEADLINE_MS as Record<string, number>)[fx.verb] ?? 2000;
    expect(r.ms, `${name}: wall time`).toBeLessThan(deadline + 400);
    if (r.stdout.trim()) {
      expect(r.json, `${name}: stdout must be one JSON object: ${r.stdout.slice(0, 200)}`).not.toBeNull();
      expect(r.stdout.length).toBeLessThanOrEqual(9000);
    }
    return { fx, r };
  }

  function expectShape(name: string, fx: Fixture, r: RunResult): void {
    if (fx.expect.stdout === 'none') {
      expect(r.stdout, `${name}: expected no stdout`).toBe('');
      return;
    }
    const hso = (r.json?.['hookSpecificOutput'] ?? null) as Record<string, unknown> | null;
    expect(hso, `${name}: hookSpecificOutput`).not.toBeNull();
    expect(hso?.['hookEventName']).toBe(fx.expect.hookEventName);
    if (fx.expect.permissionDecision) expect(hso?.['permissionDecision']).toBe(fx.expect.permissionDecision);
  }

  it('every fixture: exit 0, documented stdout shape, under the deadline', async () => {
    const { fx: s, r: start } = await runFixture('session-start');
    expectShape('session-start', s, start);
    const digest = String((start.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext']);
    expect(digest).toMatch(/^<relay-digest .*freshness="live"/);
    expect(hub.requests[0]).toMatchObject({ method: 'POST', path: '/v1/session/start' });
    expect(hub.requests[0]?.headers['authorization']).toBe('Bearer rt_smoke');
    expect(hub.requests[0]?.headers['x-relay-dev']).toBe('deepak');
    expect(hub.requests[0]?.headers['x-relay-proto']).toBe('1');
    const startBody = hub.requests[0]?.body as { session: { repo: { slug: string; config: unknown }; branch: string } };
    expect(startBody.session.repo.slug).toBe('github.com/acme/app');
    expect(startBody.session.branch).toBe('main');
    const meta = readMeta(sessionDir(home, SESSION))!;
    expect(meta.dev).toBe('deepak');
    expect(readSnapshot(home, meta.repoKey)).not.toBeNull();

    const { fx: p, r: prompt } = await runFixture('prompt');
    expectShape('prompt', p, prompt);
    const inbox = String((prompt.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext']);
    expect(inbox).toMatch(/^<relay-inbox at="/);
    expect(inbox).toContain('NOTE from priya');
    expect(inbox).toContain('IMPACT cs_smoke');
    expect(prompt.json?.['systemMessage']).toBe("Relay: 1 impact, 1 note (in Claude's context)");
    expect(prompt.ms).toBeLessThan(1000); // fresh cache: no network, ~50 ms typical (slack for a loaded CI box)
    expect(listOutbox(home).entries.map((e) => e.kind)).toEqual(['events']); // the prompt WAL entry for the worker

    const { fx: pe, r: preEdit } = await runFixture('pre-edit');
    expectShape('pre-edit', pe, preEdit);
    const hso = preEdit.json?.['hookSpecificOutput'] as Record<string, string>;
    expect(hso['permissionDecisionReason']).toMatch(/^Relay: priya is editing packages\/contracts\/src\/billing\.ts/);
    expect(hso['additionalContext']).toMatch(/^Relay at \d\d:\d\d:\d\dZ:/);
    expect(preEdit.ms).toBeLessThan(900);
    expect(hasMark(sessionDir(home, SESSION), 'asked', '')).toBe(false);

    // a second identical pre-edit is context only (asked mark), a Write on a dependent gets the JIT note
    const { r: preEdit2 } = await runFixture('pre-edit');
    expect((preEdit2.json?.['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBeUndefined();
    const { fx: pw, r: preWrite } = await runFixture('pre-edit-write');
    expectShape('pre-edit-write', pw, preWrite);
    const jit = String((preWrite.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext']);
    expect(jit).toContain('IMPACT cs_normal');
    expect(jit).not.toContain('cs_smoke'); // already delivered by the prompt hook
    expect((preWrite.json?.['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBeUndefined();

    const { fx: pr, r: preRead } = await runFixture('pre-read');
    expectShape('pre-read', pr, preRead); // cs_smoke was delivered by the prompt: nothing pending

    writeFileSync(join(repo, 'packages/contracts/src/billing.ts'), 'export interface Invoice {\n  id: string\n  amountDue: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n');
    const before = hub.requests.length;
    const { fx: po, r: postEdit } = await runFixture('post-edit');
    expectShape('post-edit', po, postEdit);
    const events = hub.requests.slice(before).find((q) => q.path === '/v1/events')?.body as { events: Array<{ type: string; symbols?: string[] }> };
    expect(events.events.map((e) => e.type)).toEqual(['edit', 'contract']);
    expect(events.events[1]?.symbols).toContain('Invoice');

    git(repo, 'commit', '-qam', 'contracts: rename Invoice.total to amountDue');
    const beforeGit = hub.requests.length;
    const { fx: pg, r: postGit } = await runFixture('post-git');
    expectShape('post-git', pg, postGit);
    const commitBody = hub.requests.slice(beforeGit).find((q) => q.path === '/v1/events')?.body as { events: Array<{ type: string; sha?: string }> };
    expect(commitBody.events.map((e) => e.type)).toEqual(['commit']);
    expect(commitBody.events[0]?.sha).toBe(git(repo, 'rev-parse', 'HEAD'));

    for (const name of ['task-created', 'task-completed', 'cwd']) {
      const { fx, r } = await runFixture(name);
      expectShape(name, fx, r);
      expect(r.ms).toBeLessThan(1200);
    }

    const beforeStop = hub.requests.length;
    const { fx: st, r: stop } = await runFixture('stop');
    expectShape('stop', st, stop);
    const stopBody = hub.requests.slice(beforeStop).find((q) => q.path === '/v1/events')?.body as { events: Array<{ type: string; draft?: { next: string[] } }> };
    const turn = stopBody.events.find((e) => e.type === 'turn_end');
    expect(turn?.draft?.next).toEqual(['Backfill legacy invoices', 'Update the API docs']);

    const { fx: rs, r: resume } = await runFixture('session-start-resume');
    expectShape('session-start-resume', rs, resume);
    const resumeBody = hub.requests[hub.requests.length - 1]?.body as { mode: string };
    expect(resumeBody.mode).toBe('delta');

    const { fx: cp, r: compact } = await runFixture('session-start-compact');
    expectShape('session-start-compact', cp, compact);
    expect(String((compact.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toMatch(/^<relay-digest mode="compact"/);
    expect(compact.ms).toBeLessThan(1100);

    const beforeEnd = hub.requests.length;
    const { fx: se, r: end } = await runFixture('session-end');
    expectShape('session-end', se, end);
    expect(end.ms).toBeLessThan(900);
    expect(hub.requests.length).toBe(beforeEnd); // no fetch inside the SessionEnd budget
    const endEntry = listOutbox(home).entries.find((e) => e.kind === 'session_end');
    expect(endEntry).toBeDefined();
    expect(hasMark(sessionDir(home, SESSION), 'ended')).toBe(true);

    // the detached worker path through the bundle: bg session-end posts the entry and deletes it
    const bg = await runHook(['bg', 'session-end', '--entry', endEntry!.id, '--session', SESSION, '--cwd', repo], null, { ...env, RELAY_BG: '1' });
    expect(bg.code).toBe(0);
    expect(bg.stdout).toBe('');
    expect(hub.requests[hub.requests.length - 1]).toMatchObject({ path: '/v1/session/end' });
    expect(listOutbox(home).entries.find((e) => e.kind === 'session_end')).toBeUndefined();
  }, 60_000);

  it('garbage stdin, unknown verbs and RELAY_DISABLE=1 are silent exit-0 no-ops', async () => {
    for (const [args, input] of [
      [['pre-edit'], 'not json'],
      [['pre-edit'], ''],
      [['pre-edit'], '{"session_id":1}'],
      [['nonsense'], '{}'],
      [[], '{}'],
    ] as Array<[string[], string]>) {
      const r = await runHook(args, input, env);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.ms).toBeLessThan(2500);
    }
    const fx = substitute(loadFixture('pre-edit'), vars);
    const r = await runHook([fx.verb], JSON.stringify(fx.stdin), { ...env, RELAY_DISABLE: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe.skipIf(bundleMissing)('dist/hook.mjs with the hub unreachable / stalling (fail-open, breaker rules)', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  let vars: Record<string, string>;

  beforeAll(() => {
    const t = tmpDir('relay-int-off-');
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'), { email: 'deepak@acme.dev', name: 'Deepak' });
    vars = { REPO: repo, HOME: home, SESSION, HUB: 'http://127.0.0.1:1' };
  });
  afterAll(() => cleanup());

  it('every verb exits 0 in time with connection refused; two worker failures open the breaker, sync verbs never do', async () => {
    const env = { RELAY_HOME: home, RELAY_HUB: 'http://127.0.0.1:1', RELAY_TOKEN: 'rt_smoke', RELAY_DEV: 'deepak', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', RELAY_NO_BG: '1', RELAY_DEBUG: '1' };
    const names = readdirSync(join(ROOT, 'scripts/smoke')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    expect(names.length).toBeGreaterThanOrEqual(12);
    // post-edit and stop are the two worker-role POSTs (post-git has no commit to report here)
    const order = ['session-start', 'prompt', 'pre-edit', 'pre-edit-write', 'pre-read', 'task-created', 'task-completed', 'cwd', 'session-start-compact', 'post-edit', 'stop', 'post-git', 'session-start-resume', 'post-edit', 'session-end'];
    for (const name of order) {
      const fx = substitute(loadFixture(name), vars);
      const r = await runHook([fx.verb], JSON.stringify(fx.stdin), { ...env, ...fx.env });
      expect(r.code, name).toBe(0);
      expect(r.stderr, name).toBe('');
      const deadline = fx.expect.maxMs ?? 2000;
      expect(r.ms, `${name} wall time`).toBeLessThan(deadline + 400);
      if (r.stdout.trim()) expect(r.json, name).not.toBeNull();
      if (name === 'session-start') {
        expect(String((r.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toMatch(/^<relay-digest offline="true"/);
        expect(readBreaker(home).open).toBe(false); // a sync-path failure never opens the breaker
      }
      if (name === 'prompt' || name === 'pre-edit') expect(r.stdout).toBe(''); // no snapshot: nothing to say, no decision
      if (name === 'stop') expect(readBreaker(home).open).toBe(true); // post-edit + stop: two consecutive worker failures
      if (name === 'session-start-resume') expect(String((r.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toMatch(/offline="true"/);
    }
    const kinds = listOutbox(home).entries.map((e) => e.kind).sort();
    expect(kinds).toContain('session_end');
    expect(kinds.filter((k) => k === 'events').length).toBeGreaterThanOrEqual(4); // prompt, tasks, cwd, post-edit, post-git, stop bodies wait for a drain
    const log = readFileSync(join(home, 'log/relay.log'), 'utf8');
    expect(log).toMatch(/POST \/v1\/events \(edit\) breaker in 0 ms/); // the second post-edit skipped the network while the breaker was open
    expect(log).toMatch(/session start skipped: breaker open/);
  }, 60_000);

  it('a stalling hub: session-start returns by its 3.5 s deadline, a prompt refresh by 2 s, and neither opens the breaker', async () => {
    const stall = await startStub();
    stall.mode = 'stall';
    try {
      const t = tmpDir('relay-int-stall-');
      const r2 = makeRepo(join(t.dir, 'repo'), { email: 'deepak@acme.dev' });
      const env = { RELAY_HOME: t.dir, RELAY_HUB: stall.url, RELAY_TOKEN: 'rt_smoke', RELAY_DEV: 'deepak', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', RELAY_NO_BG: '1', RELAY_SNAPSHOT_TTL_MS: '1' };
      const v = { REPO: r2, HOME: t.dir, SESSION, HUB: stall.url };
      const s = substitute(loadFixture('session-start'), v);
      const start = await runHook([s.verb], JSON.stringify(s.stdin), env);
      expect(start.code).toBe(0);
      expect(start.ms).toBeLessThan(3500 + 400);
      expect(start.ms).toBeGreaterThan(2500); // it really waited for the 3 s budget
      expect(String((start.json?.['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toContain('offline="true"');
      expect(readBreaker(t.dir).open).toBe(false);
      const p = substitute(loadFixture('prompt'), v);
      const prompt = await runHook([p.verb], JSON.stringify(p.stdin), env);
      expect(prompt.code).toBe(0);
      expect(prompt.ms).toBeLessThan(2000 + 400);
      expect(prompt.stdout).toBe('');
      expect(readBreaker(t.dir).open).toBe(false);
      expect(refreshWantedAgeMs(t.dir)).not.toBeNull(); // the timeout asked the next worker to refresh
      t.cleanup();
    } finally {
      await stall.close();
    }
  }, 30_000);
});

// keep the unused helpers referenced for future fixtures
void mkdirSync;
void T0;
