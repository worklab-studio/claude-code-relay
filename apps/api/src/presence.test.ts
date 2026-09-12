import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { HandoffBody, HandoffsResponse } from '@relay/core';
import { claims, handoffs, sessions } from './db/schema.js';
import type { LlmClient } from './llm.js';
import { deriveState, inLongTurn } from './presence.js';
import { acquireSweepLock, maybeSweep } from './sweep.js';
import { ulid } from './util/ids.js';
import { editEvent, makeHub, postEvents, promptEvent, startSession, type TestHub } from '../test/helpers.js';

let t: TestHub;
afterEach(async () => {
  await t?.close();
});

const now = new Date('2026-09-12T10:00:00.000Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('presence state derivation (§6.2)', () => {
  it('follows the working / idle / away / gone ladder from timestamps', () => {
    expect(deriveState({ endedAt: null, lastSeenAt: minutesAgo(1), inTurnSince: null }, now)).toBe('working');
    expect(deriveState({ endedAt: null, lastSeenAt: minutesAgo(10), inTurnSince: null }, now)).toBe('idle');
    expect(deriveState({ endedAt: null, lastSeenAt: minutesAgo(45), inTurnSince: null }, now)).toBe('away');
    expect(deriveState({ endedAt: null, lastSeenAt: minutesAgo(121), inTurnSince: null }, now)).toBe('gone');
    expect(deriveState({ endedAt: minutesAgo(1), lastSeenAt: minutesAgo(1), inTurnSince: null }, now)).toBe('gone');
  });

  it('keeps a session "in a turn" working for up to 2 h without events', () => {
    const s = { endedAt: null, lastSeenAt: minutesAgo(25), inTurnSince: minutesAgo(25) };
    expect(deriveState(s, now)).toBe('working');
    expect(inLongTurn(s, now)).toBe(true);
    expect(deriveState({ ...s, inTurnSince: minutesAgo(125), lastSeenAt: minutesAgo(100) }, now)).toBe('away');
  });
});

