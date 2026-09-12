import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventsResponse, Snapshot } from '@relay/core';
import { changeSets, heat, impactTargets, impacts, sessions } from './db/schema.js';
import { ulid } from './util/ids.js';
import {
  CONTRACT_PATH,
  commitEvent,
  contractEvent,
  editEvent,
  makeHub,
  postEvents,
  promptEvent,
  startSession,
  type TestHub,
} from '../test/helpers.js';

let t: TestHub;
afterEach(async () => {
  await t?.close();
});

async function snapshotFor(dev: string, session?: string): Promise<Snapshot> {
  const res = await t.request<Snapshot>('/v1/snapshot?repo=demo/app', { dev, session });
  expect(res.status).toBe(200);
  return res.body;
}

describe('/v1/events idempotency (§10.1 write semantics)', () => {
  it('ignores a replayed event id and a duplicate commit SHA', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 's1', { gitEmail: 'priya@demo' });
    const edit = editEvent(t, 'apps/app/src/api/orders.ts');
    await postEvents(t, 'priya', 's1', [edit]);
    await postEvents(t, 'priya', 's1', [edit]);
    await postEvents(t, 'priya', 's1', [edit], { replay: true });
    const [row] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(row?.editCount).toBe(1);
    const heatRows = await t.hub.db.select().from(heat).where(eq(heat.sessionId, 's1'));
    expect(heatRows).toHaveLength(1);
    expect(heatRows[0]?.count).toBe(1);

    const sha = 'c'.repeat(40);
    await postEvents(t, 'priya', 's1', [commitEvent(t, sha, 'priya@demo')]);
    await postEvents(t, 'priya', 's1', [commitEvent(t, sha, 'priya@demo', { id: ulid() })]);
    const [after] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(after?.commitCount).toBe(1);
    const imps = await t.hub.db.select().from(impacts).where(eq(impacts.sessionId, 's1'));
    expect(imps).toHaveLength(1);
    expect(imps[0]?.status).toBe('committed');
  });

  it('never revives an ended session from a replay and keeps heat.last_at moving forward', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 's1');
    const first = editEvent(t, 'apps/app/src/a.ts');
    await postEvents(t, 'priya', 's1', [first]);
    t.clock.advance(60_000);
    await t.request('/v1/session/end', { dev: 'priya', json: { sessionId: 's1', reason: 'other', files: [], commits: [], draft: null } });
    const [ended] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(ended?.endedAt).not.toBeNull();

    // a drained outbox entry: older `at`, replay: true
    const old = editEvent(t, 'apps/app/src/a.ts', { at: '2026-09-12T08:59:00.000Z' });
    await postEvents(t, 'priya', 's1', [old], { replay: true });
    const [still] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(still?.endedAt).not.toBeNull();
    expect(still?.lastSeenAt.toISOString()).toBe(ended?.lastSeenAt.toISOString());
    const [h] = await t.hub.db.select().from(heat).where(eq(heat.sessionId, 's1'));
    expect(h?.lastAt.toISOString()).toBe('2026-09-12T09:00:00.000Z'); // not rewound to 08:59
    expect(h?.count).toBe(2);

    // a live hook after the end revives the row (§6.2)
    await postEvents(t, 'priya', 's1', [editEvent(t, 'apps/app/src/b.ts')]);
    const [revived] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(revived?.endedAt).toBeNull();
  });

  it('marks "in a turn" on prompt and clears it on turn_end', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 's1');
    await postEvents(t, 'priya', 's1', [promptEvent(t)]);
    let [row] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(row?.inTurnSince).not.toBeNull();
    expect(row?.objective).toBe('Add status to OrderFilter');
    await postEvents(t, 'priya', 's1', [{ id: ulid(), at: t.clock.now().toISOString(), type: 'turn_end', promptId: 'p1', text: 'Done. Added status.', draft: null }]);
    [row] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 's1'));
    expect(row?.inTurnSince).toBeNull();
  });
});

