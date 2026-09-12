/**
 * Stub hub for the tool tests: a real HTTP server on 127.0.0.1 that records
 * every request (method, path, query, headers, body) and answers from a
 * per-path table of canned responses built on core's test fixtures.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PROTOCOL_VERSION,
  RELAY_CONFIG_DEFAULTS,
  type AckResponse,
  type ChangeSetView,
  type ClaimRecord,
  type ClaimResponse,
  type DecideResponse,
  type DecisionRecord,
  type DecisionsResponse,
  type HandoffRecord,
  type HandoffResponse,
  type HandoffsResponse,
  type HeatEntry,
  type IamResponse,
  type ImpactOfResponse,
  type ImpactsResponse,
  type NotifyResponse,
  type PresenceRecord,
  type RecentChangesResponse,
  type ReleaseResponse,
  type Snapshot,
  type SnapshotChangeSet,
  type StatusResponse,
  type WhoIsOnResponse,
} from '@relay/core';

export const T0 = Date.parse('2026-09-12T09:41:07Z');
export const iso = (ms: number): string => new Date(ms).toISOString();
export const REPO = 'github.com/acme/app';
export const PROJECT = 'acme-portal';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export type StubHandler = (req: RecordedRequest) => { status?: number; body: unknown; headers?: Record<string, string> } | Promise<{ status?: number; body: unknown; headers?: Record<string, string> }>;

export interface StubHub {
  url: string;
  requests: RecordedRequest[];
  handlers: Map<string, StubHandler>;
  /** delay every response by this many ms (timeouts) */
  delayMs: number;
  close: () => Promise<void>;
}

export function presence(dev: string, extra: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    dev,
    sessionId: `sess-${dev}`,
    client: 'cli',
    host: 'mac',
    repo: REPO,
    project: PROJECT,
    branch: 'feat/currency',
    worktree: null,
    area: 'app',
    objective: 'Add currency support to invoices',
    objectiveSource: 'prompt',
    state: 'working',
    startedAt: iso(T0 - 3_600_000),
    lastSeenAt: iso(T0 - 40_000),
    lastEditAt: iso(T0 - 40_000),
    inTurnSince: null,
    editCount: 6,
    recentFiles: ['packages/contracts/src/billing.ts', 'apps/app/src/billing/service.ts'],
    ...extra,
  };
}

export function claim(dev: string, target: string, extra: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: `clm_${dev}_1`,
    repo: REPO,
    dev,
    sessionId: `sess-${dev}`,
    target,
    note: 'refactoring the table',
    hard: false,
    keep: false,
    createdAt: iso(T0 - 600_000),
    expiresAt: iso(T0 + 4 * 3_600_000),
    releasedAt: null,
    ...extra,
  };
}

export function heat(dev: string, path: string, extra: Partial<HeatEntry> = {}): HeatEntry {
  return { path, dev, sessionId: `sess-${dev}`, mine: false, branch: 'feat/currency', objective: 'Add currency support to invoices', kind: 'edit', at: iso(T0 - 120_000), pushed: false, headSha: null, blobId: null, count: 6, ...extra };
}

export function changeSet(id: string, extra: Partial<SnapshotChangeSet> = {}): SnapshotChangeSet {
  return {
    id,
    by: 'priya',
    branch: 'feat/currency',
    status: 'committed',
    priority: 'high',
    at: iso(T0 - 2_400_000),
    impacts: [
      {
        id: `imp_${id.slice(3)}`,
        rev: 1,
        path: 'packages/contracts/src/billing.ts',
        symbols: ['Invoice', 'createInvoice'],
        summary: 'Invoice: total → amountDue, +currency; createInvoice(input) → createInvoice(input, currency)',
        hunk: '@@ -12,1 +12,2 @@ export interface Invoice {\n-  total: number\n+  amountDue: number\n+  currency: Currency',
        blobId: 'blob1',
        commitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        status: 'committed',
      },
    ],
    dependents: [{ path: 'apps/dashboard/src/invoices.tsx', area: 'dashboard', via: 'import' }],
    ...extra,
  };
}