describe('lazy sweep (§6.2, §8.1)', () => {
  it('serializes concurrent sweeps with the conditional-update lock', async () => {
    t = await makeHub();
    // createHub's first request already swept via session start? no session yet: the row is at epoch
    const first = await acquireSweepLock(t.hub, t.clock.now());
    const second = await acquireSweepLock(t.hub, t.clock.now());
    expect(first).toBe(true);
    expect(second).toBe(false);
    t.clock.advance(61_000);
    expect(await acquireSweepLock(t.hub, t.clock.now())).toBe(true);
    const results = await Promise.all([maybeSweep(t.hub), maybeSweep(t.hub), maybeSweep(t.hub)]);
    expect(results.filter((r) => r.ran)).toHaveLength(0); // within 60 s of the previous lock
    t.clock.advance(61_000);
    const parallel = await Promise.all([maybeSweep(t.hub), maybeSweep(t.hub), maybeSweep(t.hub)]);
    expect(parallel.filter((r) => r.ran)).toHaveLength(1);
  });

  it('auto-ends sessions silent for 2 h, releases claims and promotes a heuristic handoff', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await postEvents(t, 'priya', 'p1', [promptEvent(t, { objective: 'Add currency to invoices' })], { objective: 'Add currency to invoices', area: 'app' });
    await postEvents(t, 'priya', 'p1', [editEvent(t, 'apps/app/src/billing/service.ts'), editEvent(t, 'apps/app/src/billing/service.ts')]);
    const draft: HandoffBody & { at: string; quality: 'heuristic' } = {
      at: t.clock.now().toISOString(),
      quality: 'heuristic',
      objective: 'Add currency to invoices',
      areas: ['app'],
      done: ['Invoice now carries currency'],
      changed: [{ path: 'apps/app/src/billing/service.ts', area: 'app', edits: 2, why: 'currency' }],
      interfaces_changed: [],
      decisions: ['Store amounts as integer minor units'],
      blockers: [],
      next: ['Backfill legacy invoices'],
      commits: [],
      notes_to: [{ dev: 'arjun', intent: 'action', text: 'invoices.tsx must read amountDue' }],
    };
    await postEvents(t, 'priya', 'p1', [
      { id: ulid(), at: t.clock.now().toISOString(), type: 'turn_end', promptId: 'pr1', text: 'Done. I have added currency to Invoice.\n\nNext:\n- Backfill legacy invoices\n- Update the dashboard table', draft },
    ]);
    const claim = await t.request<{ claim: { id: string } }>('/v1/claim', { dev: 'priya', session: 'p1', json: { target: 'apps/app/src/billing/**', note: 'refactor' } });
    expect(claim.status).toBe(200);

    // an interim handoff after 20 min idle (never while in a turn: turn_end cleared it)
    t.clock.advance(21 * 60_000);
    let result = await maybeSweep(t.hub, { force: true });
    expect(result.interimHandoffs).toBe(1);
    let [h] = await t.hub.db.select().from(handoffs).where(eq(handoffs.sessionId, 'p1'));
    expect(h?.rev).toBe(1);
    expect(h?.quality).toBe('heuristic');
    expect(h?.endedAt).toBeNull();
    expect(h?.done).toContain('Invoice now carries currency');
    expect(h?.next).toContain('Backfill legacy invoices');
    expect(h?.next).toContain('Update the dashboard table');

    // 2 h of silence: auto-end with reason timeout, claims released, handoff rewritten as rev 2
    t.clock.advance(2 * 60 * 60_000);
    result = await maybeSweep(t.hub, { force: true });
    expect(result.autoEnded).toBe(1);
    await t.hub.drain();
    const [s] = await t.hub.db.select().from(sessions).where(eq(sessions.id, 'p1'));
    expect(s?.endReason).toBe('timeout');
    expect(s?.endedAt).not.toBeNull();
    const [c] = await t.hub.db.select().from(claims);
    expect(c?.releasedAt).not.toBeNull();
    [h] = await t.hub.db.select().from(handoffs).where(eq(handoffs.sessionId, 'p1'));
    expect(h?.rev).toBe(2);
    expect(h?.endReason).toBe('timeout');
    expect(h?.markdown).toContain('## Next');
    expect(h?.markdown).toContain('addressed_to: [arjun]');

    // arjun's digest lists the handoff and carries the note
    const arjun = await startSession(t, 'arjun', 'a1');
    expect(arjun.digest).toContain('Handoffs since your last session');
    expect(arjun.digest).toContain('invoices.tsx must read amountDue');
    const list = await t.request<HandoffsResponse>('/v1/query/handoffs?repo=demo/app&dev=priya', { dev: 'arjun' });
    expect(list.body.items[0]?.quality).toBe('heuristic');
    expect(list.body.items[0]?.markdown).toContain('## Done');
  });

  it('uses the LLM tier when configured and keeps a self handoff from being overwritten', async () => {
    const calls: number[] = [];
    const llm: LlmClient = {
      model: 'mock',
      synthesize: async (packet) => {
        calls.push(packet.turns.length);
        return {
          objective: 'Add currency support to invoices',
          areas: ['app'],
          done: ['LLM: currency on Invoice'],
          changed: [],
          interfaces_changed: [],
          decisions: ['Amounts are integer minor units'],
          blockers: [],
          next: ['LLM: backfill'],
          commits: [],
          notes_to: [],
        };
      },
    };
    t = await makeHub({ llm });
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await postEvents(t, 'priya', 'p1', [editEvent(t, 'apps/app/src/a.ts')]);
    await t.request('/v1/session/end', { dev: 'priya', json: { sessionId: 'p1', reason: 'prompt_input_exit', files: [], commits: [], draft: null } });
    await t.hub.drain();
    let [h] = await t.hub.db.select().from(handoffs).where(eq(handoffs.sessionId, 'p1'));
    expect(h?.quality).toBe('llm');
    expect(h?.done).toEqual(['LLM: currency on Invoice']);
    expect(calls).toHaveLength(1);
    const decisions = await t.request<{ items: Array<{ text: string; source: string }> }>('/v1/query/decisions?repo=demo/app', { dev: 'arjun' });
    expect(decisions.body.items.map((d) => d.text)).toContain('Amounts are integer minor units');

    // self tier via the handoff tool wins and is not replaced by a later synthesis
    const self = await t.request<{ handoff: { quality: string; rev: number } }>('/v1/handoff', {
      dev: 'priya',
      session: 'p1',
      json: { summary: { done: ['Self: wrote the migration'], next: ['Self: wire dashboard'], notes_to: [{ dev: 'arjun', intent: 'fyi', text: 'schema changed' }] } },
    });
    expect(self.status).toBe(200);
    expect(self.body.handoff.quality).toBe('self');
    expect(self.body.handoff.rev).toBe(2);
    await t.request('/v1/handoff', { dev: 'priya', session: 'p1', json: {} });
    [h] = await t.hub.db.select().from(handoffs).where(eq(handoffs.sessionId, 'p1'));
    expect(h?.quality).toBe('self');
    expect(h?.done).toEqual(['Self: wrote the migration']);
    expect(h?.rev).toBe(3);
    expect(calls).toHaveLength(1);
  });

  it('skips handoffs for sessions with no activity', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1');
    await t.request('/v1/session/end', { dev: 'priya', json: { sessionId: 'p1', reason: 'other', files: [], commits: [], draft: null } });
    await t.hub.drain();
    expect(await t.hub.db.select().from(handoffs)).toHaveLength(0);
  });
});
