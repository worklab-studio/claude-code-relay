import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdminExport,
  ClaimResponse,
  ImpactOfResponse,
  ImpactsResponse,
  NotifyResponse,
  PurgeResponse,
  RecentChangesResponse,
  ReleaseResponse,
  StatusResponse,
  WhoIsOnResponse,
} from '@relay/core';
import { ADMIN_TOKEN, CONTRACT_PATH, commitEvent, contractEvent, editEvent, makeHub, postEvents, promptEvent, startBody, startSession, type TestHub } from '../test/helpers.js';

let t: TestHub;
afterEach(async () => {
  await t?.close();
});

describe('query and action routes (§9.2, §10.4) — the M0 demo moments', () => {
  it('walks presence, who_is_on, notify, claim conflicts, impact_of, recent_changes and the admin routes', async () => {
    t = await makeHub();
    // Terminal A: priya works on the contract and commits
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await postEvents(t, 'priya', 'p1', [promptEvent(t, { objective: 'Add status to OrderFilter', dirty: ['apps/app/src/api/orders.ts'] })], { objective: 'Add status to OrderFilter', area: 'contracts (+app)' });
    await postEvents(t, 'priya', 'p1', [editEvent(t, CONTRACT_PATH), editEvent(t, 'apps/app/src/api/orders.ts')]);
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH), commitEvent(t, '7'.repeat(40), 'priya@demo')]);

    // Terminal B: arjun starts; moment 1 PRESENCE
    const b = await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    expect(b.digest).toContain('priya · contracts (+app) · main · "Add status to OrderFilter" · working');
    const status = await t.request<StatusResponse>('/v1/query/status?repo=demo/app', { dev: 'arjun', session: 'a1' });
    expect(status.status).toBe(200);
    const priya = status.body.projects[0]?.devs.find((d) => d.dev === 'priya');
    expect(priya?.sessions[0]?.state).toBe('working');
    expect(priya?.sessions[0]?.objective).toBe('Add status to OrderFilter');
    expect(status.body.me.unackedChangeSets).toBe(1);

    const who = await t.request<WhoIsOnResponse>('/v1/query/who_is_on?repo=demo/app&target=packages/contracts/src/orders.ts', { dev: 'arjun' });
    expect(who.body.targetKind).toBe('path');
    expect(who.body.live.map((s) => s.dev)).toEqual(['priya']);
    expect(who.body.recentEditors.some((h) => h.kind === 'edit' && h.dev === 'priya')).toBe(true);
    const whoArea = await t.request<WhoIsOnResponse>('/v1/query/who_is_on?repo=demo/app&target=app', { dev: 'arjun' });
    expect(whoArea.body.targetKind).toBe('area');
    expect(whoArea.body.dirty.map((h) => h.path)).toContain('apps/app/src/api/orders.ts');

    // moment 2 IMPACT: the impacts tool and impact_of
    const impacts = await t.request<ImpactsResponse>('/v1/query/impacts?repo=demo/app', { dev: 'arjun' });
    expect(impacts.body.changeSets).toHaveLength(1);
    expect(impacts.body.changeSets[0]?.targets[0]?.dev).toBe('arjun');
    const impactOf = await t.request<ImpactOfResponse>('/v1/query/impact_of?repo=demo/app&path=packages/contracts/src/orders.ts', { dev: 'arjun' });
    expect(impactOf.body.symbols).toEqual(['OrderFilter']);
    expect(impactOf.body.dependents.map((d) => d.path)).toContain('apps/dashboard/src/hooks/useOrders.ts');
    expect(impactOf.body.active.map((s) => s.dev)).toContain('priya');
    expect(impactOf.body.openChangeSets).toHaveLength(1);

    // moment 3 COLLISION is client-side; the hub reports conflicts on an explicit claim
    const claim = await t.request<ClaimResponse>('/v1/claim', { dev: 'arjun', session: 'a1', json: { target: 'packages/contracts/src/orders.ts', ttl: '2h', hard: true } });
    expect(claim.status).toBe(200);
    expect(claim.body.claim.hard).toBe(true);
    expect(claim.body.conflicts.heat.some((h) => h.dev === 'priya')).toBe(true);
    expect(claim.body.conflicts.sessions.map((s) => s.dev)).toEqual(['priya']);
    const priyaSnap = await t.request<{ claims: Array<{ dev: string; hard: boolean }> }>('/v1/snapshot?repo=demo/app', { dev: 'priya', session: 'p1' });
    expect(priyaSnap.body.claims).toEqual([expect.objectContaining({ dev: 'arjun', hard: true })]);
    const release = await t.request<ReleaseResponse>('/v1/release', { dev: 'arjun', session: 'a1', json: { target: 'all' } });
    expect(release.body.released).toHaveLength(1);

    // moment 4 NOTIFY
    const note = await t.request<NotifyResponse>('/v1/notify', { dev: 'arjun', session: 'a1', json: { dev: 'priya', message: 'keep `status`; the dashboard already consumes it' } });
    expect(note.body.targets[0]).toMatchObject({ dev: 'priya', active: true, via: 'next-prompt' });
    const priyaEvents = await postEvents(t, 'priya', 'p1', [promptEvent(t)]);
    expect(priyaEvents.inbox.map((i) => i.body)).toContain('keep `status`; the dashboard already consumes it');

    // recent_changes lists the contract and the commit
    const recent = await t.request<RecentChangesResponse>('/v1/query/recent_changes?repo=demo/app&since=1d', { dev: 'arjun' });
    expect(recent.body.items.some((i) => i.kind === 'contract' && i.path === CONTRACT_PATH)).toBe(true);
    expect(recent.body.items.some((i) => i.kind === 'commit' && i.sha === '7'.repeat(40))).toBe(true);

    // moment 5/6: end + handoff, then export and purge through the admin routes
    await t.request('/v1/session/end', { dev: 'priya', json: { sessionId: 'p1', reason: 'prompt_input_exit', files: [], commits: [], draft: null } });
    await t.hub.drain();
    const exported = await t.request<AdminExport>('/admin/export?project=acme-portal', { token: ADMIN_TOKEN });
    expect(exported.status).toBe(200);
    expect(exported.body.handoffs).toHaveLength(1);
    expect(exported.body.sessions.map((s) => s.sessionId).sort()).toEqual(['a1', 'p1']);
    const purged = await t.request<PurgeResponse>('/admin/purge?repo=demo/app', { token: ADMIN_TOKEN, method: 'DELETE' });
    expect(purged.body.ok).toBe(true);
    expect(purged.body.deleted['sessions']).toBe(2);
    expect((await t.request('/v1/snapshot?repo=demo/app', { dev: 'arjun' })).status).toBe(404);
  });

  it('serves GET /v1/snapshot from the in-memory cache until a write invalidates it', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1');
    const first = await t.request<{ serverTime: string }>('/v1/snapshot?repo=demo/app', { dev: 'priya', session: 'p1' });
    t.clock.advance(5_000);
    const cached = await t.request<{ serverTime: string }>('/v1/snapshot?repo=demo/app', { dev: 'priya', session: 'p1' });
    expect(cached.body.serverTime).toBe(first.body.serverTime);
    await postEvents(t, 'priya', 'p1', [editEvent(t, 'apps/app/src/x.ts')]);
    const fresh = await t.request<{ serverTime: string; heat: unknown[] }>('/v1/snapshot?repo=demo/app', { dev: 'priya', session: 'p1' });
    expect(fresh.body.serverTime).not.toBe(first.body.serverTime);
    expect(fresh.body.heat).toHaveLength(1);
  });
});

