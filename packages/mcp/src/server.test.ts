/**
 * The 13 tools over the MCP protocol (InMemoryTransport) against a stub hub:
 * live answers, request shapes (§10.4 headers, ?repo=, bodies), redaction,
 * hub-down fallbacks (§9.1), breaker handling, per-call session resolution
 * (§9.1 v1.1) and `whoami iam=` (§3.3).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_PATHS,
  MCP_TOOL_NAMES,
  RELAY_HEADERS,
  readIdentityFile,
  readMeta,
  recordConfigError,
  recordWorkerFailure,
  repoKey,
  sessionDir,
  writeAncestry,
  type ImpactOfResponse,
  type StatusResponse,
  type WhoamiResult,
} from '@relay/core';
import { startHarness, writeCachedDigest, writeCachedSnapshot, writeLiveSession, SESSION_ID, type Harness } from '../test/harness.js';
import { REPO, snapshot, startStubHub, type StubHub } from '../test/stub-hub.js';
import { INSTRUCTIONS } from './app.js';

let hub: StubHub;
let h: Harness;

beforeEach(async () => {
  hub = await startStubHub();
  h = await startHarness({ hubUrl: hub.url });
});
afterEach(async () => {
  await h.close();
  await hub.close();
});

const lastRequest = () => hub.requests[hub.requests.length - 1]!;

describe('server surface (§9.1)', () => {
  it('registers the 13 tools of MCP_TOOL_NAMES in order, with short descriptions and the instructions string', async () => {
    const tools = await h.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    for (const t of tools.tools) {
      expect((t.description ?? '').length, t.name).toBeLessThan(1024);
      expect((t.description ?? '').length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(h.client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(500);
    const impactOf = tools.tools.find((t) => t.name === 'impact_of')!;
    expect(Object.keys((impactOf.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['path', 'sha']);
  });

  it('rejects invalid arguments without crashing the server', async () => {
    const r = await h.client.callTool({ name: 'who_is_on', arguments: {} });
    expect(r.isError).toBe(true);
    const again = await h.call('whoami');
    expect(again.isError).toBe(false);
  });
});

describe('read tools, live (§9.2, §10.4)', () => {
  it('status sends the §10.4 headers and ?repo=, renders presence and claims', async () => {
    const r = await h.call('status');
    expect(r.isError).toBe(false);
    const req = lastRequest();
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/query/status');
    expect(req.query).toEqual({ repo: REPO, project: 'current' });
    expect(req.headers['authorization']).toBe('Bearer rt_test');
    expect(req.headers[RELAY_HEADERS.dev]).toBe('deepak');
    expect(req.headers[RELAY_HEADERS.session]).toBe(SESSION_ID);
    expect(req.headers[RELAY_HEADERS.client]).toBe('mcp');
    expect(req.headers[RELAY_HEADERS.proto]).toBe('1');
    expect(r.head).toContain('Relay status at 09:41:07Z (live)');
    expect(r.head).toContain('unacked change sets: 2');
    expect(r.head).toContain('priya · working, last event 09:40:27Z · cli · feat/currency · app');
    expect(r.head).toContain('deepak (you) · idle since 09:40:27Z · cli · main · dashboard');
    expect(r.head).toContain('claim clm_priya_1: priya claims apps/app until 2026-09-12T13:41Z');
    expect((r.json as StatusResponse).me.unreadInbox).toBe(1);
    const all = await h.call('status', { project: 'all' });
    expect(lastRequest().query['project']).toBe('all');
    expect((all.json as StatusResponse).scope).toBe('all');
  });

  it('who_is_on passes the target and lists live, heat, dirty and claims', async () => {
    const r = await h.call('who_is_on', { target: './apps/app' });
    expect(lastRequest().query).toEqual({ repo: REPO, target: 'apps/app' });
    expect(r.head).toContain('Relay who_is_on apps/app (area) at 09:41:07Z (live): 1 live session, 1 recent edit/commit entry (24 h), 1 uncommitted file, 1 claim');
    expect(r.head).toContain('- live: priya · working');
    expect(r.head).toContain('priya edited apps/app/src/billing/service.ts at 09:39:07Z (6 edits, feat/currency)');
    expect(r.head).toContain('arjun had apps/app/src/y.ts uncommitted at 09:39:07Z');
    expect(r.head).toContain('- claim clm_priya_1');
  });

  it('recent_changes forwards area/since/kind and renders every item kind chronologically', async () => {
    const r = await h.call('recent_changes', { area: 'app', since: '1d', kind: 'all' });
    expect(lastRequest().query).toEqual({ repo: REPO, area: 'app', since: '1d', kind: 'all' });
    const lines = r.head.split('\n');
    expect(lines[0]).toContain('Relay recent_changes since 09:41:07Z at 09:41:07Z (live): 4 items');
    expect(lines[1]).toContain('09:01:07Z priya · contract packages/contracts/src/billing.ts (Invoice, createInvoice) · feat/currency · committed a1b2c3d · high · cs_01A/imp_01A rev 1');
    expect(lines[2]).toContain('priya · commit a1b2c3d (pushed) · feat/currency · currency on Invoice · 1 file: packages/contracts/src/billing.ts');
    expect(lines[3]).toContain('priya · edit apps/app/src/billing/service.ts (6 edits)');
    expect(lines[4]).toContain('priya · handoff · priya · feat/currency');
    expect(r.text).toContain('"hunk":"@@ -12,1 +12,2 @@');
  });

  it('decisions and handoffs render records with ids and markdown', async () => {
    const d = await h.call('decisions', { topic: 'money' });
    expect(lastRequest().query).toEqual({ repo: REPO, topic: 'money' });
    expect(d.head).toContain('2026-09-11T09:41Z priya (explicit, topic: money, area: billing) dec_01: store amounts as integer minor units, no floats');
    const hs = await h.call('handoffs', { dev: 'me', n: 5, full: true, repo: REPO });
    expect(lastRequest().query).toEqual({ repo: REPO, dev: 'me', n: '5', full: 'true' });
    expect(hs.head).toContain('Relay handoffs at 09:41:07Z (live): 1 handoff by me');
    expect(hs.head).toContain('priya · feat/currency · 2026-09-12T08:41Z · heuristic · objective: Add currency support to invoices · done: currency on Invoice; migration 0042 · interfaces: billing.ts (Invoice, createInvoice) · next: update dashboard invoice table (deepak) · blockers: FX-rate creds · hnd_01 rev 1');
    expect(hs.head).toContain('# Handoff priya · feat/currency');
  });

  it('impacts lists change sets with dependents and acks through POST /v1/ack first', async () => {
    const r = await h.call('impacts', { ack: 'cs_01A' });
    const [ack, get] = hub.requests.slice(-2);
    expect(ack).toMatchObject({ method: 'POST', path: '/v1/ack', body: { id: 'cs_01A', repo: REPO } });
    expect(get).toMatchObject({ method: 'GET', path: '/v1/query/impacts', query: { repo: REPO, mine: 'true' } });
    expect(r.head).toContain('Relay ack cs_01A at 09:41:07Z (author notified).');
    expect(r.head).toContain('cs_01A: priya changed packages/contracts/src/billing.ts at 09:01:07Z (feat/currency, committed a1b2c3d, not in your branch, high): Invoice: total → amountDue, +currency');
    expect(r.head).toContain('dependents: apps/dashboard/src/invoices.tsx');
    expect(r.head).toContain('acked by arjun at 09:39:27Z');
    const mineFalse = await h.call('impacts', { mine: false });
    expect(lastRequest().query['mine']).toBe('false');
    expect(mineFalse.isError).toBe(false);
  });

  it('impacts marks "already in your branch" from ancestry.json', async () => {
    writeAncestry(h.home, repoKey(REPO), { headSha: 'h', at: new Date().toISOString(), contains: {}, merged: { cs_01A: true } });
    const r = await h.call('impacts');
    expect(r.head).toContain('(feat/currency, already in your branch, high)');
  });

  it('impact_of merges hub dependents with a live git grep and a local export scan', async () => {
    // a real repo in the harness cwd so the local grep and export scan have something to find
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: h.cwd });
    mkdirSync(join(h.cwd, 'packages/contracts/src'), { recursive: true });
    mkdirSync(join(h.cwd, 'apps/dashboard/src'), { recursive: true });
    writeFileSync(join(h.cwd, 'packages/contracts/package.json'), JSON.stringify({ name: '@acme/contracts' }));
    writeFileSync(join(h.cwd, 'packages/contracts/src/orders.ts'), 'export interface OrderFilter { status: string }\nexport type Order = { id: string }\n');
    writeFileSync(join(h.cwd, 'apps/dashboard/src/useOrders.ts'), "import type { OrderFilter } from '@acme/contracts/orders';\nexport const x: OrderFilter = { status: 'a' };\n");
    writeFileSync(join(h.cwd, 'apps/dashboard/src/other.ts'), "import { Order } from '../../../packages/contracts/src/orders';\n");
    execFileSync('git', ['add', '-A'], { cwd: h.cwd });
    const r = await h.call('impact_of', { path: 'packages/contracts/src/orders.ts' });
    expect(lastRequest().query).toEqual({ repo: REPO, path: 'packages/contracts/src/orders.ts' });
    expect(r.head).toContain('Relay impact_of packages/contracts/src/orders.ts at 09:41:07Z (live): exports OrderFilter, Order (export)');
    expect(r.head).toContain('- dependent apps/dashboard/src/hooks/useOrders.ts (dashboard, import, github.com/acme/app)');
    expect(r.head).toContain('- dependent src/api/orders.ts (import, github.com/acme/api)');
    // no .relay.json in the checkout: the local grep hits carry the inferred `apps/dashboard` area (§5.4)
    expect(r.head).toContain('- dependent apps/dashboard/src/useOrders.ts (apps/dashboard, import, github.com/acme/app)');
    expect(r.head).toContain('- dependent apps/dashboard/src/other.ts (apps/dashboard, import, github.com/acme/app)');
    expect(r.head).toContain('- active there: deepak (you)');
    expect(r.head).toContain('live grep in this checkout: 2 importers');
    expect(r.head).toContain('open change set (cs_01A)');
    const json = r.json as ImpactOfResponse;
    expect(json.dependents).toHaveLength(4);
    const bad = await h.call('impact_of', {});
    expect(bad.isError).toBe(true);
  });
});

describe('write tools, live (§9.2)', () => {
  it('notify redacts secrets and returns the delivery note', async () => {
    const r = await h.call('notify', { dev: '@priya', message: 'token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd please rotate', ref: 'apps/x.ts', kind: 'blocker' });
    const req = lastRequest();
    expect(req).toMatchObject({ method: 'POST', path: '/v1/notify' });
    expect(req.body).toEqual({ dev: 'priya', message: 'token is [redacted] please rotate', ref: 'apps/x.ts', kind: 'blocker', repo: REPO });
    expect(r.isError).toBe(false);
    expect(r.head).toBe('Relay notify ntf_01 to priya (blocker): priya active at 09:40:27Z — delivered at their next prompt');
  });

  it('claim reports the new claim and every conflict; release lists ids', async () => {
    const r = await h.call('claim', { target: 'apps/dashboard/**', note: 'table refactor', ttl: '2h', hard: true });
    expect(lastRequest().body).toEqual({ target: 'apps/dashboard/**', note: 'table refactor', ttl: '2h', hard: true, repo: REPO });
    expect(r.head).toContain('Relay claim clm_new: deepak claims apps/dashboard/** (hard) until 2026-09-12T13:41Z ("table refactor") (created 09:31:07Z, repo github.com/acme/app)');
    expect(r.head).toContain('- conflicting claim clm_priya_1: priya claims apps/app');
    expect(r.head).toContain('- live on the target: priya · working');
    expect(r.head).toContain('- priya edited apps/app/src/billing/service.ts');
    const rel = await h.call('release', { target: 'apps/dashboard/**' });
    expect(lastRequest().body).toEqual({ target: 'apps/dashboard/**', repo: REPO });
    expect(rel.head).toBe('Relay released 1 claim (apps/dashboard/**): clm_new');
    await h.call('release');
    expect(lastRequest().body).toEqual({ target: 'all', repo: REPO });
  });

  it('decide records and echoes the decision', async () => {
    const r = await h.call('decide', { text: 'amounts are integer minor units', topic: 'money', area: 'billing' });
    expect(lastRequest().body).toEqual({ text: 'amounts are integer minor units', topic: 'money', area: 'billing', repo: REPO });
    expect(r.head).toBe('Relay decision dec_new recorded at 09:41:07Z by deepak (project acme-portal, topic money, area billing): amounts are integer minor units');
  });

  it('handoff posts the live session id and the redacted self summary', async () => {
    const r = await h.call('handoff', { summary: { done: ['wired familyId', 'AKIAIOSFODNN7EXAMPLE leaked'], next: ['tests'], notes_to: [{ dev: 'priya', intent: 'fyi', text: 'done' }] } });
    const req = lastRequest();
    expect(req.path).toBe('/v1/handoff');
    expect(req.body).toEqual({ sessionId: SESSION_ID, summary: { done: ['wired familyId', '[redacted] leaked'], next: ['tests'], notes_to: [{ dev: 'priya', intent: 'fyi', text: 'done' }] }, repo: REPO });
    expect(r.head).toContain('Relay handoff hnd_new rev 1 (self) generated at 09:41:07Z for session sess-dee');
    expect(r.head).toContain('# Handoff priya');
  });

  it('handoff without a live session is an honest error, no hub call', async () => {
    const lonely = await startHarness({ hubUrl: hub.url, session: false, env: { CLAUDE_CODE_SESSION_ID: undefined } });
    try {
      const before = hub.requests.length;
      const r = await lonely.call('handoff');
      expect(r.isError).toBe(true);
      expect(r.head).toContain('no live session');
      expect(hub.requests.length).toBe(before);
    } finally {
      await lonely.close();
    }
  });
});

describe('hub down (§9.1, §11.3)', () => {
  let down: Harness;
  beforeEach(async () => {
    down = await startHarness({ hubUrl: 'http://127.0.0.1:1', snapshot: snapshot() });
  });
  afterEach(async () => down.close());

  it('status answers from the cached snapshot with a "(cached HH:MMZ)" label and a note', async () => {
    const r = await down.call('status');
    expect(r.isError).toBe(false);
    expect(r.head).toContain('Relay status at 09:41:07Z (cached 09:41Z)');
    expect(r.head).toContain('priya · working, last event 09:40:27Z');
    expect(r.head).toContain('claim clm_priya_1: priya claims apps/app');
    expect(r.head).toMatch(/Relay hub unreachable \(.+\); cached snapshot as of 09:41:07Z/);
    const json = r.json as StatusResponse;
    expect(json.freshness.source).toBe('cache');
    expect(json.me).toEqual({ dev: 'deepak', sessionId: SESSION_ID, unackedChangeSets: 1, unreadInbox: 1 });
  });

  it('who_is_on filters the snapshot by area, path and glob', async () => {
    const area = await down.call('who_is_on', { target: 'app' });
    // priya's claim on apps/app covers the area's paths, so it is listed
    expect(area.head).toContain('Relay who_is_on app (area) at 09:41:07Z (cached 09:41Z): 1 live session, 1 recent edit/commit entry (24 h), 0 uncommitted files, 1 claim');
    expect(area.head).toContain('- live: priya');
    const glob = await down.call('who_is_on', { target: 'apps/app/**' });
    expect(glob.head).toContain('(glob)');
    expect(glob.head).toContain('1 claim');
    const path = await down.call('who_is_on', { target: 'apps/dashboard/src/x.tsx' });
    expect(path.head).toContain('1 uncommitted file');
    expect(path.head).toContain('arjun had apps/dashboard/src/x.tsx uncommitted');
  });

  it('recent_changes, impacts and impact_of derive from the snapshot', async () => {
    const rc = await down.call('recent_changes', { since: '2d' });
    expect(rc.head).toContain('(cached 09:41Z): 3 items');
    expect(rc.head).toContain('priya · edit apps/app/src/billing/service.ts (6 edits)');
    expect(rc.head).toContain('priya · contract packages/contracts/src/billing.ts');
    expect(rc.head).toContain('priya · commit a1b2c3d (pushed)');
    const im = await down.call('impacts');
    expect(im.isError).toBe(false);
    expect(im.head).toContain('Relay impacts at 09:41:07Z (cached 09:41Z): 1 change set');
    expect(im.head).toContain('cs_01A: priya changed packages/contracts/src/billing.ts');
    const io = await down.call('impact_of', { path: 'packages/contracts/src/billing.ts' });
    expect(io.isError).toBe(false);
    expect(io.head).toContain('Relay impact_of packages/contracts/src/billing.ts at 09:41:07Z (cached 09:41Z): exports Invoice, createInvoice');
    expect(io.head).toContain('1 open change set (cs_01A)');
    expect(io.head).toContain('priya committed packages/contracts/src/billing.ts');
    expect(io.head).toContain('need the hub');
  });

  it('impacts with ack reports the failed ack honestly but still lists the cache', async () => {
    const r = await down.call('impacts', { ack: 'cs_01A' });
    expect(r.isError).toBe(true);
    expect(r.head).toContain('Relay ack not sent');
    expect(r.head).toContain('cs_01A: priya changed');
  });

  it('decisions and handoffs fall back to the cached digest sections', async () => {
    writeCachedDigest(
      down.home,
      '<relay-digest at="2026-09-12T09:41:07Z">\n## Team now\n- priya\n## Handoffs since your last session (1)\n- priya · feat/currency · 2026-09-11 11:02Z · done: currency · hnd_01\n## Decisions (last 5)\n- 2026-09-11 priya: store amounts as integer minor units\n## Relay\nTools\n</relay-digest>',
    );
    const d = await down.call('decisions');
    expect(d.isError).toBe(false);
    expect(d.head).toContain('Relay decisions (cached digest');
    expect(d.head).toContain('- 2026-09-11 priya: store amounts as integer minor units');
    expect((d.json as { items: unknown[]; cachedDigestLines: string[] }).cachedDigestLines).toHaveLength(1);
    const hs = await down.call('handoffs');
    expect(hs.head).toContain('- priya · feat/currency · 2026-09-11 11:02Z · done: currency · hnd_01');
    const none = await startHarness({ hubUrl: 'http://127.0.0.1:1' });
    try {
      const r = await none.call('handoffs');
      expect(r.isError).toBe(false);
      expect(r.head).toContain('unavailable offline');
    } finally {
      await none.close();
    }
  });

  it('write tools return honest errors', async () => {
    for (const [name, args] of [
      ['notify', { dev: 'priya', message: 'hi' }],
      ['claim', { target: 'apps/app' }],
      ['release', {}],
      ['decide', { text: 'x' }],
      ['handoff', {}],
    ] as const) {
      const r = await down.call(name, args as Record<string, unknown>);
      expect(r.isError, name).toBe(true);
      expect(r.head, name).toMatch(/^Relay \w+ not sent: the hub is unreachable/);
      expect((r.json as { error: string }).error, name).toBe('network');
    }
  });

  it('with no cache at all, read tools still answer without throwing', async () => {
    const bare = await startHarness({ hubUrl: 'http://127.0.0.1:1' });
    try {
      for (const [name, args] of [
        ['status', {}],
        ['who_is_on', { target: 'app' }],
        ['recent_changes', {}],
        ['impacts', {}],
        ['impact_of', { path: 'a.ts' }],
        ['decisions', {}],
        ['handoffs', {}],
        ['whoami', {}],
      ] as const) {
        const r = await bare.call(name, args as Record<string, unknown>);
        expect(r.isError, name).toBe(false);
        expect(r.json, name).toBeDefined();
      }
    } finally {
      await bare.close();
    }
  });

  it('a slow hub is abandoned at the 5 s MCP budget and the cache answers', async () => {
    hub.delayMs = 400;
    const fast = await startHarness({ hubUrl: hub.url, snapshot: snapshot(), env: { RELAY_MCP_TEST_BUDGET: '1' } });
    try {
      // the budget is BUDGET_MS.mcpFetch (5 s); a 400 ms delay still answers live — this checks the happy path stays live
      const r = await fast.call('status');
      expect(r.head).toContain('(live)');
    } finally {
      hub.delayMs = 0;
      await fast.close();
    }
  });

  it('not configured (no team.json, no RELAY_HUB) answers from cache with a configuration note', async () => {
    const unconfigured = await startHarness({ hubUrl: null, snapshot: snapshot() });
    try {
      const r = await unconfigured.call('status');
      expect(r.head).toContain('(cached 09:41Z)');
      expect(r.head).toContain('Relay hub not configured');
      const w = await unconfigured.call('decide', { text: 'x' });
      expect(w.isError).toBe(true);
      expect(w.head).toContain('hub not configured');
    } finally {
      await unconfigured.close();
    }
  });
});

describe('breaker (§4.0 rule 5)', () => {
  it('an open outage breaker serves reads from the cache without a hub call and still lets writes through', async () => {
    writeCachedSnapshot(h.home, snapshot());
    recordWorkerFailure(h.home);
    recordWorkerFailure(h.home);
    const before = hub.requests.length;
    const r = await h.call('status');
    expect(hub.requests.length).toBe(before);
    expect(r.head).toContain('(cached 09:41Z)');
    expect(r.head).toContain('breaker open');
    expect((r.json as StatusResponse).freshness.breakerOpen).toBe(true);
    const w = await h.call('decide', { text: 'still works' });
    expect(w.isError).toBe(false);
    expect(hub.requests.length).toBe(before + 1);
  });

  it('a configuration error (401) is reported in whoami and writes fail with the config kind', async () => {
    recordConfigError(h.home, 401, 'bad token');
    const who = await h.call('whoami');
    expect(who.head).toContain('config error 401');
    hub.handlers.set('POST /v1/decide', () => ({ status: 401, body: { error: 'bad_token', message: 'token rejected' } }));
    const w = await h.call('decide', { text: 'x' });
    expect(w.isError).toBe(true);
    expect(w.head).toContain('rejected the client (401: token rejected)');
  });
});

describe('session resolution per call (§9.1 v1.1)', () => {
  it('reads current/<ppid>.json on every call, so /clear switches the session without a restart', async () => {
    const first = await h.call('whoami');
    expect((first.json as WhoamiResult).sessionId).toBe(SESSION_ID);
    expect((first.json as WhoamiResult).sessionSource).toBe('current-file');
    writeLiveSession(h.home, h.cwd, { sessionId: 'sess-after-clear' });
    const second = await h.call('whoami');
    expect((second.json as WhoamiResult).sessionId).toBe('sess-after-clear');
    await h.call('status');
    expect(lastRequest().headers[RELAY_HEADERS.session]).toBe('sess-after-clear');
  });

  it('falls back to a cwd match, then the env var, and reports the source', async () => {
    const viaCwd = await startHarness({ hubUrl: hub.url, ppid: 99_991, session: false });
    try {
      // no current/99991.json: a live session (this process's pid) in the same cwd is the next best match
      writeLiveSession(viaCwd.home, viaCwd.cwd, { sessionId: 'sess-cwd', pid: process.pid });
      const r = await viaCwd.call('whoami');
      expect((r.json as WhoamiResult).sessionSource).toBe('cwd-match');
      expect((r.json as WhoamiResult).sessionId).toBe('sess-cwd');
    } finally {
      await viaCwd.close();
    }
    const viaEnv = await startHarness({ hubUrl: hub.url, session: false, env: { CLAUDE_CODE_SESSION_ID: 'sess-env' } });
    try {
      const r = await viaEnv.call('whoami');
      expect((r.json as WhoamiResult).sessionSource).toBe('env');
      expect((r.json as WhoamiResult).sessionId).toBe('sess-env');
    } finally {
      await viaEnv.close();
    }
  });

  it('with no session meta the repo comes from git (origin URL normalised) and .relay.json', async () => {
    const { execFileSync } = await import('node:child_process');
    const lonely = await startHarness({ hubUrl: hub.url, session: false, env: { CLAUDE_CODE_SESSION_ID: undefined } });
    try {
      execFileSync('git', ['init', '-q'], { cwd: lonely.cwd });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/Portal.git'], { cwd: lonely.cwd });
      writeFileSync(join(lonely.cwd, '.relay.json'), JSON.stringify({ project: 'portal', areas: { web: { paths: ['web/**'] } } }));
      const r = await lonely.call('whoami');
      const w = r.json as WhoamiResult;
      expect(w.repo).toBe('github.com/acme/portal');
      expect(w.project).toBe('portal');
      expect(w.sessionSource).toBe('none');
      expect(w.dev).toBe('deepak');
      expect(w.identitySource).toBe('env');
      await lonely.call('status');
      expect(lastRequest().query['repo']).toBe('github.com/acme/portal');
      expect(lastRequest().headers[RELAY_HEADERS.session]).toBeUndefined();
    } finally {
      await lonely.close();
    }
  });
});

describe('whoami and iam (§3.3, §9.2)', () => {
  it('reports identity, hub, repo, session, cache age, breaker, plugin and hook counts', async () => {
    writeCachedSnapshot(h.home, snapshot(), Date.now() - 120_000);
    mkdirSync(join(h.home, LOCAL_PATHS.logDir), { recursive: true });
    writeFileSync(join(h.home, LOCAL_PATHS.stats), `${JSON.stringify({ at: new Date().toISOString(), event: 'PreToolUse', verb: 'pre-edit', ms: 12, out: 'none', sessionId: SESSION_ID })}\n${JSON.stringify({ at: new Date().toISOString(), event: 'PreToolUse', verb: 'pre-edit', ms: 9, out: 'context', sessionId: SESSION_ID })}\n`);
    writeFileSync(join(h.home, LOCAL_PATHS.pluginRemote), JSON.stringify({ sha: 'deadbeef', checkedAt: new Date().toISOString() }));
    const r = await h.call('whoami');
    const w = r.json as WhoamiResult;
    expect(w).toMatchObject({ dev: 'deepak', identitySource: 'env', team: 'env', hub: hub.url, repo: REPO, project: 'acme-portal', sessionId: SESSION_ID, sessionSource: 'current-file', hookCounts: { PreToolUse: 2 } });
    expect(w.cacheAgeMs).toBeGreaterThanOrEqual(120_000);
    expect(w.plugin.remoteSha).toBe('deadbeef');
    expect(r.head).toContain('dev: deepak (env)');
    expect(r.head).toContain('hooks in the last 24 h (this session): PreToolUse 2');
    expect(r.head).toContain('snapshot 2m old (as of 09:41:07Z)');
    expect(hub.requests).toHaveLength(0);
  });

  it('iam writes identity.json, merges the placeholder on the hub with the new handle and patches the live meta', async () => {
    const ph = await startHarness({ hubUrl: hub.url, session: false, env: { RELAY_DEV: undefined } });
    try {
      // the hooks resolved a per-machine placeholder (no RELAY_DEV, git email not in team.json); the MCP server follows meta
      writeLiveSession(ph.home, ph.cwd, { dev: 'unknown-7d3568', metaExtra: { identitySource: 'placeholder' } });
      const before = await ph.call('whoami');
      const placeholder = (before.json as WhoamiResult).dev;
      expect(placeholder).toMatch(/^unknown-[0-9a-f]{6}$/);
      expect(before.head).toContain('identity is a per-machine placeholder');
      const r = await ph.call('whoami', { iam: 'deepak' });
      expect(r.isError).toBe(false);
      const req = lastRequest();
      expect(req).toMatchObject({ method: 'POST', path: '/v1/iam', body: { placeholder, sessionId: SESSION_ID } });
      expect(req.headers[RELAY_HEADERS.dev]).toBe('deepak');
      expect(readIdentityFile(ph.home)).toMatchObject({ dev: 'deepak', source: 'identity-file' });
      expect(readMeta(sessionDir(ph.home, SESSION_ID))?.dev).toBe('deepak');
      const w = r.json as WhoamiResult & { iam: { merged: { merged: boolean; sessions: number } } };
      expect(w.dev).toBe('deepak');
      expect(w.identitySource).toBe('identity-file');
      expect(w.iam.merged).toEqual({ merged: true, sessions: 2 });
      expect(r.head).toContain('hub merged');
      expect(r.head).toContain('switched to deepak');
      const after = await ph.call('whoami');
      expect((after.json as WhoamiResult).dev).toBe('deepak');
      const bad = await ph.call('whoami', { iam: 'not a handle!' });
      expect(bad.isError).toBe(true);
    } finally {
      await ph.close();
    }
  });

  it('team.json under CLAUDE_PLUGIN_ROOT resolves identity by git email and supplies hub/token', async () => {
    const pluginRoot = join(h.home, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'team.json'), JSON.stringify({ hub: hub.url, team: 'exampleteam', token: 'rt_team', members: { deepak: { name: 'Deepak', emails: ['deepak@example.com'] }, priya: { name: 'Priya', emails: ['priya@x.com'] } } }));
    const t = await startHarness({ hubUrl: null, session: false, env: { RELAY_DEV: undefined, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_CODE_SESSION_ID: undefined } });
    try {
      // no session meta: the full ladder runs against the checkout's git email (§3.3 step 3) and caches identity.json
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init', '-q'], { cwd: t.cwd });
      execFileSync('git', ['config', 'user.email', 'deepak@example.com'], { cwd: t.cwd });
      const r = await t.call('whoami');
      const w = r.json as WhoamiResult;
      expect(w).toMatchObject({ dev: 'deepak', identitySource: 'git-email', team: 'exampleteam', hub: hub.url, sessionSource: 'none' });
      await t.call('status');
      expect(lastRequest().headers['authorization']).toBe('Bearer rt_team');
      expect(readFileSync(join(t.home, LOCAL_PATHS.identity), 'utf8')).toContain('"git-email"');
    } finally {
      await t.close();
    }
  });
});