export function changeSetView(id: string, extra: Partial<ChangeSetView> = {}): ChangeSetView {
  return { ...changeSet(id), sessionId: 'sess-priya', firstAt: iso(T0 - 3_000_000), stableSince: iso(T0 - 2_400_000), acked: {}, targets: [], ...extra };
}

export function decision(id: string, extra: Partial<DecisionRecord> = {}): DecisionRecord {
  return { id, repo: REPO, project: PROJECT, dev: 'priya', sessionId: 'sess-priya', topic: 'money', area: 'billing', text: 'store amounts as integer minor units, no floats', source: 'explicit', confidence: 1, supersedes: null, createdAt: iso(T0 - 86_400_000), ...extra };
}

export function handoff(id: string, extra: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id,
    rev: 1,
    quality: 'heuristic',
    dev: 'priya',
    sessionId: 'sess-priya',
    project: PROJECT,
    repo: REPO,
    branch: 'feat/currency',
    worktree: null,
    client: 'cli',
    startedAt: iso(T0 - 7_200_000),
    endedAt: iso(T0 - 3_600_000),
    endReason: 'prompt_input_exit',
    objective: 'Add currency support to invoices',
    areas: ['app', 'contracts'],
    done: ['currency on Invoice', 'migration 0042'],
    changed: [{ path: 'packages/contracts/src/billing.ts', area: 'contracts', edits: 4 }],
    interfaces_changed: [{ changeSetId: 'cs_01', impactId: 'imp_01', path: 'packages/contracts/src/billing.ts', symbols: ['Invoice', 'createInvoice'], summary: 'Invoice +currency', status: 'committed', commitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' }],
    decisions: ['store amounts as integer minor units'],
    blockers: ['FX-rate creds'],
    next: ['update dashboard invoice table (deepak)'],
    commits: [{ sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', subject: 'currency on Invoice', pushed: true }],
    notes_to: [{ dev: 'deepak', intent: 'action', text: 'update the dashboard invoice table' }],
    markdown: '# Handoff priya · feat/currency\n\n## Done\n- currency on Invoice\n\n## Next\n- update dashboard invoice table (deepak)\n',
    generatedAt: iso(T0 - 3_600_000),
    ...extra,
  };
}

export function snapshot(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    v: PROTOCOL_VERSION,
    serverTime: iso(T0),
    repo: {
      slug: REPO,
      project: PROJECT,
      config: {
        project: PROJECT,
        repo: REPO,
        areas: { app: { paths: ['apps/app/**'], owners: ['priya'] }, dashboard: { paths: ['apps/dashboard/**'], owners: ['deepak'] }, contracts: { paths: ['packages/contracts/**'], shared: true } },
        depends: { dashboard: ['contracts'] },
        contracts: { ...RELAY_CONFIG_DEFAULTS.contracts, globs: ['packages/contracts/**'], packages: ['@acme/contracts'] },
        impacts: RELAY_CONFIG_DEFAULTS.impacts,
        collision: RELAY_CONFIG_DEFAULTS.collision,
        privacy: RELAY_CONFIG_DEFAULTS.privacy,
        handoff: RELAY_CONFIG_DEFAULTS.handoff,
      },
    },
    me: { dev: 'deepak', sessionId: 'sess-deepak' },
    sessions: [
      { dev: 'priya', id: 'sess-priya', client: 'cli', host: 'mac', branch: 'feat/currency', worktree: null, area: 'app', objective: 'Add currency support to invoices', state: 'working', lastSeenAt: iso(T0 - 40_000), lastEditAt: iso(T0 - 40_000), inTurnSince: null },
      { dev: 'deepak', id: 'sess-deepak', client: 'cli', host: 'mac', branch: 'main', worktree: null, area: 'dashboard', objective: 'Wire familyId', state: 'idle', lastSeenAt: iso(T0 - 900_000), lastEditAt: null, inTurnSince: null },
    ],
    heat: [heat('priya', 'apps/app/src/billing/service.ts'), heat('priya', 'packages/contracts/src/billing.ts', { kind: 'commit', headSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', pushed: true }), heat('arjun', 'apps/dashboard/src/x.tsx', { kind: 'dirty', count: undefined })],
    claims: [{ id: 'clm_priya_1', dev: 'priya', target: 'apps/app', note: 'refactoring the table', hard: false, expiresAt: iso(T0 + 4 * 3_600_000) }],
    changeSets: [changeSet('cs_01A')],
    inbox: [{ id: 'ntf_1', kind: 'note', from: 'priya', body: 'keep status', ref: null, at: iso(T0 - 60_000), noteKind: 'fyi' }],
    minClient: 1,
    ...extra,
  };
}

export function defaultHandlers(): Map<string, StubHandler> {
  const now = iso(T0);
  const fresh = { source: 'hub' as const, at: now };
  const h = new Map<string, StubHandler>();
  h.set('GET /v1/query/status', (req) => {
    const r: StatusResponse = {
      at: now,
      scope: req.query['project'] === 'all' ? 'all' : 'current',
      projects: [{ project: PROJECT, repos: [REPO], devs: [{ dev: 'priya', sessions: [presence('priya')], claims: [claim('priya', 'apps/app')], lastSeenAt: iso(T0 - 40_000) }, { dev: 'deepak', sessions: [presence('deepak', { branch: 'main', area: 'dashboard', state: 'idle', objective: 'Wire familyId', inTurnSince: null })], claims: [], lastSeenAt: iso(T0 - 900_000) }] }],
      me: { dev: 'deepak', sessionId: 'sess-deepak', unackedChangeSets: 2, unreadInbox: 1 },
      freshness: fresh,
    };
    return { body: r };
  });
  h.set('GET /v1/query/who_is_on', (req) => {
    const r: WhoIsOnResponse = { at: now, target: req.query['target'] ?? '', targetKind: 'area', live: [presence('priya')], recentEditors: [heat('priya', 'apps/app/src/billing/service.ts')], dirty: [heat('arjun', 'apps/app/src/y.ts', { kind: 'dirty' })], claims: [claim('priya', 'apps/app')], freshness: fresh };
    return { body: r };
  });
  h.set('GET /v1/query/recent_changes', () => {
    const cs = changeSet('cs_01A');
    const i = cs.impacts[0]!;
    const r: RecentChangesResponse = {
      at: now,
      since: iso(T0 - 86_400_000),
      items: [
        { kind: 'contract', at: cs.at, dev: 'priya', repo: REPO, branch: cs.branch, changeSetId: cs.id, impactId: i.id, rev: 1, path: i.path, symbols: i.symbols, summary: i.summary, hunk: i.hunk, status: 'committed', priority: 'high', commitSha: i.commitSha },
        { kind: 'commit', at: iso(T0 - 2_000_000), dev: 'priya', repo: REPO, branch: 'feat/currency', sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', subject: 'currency on Invoice', pushed: true, files: ['packages/contracts/src/billing.ts'] },
        { kind: 'edit', at: iso(T0 - 120_000), dev: 'priya', repo: REPO, branch: 'feat/currency', path: 'apps/app/src/billing/service.ts', count: 6 },
        { kind: 'handoff', at: iso(T0 - 3_600_000), dev: 'priya', repo: REPO, branch: 'feat/currency', handoffId: 'hnd_01', objective: 'Add currency support to invoices', line: 'priya · feat/currency · 2026-09-12T08:41Z · done: currency on Invoice · hnd_01' },
      ],
      freshness: fresh,
    };
    return { body: r };
  });
  h.set('GET /v1/query/decisions', () => ({ body: { at: now, items: [decision('dec_01')] } satisfies DecisionsResponse }));
  h.set('GET /v1/query/handoffs', () => ({ body: { at: now, items: [handoff('hnd_01')], freshness: fresh } satisfies HandoffsResponse }));
  h.set('GET /v1/query/impacts', () => ({ body: { at: now, changeSets: [changeSetView('cs_01A', { acked: { arjun: iso(T0 - 100_000) } })], freshness: fresh } satisfies ImpactsResponse }));
  h.set('GET /v1/query/impact_of', (req) => {
    const r: ImpactOfResponse = {
      at: now,
      path: req.query['path'] ?? null,
      sha: req.query['sha'] ?? null,
      symbols: ['OrderFilter', 'Order'],
      kinds: ['export'],
      dependents: [
        { path: 'apps/dashboard/src/hooks/useOrders.ts', area: 'dashboard', via: 'import', repo: REPO },
        { path: 'src/api/orders.ts', area: null, via: 'import', repo: 'github.com/acme/api' },
      ],
      owners: ['deepak'],
      active: [presence('deepak', { area: 'dashboard' })],
      heat: [heat('deepak', 'apps/dashboard/src/hooks/useOrders.ts', { mine: true })],
      openChangeSets: ['cs_01A'],
    };
    return { body: r };
  });
  h.set('POST /v1/notify', () => ({ body: { ids: ['ntf_01'], targets: [{ dev: 'priya', active: true, lastSeenAt: iso(T0 - 40_000), via: 'next-prompt' }], note: 'priya active at 09:40:27Z — delivered at their next prompt' } satisfies NotifyResponse }));
  h.set('POST /v1/claim', (req) => {
    const body = req.body as { target: string; hard?: boolean; note?: string };
    const r: ClaimResponse = {
      claim: claim('deepak', body.target, { id: 'clm_new', hard: body.hard ?? false, note: body.note ?? null }),
      conflicts: { claims: [claim('priya', 'apps/app')], heat: [heat('priya', 'apps/app/src/billing/service.ts')], sessions: [presence('priya')] },
    };
    return { body: r };
  });
  h.set('POST /v1/release', () => ({ body: { released: ['clm_new'] } satisfies ReleaseResponse }));
  h.set('POST /v1/decide', (req) => {
    const body = req.body as { text: string; topic?: string; area?: string };
    return { body: { decision: decision('dec_new', { dev: 'deepak', text: body.text, topic: body.topic ?? null, area: body.area ?? null, createdAt: now }) } satisfies DecideResponse };
  });
  h.set('POST /v1/ack', (req) => ({ body: { changeSetId: (req.body as { id: string }).id, ackedAt: now, notifiedAuthor: true } satisfies AckResponse }));
  h.set('POST /v1/handoff', (req) => {
    const body = req.body as { sessionId?: string; summary?: { done?: string[] } };
    return { body: { handoff: handoff('hnd_new', { dev: 'deepak', sessionId: body.sessionId ?? 'unknown', quality: body.summary ? 'self' : 'heuristic', done: body.summary?.done ?? ['auto'], generatedAt: now }) } satisfies HandoffResponse };
  });
  h.set('POST /v1/iam', () => ({ body: { merged: true, sessions: 2 } satisfies IamResponse }));
  return h;
}

export async function startStubHub(handlers: Map<string, StubHandler> = defaultHandlers()): Promise<StubHub> {
  const requests: RecordedRequest[] = [];
  const hub: StubHub = { url: '', requests, handlers, delayMs: 0, close: async () => undefined };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://stub');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const recorded: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: text ? (JSON.parse(text) as unknown) : null };
    requests.push(recorded);
    if (hub.delayMs > 0) await new Promise((r) => setTimeout(r, hub.delayMs));
    const handler = handlers.get(`${recorded.method} ${recorded.path}`);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: `no stub for ${recorded.method} ${recorded.path}` }));
      return;
    }
    const out = await handler(recorded);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  hub.url = `http://127.0.0.1:${port}`;
  hub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return hub;
}