describe('impact routing (§7.5)', () => {
  it('routes a contract change to the dependent developer, debounced until stable, and retracts on revert', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    await postEvents(t, 'arjun', 'a1', [editEvent(t, 'apps/dashboard/src/OrdersTable.tsx')], { area: 'dashboard' });

    const res = await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH)]);
    expect(res.snapshot.changeSets).toHaveLength(0); // the author is never a target

    const [cs] = await t.hub.db.select().from(changeSets);
    expect(cs?.status).toBe('uncommitted');
    const targets = await t.hub.db.select().from(impactTargets);
    expect(targets).toHaveLength(1);
    const arjun = await t.hub.devByHandle('arjun');
    expect(targets[0]?.devId).toBe(arjun?.id);
    // owner (+2) and live in the area (+2) with an import-derived dependent -> high
    expect(targets[0]?.priority).toBe('high');
    expect(targets[0]?.dependents.map((d) => d.path)).toContain('apps/dashboard/src/hooks/useOrders.ts');
    expect(targets[0]?.dependents.map((d) => d.path)).not.toContain('apps/app/src/api/orders.ts'); // same-area dependent for priya? no: app is another area
    expect(targets[0]?.dependents.some((d) => d.via === 'depends' && d.area === 'dashboard')).toBe(true);

    // debounce: uncommitted change sets reach the inbox/JIT only after 3 min of a stable hash (§7.5 step 7)
    let snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(0);
    t.clock.advance(3 * 60_000 + 1);
    snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(1);
    expect(snap.changeSets[0]?.by).toBe('priya');
    expect(snap.changeSets[0]?.priority).toBe('high');
    expect(snap.changeSets[0]?.impacts[0]?.symbols).toEqual(['OrderFilter']);
    expect(snap.inbox).toHaveLength(0); // impact notifications ride on changeSets, not the inbox

    // a changed hash within 30 min supersedes in place (rev 2) and restarts the debounce
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH, { hash: 'hash-2', hunk: '+status: OrderStatus' })]);
    const rows = await t.hub.db.select().from(impacts).where(eq(impacts.sessionId, 'p1'));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.hash === 'hash-2')?.rev).toBe(2);
    expect(rows.find((r) => r.hash === 'hash-1')?.supersededBy).toBe(rows.find((r) => r.hash === 'hash-2')?.id);
    snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(0);

    // retract: the record is withdrawn, targets deleted, the change set downgraded
    await postEvents(t, 'priya', 'p1', [{ id: ulid(), at: t.clock.now().toISOString(), type: 'retract', path: CONTRACT_PATH, impactId: null, hash: 'hash-2' }]);
    const [withdrawn] = await t.hub.db.select().from(changeSets);
    expect(withdrawn?.status).toBe('withdrawn');
    expect(await t.hub.db.select().from(impactTargets)).toHaveLength(0);
    t.clock.advance(10 * 60_000);
    snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(0);
  });

  it('commits route immediately and the ack tool stops delivery', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH)]);
    await postEvents(t, 'priya', 'p1', [commitEvent(t, 'd'.repeat(40), 'priya@demo')]);
    let snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(1);
    expect(snap.changeSets[0]?.status).toBe('committed');
    expect(snap.changeSets[0]?.impacts[0]?.commitSha).toBe('d'.repeat(40));

    const ack = await t.request<{ changeSetId: string; notifiedAuthor: boolean }>('/v1/ack', { dev: 'arjun', json: { id: snap.changeSets[0]?.id, note: 'handled' } });
    expect(ack.status).toBe(200);
    expect(ack.body.notifiedAuthor).toBe(true);
    snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(0);
    const priyaSnap = await snapshotFor('priya', 'p1');
    expect(priyaSnap.inbox.some((i) => i.body.includes('acknowledged'))).toBe(true);
  });

  it('never creates impacts for commits whose author is not the sender (§7.2 author filter)', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    // arjun pulled priya's commit: the client should filter it, the hub does too
    await postEvents(t, 'arjun', 'a1', [commitEvent(t, 'e'.repeat(40), 'priya@demo')]);
    expect(await t.hub.db.select().from(impacts)).toHaveLength(0);
    const [row] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 'a1'));
    expect(row?.commitCount).toBe(0);
    // a commit from priya's own noreply address still counts
    await postEvents(t, 'priya', 'p1', [commitEvent(t, 'f'.repeat(40), '123+priya@users.noreply.github.com')]);
    expect(await t.hub.db.select().from(impacts)).toHaveLength(1);
  });

  it('auto-acks a change set when a teammate commits its content (merged by content)', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH)]);
    await postEvents(t, 'priya', 'p1', [commitEvent(t, '1'.repeat(40), 'priya@demo')]);
    let snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(1);
    // arjun merges priya's branch: the pulled commit carries the same blob id (foreign author -> no impact, but an ack)
    await postEvents(t, 'arjun', 'a1', [commitEvent(t, '2'.repeat(40), 'priya@demo', { contracts: [{ path: CONTRACT_PATH, symbols: ['OrderFilter'], hash: 'hash-1', blobId: 'b'.repeat(40) }] })]);
    snap = await snapshotFor('arjun', 'a1');
    expect(snap.changeSets).toHaveLength(0);
    const [target] = await t.hub.db.select().from(impactTargets);
    expect(target?.ackedAt).not.toBeNull();
    expect(target?.ackNote).toContain('merged by content');
    expect(await t.hub.db.select().from(impacts)).toHaveLength(1);
  });

  it('patch id: the same dev\'s rebased commit updates the SHA; a teammate\'s identical commit keeps its own record', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    const patchId = 'p'.repeat(40);
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH)]);
    await postEvents(t, 'priya', 'p1', [commitEvent(t, '3'.repeat(40), 'priya@demo', { patchId })]);
    // priya rebases: new sha, same patch id -> her record follows the sha, no second record
    await postEvents(t, 'priya', 'p1', [commitEvent(t, '4'.repeat(40), 'priya@demo', { patchId })]);
    let rows = await t.hub.db.select().from(impacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitSha).toBe('4'.repeat(40));
    // arjun edits and commits the identical diff on his branch: his own uncommitted record becomes committed,
    // priya's record keeps her sha (his commit is an ack-by-content for her change set, not a rebase of it)
    await postEvents(t, 'arjun', 'a1', [contractEvent(t, CONTRACT_PATH)]);
    await postEvents(t, 'arjun', 'a1', [commitEvent(t, '5'.repeat(40), 'arjun@demo', { patchId })]);
    rows = await t.hub.db.select().from(impacts);
    expect(rows).toHaveLength(2);
    const priyaRow = rows.find((r) => r.sessionId === 'p1');
    const arjunRow = rows.find((r) => r.sessionId === 'a1');
    expect(priyaRow?.commitSha).toBe('4'.repeat(40));
    expect(arjunRow).toMatchObject({ status: 'committed', commitSha: '5'.repeat(40) });
    expect(rows.filter((r) => r.status === 'uncommitted')).toHaveLength(0);
  });

  it('keeps same-area churn at low priority with no targets', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await startSession(t, 'arjun', 'a1', { gitEmail: 'arjun@demo' });
    // an exported component inside apps/app with dependents only in apps/app
    await postEvents(t, 'priya', 'p1', [contractEvent(t, 'apps/app/src/components/Button.tsx', { symbols: ['Button'], dependents: ['apps/app/src/pages/Home.tsx'] })]);
    const [cs] = await t.hub.db.select().from(changeSets);
    expect(cs?.priority).toBe('low');
    expect(await t.hub.db.select().from(impactTargets)).toHaveLength(0);
  });

  it('returns the inbox with the events response and marks delivered ids', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1');
    await startSession(t, 'arjun', 'a1');
    const note = await t.request<{ ids: string[] }>('/v1/notify', { dev: 'arjun', session: 'a1', json: { dev: 'priya', message: 'keep `status`', kind: 'fyi' } });
    expect(note.status).toBe(200);
    let res: EventsResponse = await postEvents(t, 'priya', 'p1', [promptEvent(t)]);
    expect(res.inbox).toHaveLength(1);
    expect(res.inbox[0]?.from).toBe('arjun');
    res = await postEvents(t, 'priya', 'p1', [], { delivered: [res.inbox[0]!.id] });
    expect(res.inbox).toHaveLength(0);
  });
});
