import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { deleteOutbox, drainOutbox, isEphemeralEvents, listOutbox, outboxDir, outboxPath, planDrain, replayBody, writeOutbox } from './outbox.js';
import { LIMITS, type EventsRequest, type OutboxEntry } from './protocol.js';
import { ulid } from './ulid.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function home(): string {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

const T0 = Date.parse('2026-09-12T10:00:00Z');
const presence = { id: 's1', repo: 'r', branch: 'main', worktree: null, area: null, objective: null, objectiveSource: null };
const eventsBody = (types: string[]): EventsRequest => ({
  session: presence,
  events: types.map((type, i) => ({ id: ulid(T0 + i), at: new Date(T0).toISOString(), type }) as never),
});

function entryAt(h: string, ageMs: number, kind: OutboxEntry['kind'], ephemeral: boolean): OutboxEntry {
  const e = writeOutbox(h, { sessionId: 's1', kind, endpoint: '/v1/events', body: eventsBody(['edit']), ephemeral, now: T0 - ageMs });
  if (!e) throw new Error('write failed');
  return e;
}

describe('outbox WAL', () => {
  it('writes before posting, deletes on success, classifies ephemeral bodies', () => {
    const h = home();
    expect(isEphemeralEvents(eventsBody(['prompt', 'edit', 'turn_end', 'cwd']).events)).toBe(true);
    expect(isEphemeralEvents(eventsBody([]).events)).toBe(true);
    expect(isEphemeralEvents(eventsBody(['edit', 'contract']).events)).toBe(false);
    const e = writeOutbox(h, { sessionId: 's1', kind: 'events', endpoint: '/v1/events', body: eventsBody(['contract']) });
    expect(e?.ephemeral).toBe(false);
    expect(existsSync(outboxPath(h, e!.id))).toBe(true);
    expect(listOutbox(h).entries.map((x) => x.id)).toEqual([e!.id]);
    expect(deleteOutbox(h, e!.id)).toBe(true);
    expect(listOutbox(h).entries).toEqual([]);
    expect(writeOutbox(h, { sessionId: 's1', kind: 'session_start', endpoint: '/v1/session/start', body: {} as never })?.ephemeral).toBe(true);
  });

  it('plans a drain: skip < 30 s, drop ephemeral > 24 h and everything > 7 d, cap, oldest first', () => {
    const h = home();
    const fresh = entryAt(h, 5_000, 'events', true);
    const ok = entryAt(h, 60_000, 'events', true);
    const oldEphemeral = entryAt(h, LIMITS.outboxEphemeralMaxAgeMs + 1000, 'events', true);
    const oldDurable = entryAt(h, LIMITS.outboxEphemeralMaxAgeMs + 1000, 'session_end', false);
    const ancient = entryAt(h, LIMITS.outboxMaxAgeMs + 1000, 'session_end', false);
    const plan = planDrain(listOutbox(h).entries, T0);
    expect(plan.skip).toEqual([fresh.id]);
    expect(plan.drop.sort()).toEqual([oldEphemeral.id, ancient.id].sort());
    expect(plan.send.map((e) => e.id)).toEqual([ancient.id, oldDurable.id, ok.id].filter((id) => id !== ancient.id));
    expect(plan.send[0]?.id).toBe(oldDurable.id); // oldest first
    const capped = planDrain(listOutbox(h).entries, T0, 1);
    expect(capped.send).toHaveLength(1);
  });

  it('adds replay: true to events and session_end bodies only', () => {
    const h = home();
    const e = entryAt(h, 60_000, 'events', false);
    expect((replayBody(e) as EventsRequest).replay).toBe(true);
    const d = writeOutbox(h, { sessionId: 's1', kind: 'depindex', endpoint: '/v1/depindex', body: { repo: 'r', head: 'h', builtAt: 'x', imports: {}, symbols: {}, contractPaths: {} } })!;
    expect('replay' in (replayBody(d) as object)).toBe(false);
  });

  it('drains oldest first, stops at the first transient failure, discards permanent rejections, removes broken files', async () => {
    const h = home();
    const a = entryAt(h, 90_000, 'events', false);
    const b = entryAt(h, 80_000, 'events', false);
    const c = entryAt(h, 70_000, 'events', false);
    writeFileSync(join(outboxDir(h), `${ulid(T0 - 50_000)}.json`), '{ broken');
    const seen: string[] = [];
    const r = await drainOutbox(
      h,
      async (entry, body) => {
        seen.push(entry.id);
        expect((body as EventsRequest).replay).toBe(true);
        return entry.id === b.id ? false : true;
      },
      { now: T0 },
    );
    expect(seen).toEqual([a.id, b.id]);
    expect(r.sent).toEqual([a.id]);
    expect(r.failedAt).toBe(b.id);
    expect(existsSync(outboxPath(h, b.id))).toBe(true);
    expect(existsSync(outboxPath(h, c.id))).toBe(true);
    expect(readdirSync(outboxDir(h))).toHaveLength(2); // broken file removed
    const r2 = await drainOutbox(h, async (entry) => (entry.id === b.id ? 'discard' : true), { now: T0 });
    expect(r2.dropped).toEqual([b.id]);
    expect(r2.failedAt).toBe(b.id);
    const r3 = await drainOutbox(h, async () => true, { now: T0 });
    expect(r3.sent).toEqual([c.id]);
    expect(readdirSync(outboxDir(h))).toHaveLength(0);
    // a throwing sender is a transient failure
    const d = entryAt(h, 60_000, 'events', false);
    const r4 = await drainOutbox(h, async () => { throw new Error('boom'); }, { now: T0 });
    expect(r4.failedAt).toBe(d.id);
    expect(existsSync(outboxPath(h, d.id))).toBe(true);
  });
});
