/**
 * Lazy sweep (§6.2, §8.1): runs inside /v1/session/start and /v1/events when the
 * last sweep is > 60 s old. Concurrent invocations are serialized by a conditional
 * update on `meta.last_sweep_at` used as a lock — only the winner sweeps.
 *
 * Work: auto-end sessions silent > 2 h (reason `timeout`) and synthesize their
 * handoff from the last Stop draft; interim handoffs for sessions idle >=
 * `handoff.idle_minutes` with unsummarized activity (never while in a turn);
 * promote uncommitted change sets whose debounce elapsed; release claims of devs
 * with no live session left; retention purges (events 30 d, turns 7 d).
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { PRESENCE } from '@relay/core';
import type { Hub } from './hub.js';
import { rowsOf } from './db/client.js';
import { claims, devRepo, events, handoffs, sessions, turns } from './db/schema.js';
import { otherLiveSessions, sessionById, silentSessions } from './db/queries.js';
import { generateHandoff } from './handoff.js';
import { promoteRoutable } from './impact.js';
import { deriveState } from './presence.js';
import { ageMs } from './util/time.js';

export interface SweepResult {
  ran: boolean;
  autoEnded: number;
  interimHandoffs: number;
  promoted: number;
  purgedEvents: number;
}

const EVENT_RETENTION_MS = 30 * 86_400_000;
const TURN_RETENTION_MS = 7 * 86_400_000;

/** Attempts the conditional-update lock; sweeps only when it wins (§6.2). */
export async function maybeSweep(hub: Hub, opts: { force?: boolean } = {}): Promise<SweepResult> {
  const now = hub.now();
  if (!opts.force) {
    const won = await acquireSweepLock(hub, now);
    if (!won) return { ran: false, autoEnded: 0, interimHandoffs: 0, promoted: 0, purgedEvents: 0 };
  }
  return sweep(hub, now);
}

export async function acquireSweepLock(hub: Hub, now: Date): Promise<boolean> {
  const rows = rowsOf(
    await hub.db.execute(sql`
      update meta set value = to_jsonb(${now.toISOString()}::text)
      where key = 'last_sweep_at'
        and (value #>> '{}')::timestamptz < ${now.toISOString()}::timestamptz - make_interval(secs => ${PRESENCE.sweepIntervalMs / 1000})
      returning key`),
  );
  return rows.length > 0;
}

export async function sweep(hub: Hub, now: Date): Promise<SweepResult> {
  const result: SweepResult = { ran: true, autoEnded: 0, interimHandoffs: 0, promoted: 0, purgedEvents: 0 };

  // 1. auto-end sessions silent for more than 2 h (§6.2 gone, §8.1 timeout)
  const stale = await silentSessions(hub, new Date(now.getTime() - PRESENCE.awayMs));
  for (const s of stale) {
    await endSession(hub, s.id, 'timeout', now);
    result.autoEnded += 1;
  }

  // 2. interim handoffs for idle sessions with unsummarized activity (§8.1)
  const candidates = await hub.db
    .select()
    .from(sessions)
    .where(and(isNull(sessions.endedAt), lt(sessions.lastSeenAt, new Date(now.getTime() - 3 * 60_000))));
  for (const s of candidates) {
    const state = deriveState(s, now);
    if (state !== 'idle' && state !== 'away') continue; // never while in a turn
    const ref = await sessionById(hub, s.id);
    if (!ref) continue;
    const idleMs = hub.configOf(ref.repo).handoff.idle_minutes * 60_000;
    if (ageMs(now, s.lastSeenAt) < idleMs) continue;
    if (s.editCount === 0 && s.commitCount === 0 && s.promptCount < 3) continue;
    const [existing] = await hub.db.select({ generatedAt: handoffs.generatedAt }).from(handoffs).where(eq(handoffs.sessionId, s.id)).limit(1);
    if (existing && existing.generatedAt >= s.lastSeenAt) continue; // already summarized
    const record = await generateHandoff(hub, s.id, { trigger: 'interim' });
    if (record) result.interimHandoffs += 1;
  }

  // 3. debounce promotion (§7.5 step 7)
  result.promoted = await promoteRoutable(hub, now);

  // 4. retention (§10.1, §11.2)
  const purged = await hub.db
    .delete(events)
    .where(lt(events.serverAt, new Date(now.getTime() - EVENT_RETENTION_MS)))
    .returning({ id: events.id });
  result.purgedEvents = purged.length;
  await hub.db.delete(turns).where(lt(turns.at, new Date(now.getTime() - TURN_RETENTION_MS)));
  await hub.db.execute(sql`delete from meta where key like 'handoff_lock:%' and (value #>> '{}')::timestamptz < ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`);

  return result;
}

/**
 * Ends a session (SessionEnd, crash, sweep timeout): presence gone, dev_repo
 * last_session_end_at, the dev's claims in the repo released when this was their
 * last live session there (unless keep), then the handoff in the background (§4.9).
 */
export async function endSession(
  hub: Hub,
  sessionId: string,
  reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other' | 'crash' | 'timeout',
  at: Date,
  opts: { generate?: boolean } = {},
): Promise<boolean> {
  const ref = await sessionById(hub, sessionId);
  if (!ref) return false;
  const { session, dev, repo } = ref;
  if (session.endedAt) return false; // replays never re-end (§10.4)
  const endedAt = at > session.lastSeenAt ? at : session.lastSeenAt;
  await hub.db.update(sessions).set({ endedAt, endReason: reason, state: 'gone', inTurnSince: null }).where(eq(sessions.id, sessionId));
  await hub.db
    .insert(devRepo)
    .values({ devId: dev.id, repoId: repo.id, homeAreas: [], lastSeenAt: endedAt, lastSessionEndAt: endedAt })
    .onConflictDoUpdate({ target: [devRepo.devId, devRepo.repoId], set: { lastSessionEndAt: endedAt } });
  const others = await otherLiveSessions(hub, dev.id, repo.id, sessionId, hub.now());
  if (others.length === 0) {
    await hub.db
      .update(claims)
      .set({ releasedAt: endedAt })
      .where(and(eq(claims.devId, dev.id), eq(claims.repoId, repo.id), eq(claims.keep, false), isNull(claims.releasedAt)));
  }
  hub.invalidateRepo(repo.slug);
  if (opts.generate !== false) {
    hub.background(`handoff:${sessionId}`, () => generateHandoff(hub, sessionId, { trigger: 'end', endReason: reason }));
  }
  return true;
}