describe('cross-repo routing through the dependency index (§7.4)', () => {
  it('routes a contract change in demo/app to the dashboard repo of the same project', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    // arjun works in a second repo of the project; his client uploaded its dependency index
    const dashRepo = { slug: 'demo/dashboard', root: '/tmp/dash', project: 'acme-portal', config: { project: 'acme-portal', areas: { web: { paths: ['src/**'], owners: ['arjun'] } } }, configHash: 'd1' };
    await t.request('/v1/session/start', { dev: 'arjun', json: { ...startBodyFor('a1'), session: { ...startBodyFor('a1').session, repo: dashRepo } } });
    const idx = await t.request('/v1/depindex', {
      dev: 'arjun',
      json: {
        repo: 'demo/dashboard',
        head: 'e'.repeat(40),
        imports: { '@acme/contracts': ['src/api/client.ts'], '@acme/contracts/orders': ['src/hooks/useOrders.ts'] },
        symbols: { OrderFilter: ['src/OrdersTable.tsx'] },
        contractPaths: { orders: ['src/legacy/orders-copy.ts'] },
      },
    });
    expect(idx.status).toBe(200);
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH, { dependents: [] }), commitEvent(t, '8'.repeat(40), 'priya@demo')]);
    const snap = await t.request<{ changeSets: Array<{ repo?: string; dependents: Array<{ path: string; via: string }> }> }>('/v1/snapshot?repo=demo/dashboard', { dev: 'arjun', session: 'a1' });
    expect(snap.status).toBe(200);
    expect(snap.body.changeSets).toHaveLength(1);
    expect(snap.body.changeSets[0]?.repo).toBe('demo/app');
    const paths = snap.body.changeSets[0]?.dependents.map((d) => `${d.via}:${d.path}`) ?? [];
    expect(paths).toContain('import:src/api/client.ts');
    expect(paths).toContain('import:src/hooks/useOrders.ts');
    expect(paths).toContain('import:src/OrdersTable.tsx');
    expect(paths).toContain('basename:src/legacy/orders-copy.ts');
    const digest = await startSession(t, 'arjun', 'a2', { session: { ...startBodyFor('a2').session, repo: dashRepo } });
    expect(digest.digest).toContain('priya changed packages/contracts/src/orders.ts in demo/app');
  });
});

function startBodyFor(id: string) {
  return startBody(id);
}
