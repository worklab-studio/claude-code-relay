/**
 * Presence: states derived at read time from hub timestamps (§6.2), presence
 * records (§6.1), and the implicit file claim rule (§6.3). No cron, no stored
 * state is trusted — `deriveState` is the single source of truth.
 */
import { PRESENCE, STALENESS, type PresenceRecord, type SessionState, type SnapshotSession } from '@relay/core';
import type { DevRow, HeatRow, RepoRow, SessionRow } from './db/schema.js';
import { ageMs, iso } from './util/time.js';

export function deriveState(s: Pick<SessionRow, 'endedAt' | 'lastSeenAt' | 'inTurnSince'>, now: Date): SessionState {
  if (s.endedAt) return 'gone';
  const silent = ageMs(now, s.lastSeenAt);
  if (silent > PRESENCE.awayMs) return 'gone';
  if (silent <= PRESENCE.workingMs) return 'working';
  // "in a turn": a prompt with no Stop since, capped at 2 h (§6.2)
  if (s.inTurnSince && ageMs(now, s.inTurnSince) <= PRESENCE.inTurnCapMs) return 'working';
  if (silent <= PRESENCE.idleMs) return 'idle';
  return 'away';
}

export function isLive(s: Pick<SessionRow, 'endedAt' | 'lastSeenAt' | 'inTurnSince'>, now: Date): boolean {
  return deriveState(s, now) !== 'gone';
}

/** True when the state is `working` because of an open turn rather than a recent event. */
export function inLongTurn(s: Pick<SessionRow, 'endedAt' | 'lastSeenAt' | 'inTurnSince'>, now: Date): boolean {
  return (
    deriveState(s, now) === 'working' && ageMs(now, s.lastSeenAt) > PRESENCE.workingMs && s.inTurnSince !== null
  );
}

export function toPresenceRecord(s: SessionRow, dev: DevRow, repo: RepoRow, now: Date): PresenceRecord {
  return {
    dev: dev.handle,
    sessionId: s.id,
    client: s.client,
    host: s.host,
    repo: repo.slug,
    project: repo.project,
    branch: s.branch,
    worktree: s.worktree,
    area: s.area,
    objective: s.objective,
    objectiveSource: s.objectiveSource,
    state: deriveState(s, now),
    startedAt: s.startedAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    lastEditAt: iso(s.lastEditAt),
    inTurnSince: iso(s.inTurnSince),
    editCount: s.editCount,
    recentFiles: s.recentFiles,
    pluginSha: s.pluginSha,
    endedAt: iso(s.endedAt),
    endReason: s.endReason,
  };
}

export function toSnapshotSession(s: SessionRow, dev: DevRow, repo: RepoRow, now: Date): SnapshotSession {
  return {
    dev: dev.handle,
    id: s.id,
    client: s.client,
    host: s.host,
    branch: s.branch,
    worktree: s.worktree,
    area: s.area,
    objective: s.objective,
    state: deriveState(s, now),
    lastSeenAt: s.lastSeenAt.toISOString(),
    lastEditAt: iso(s.lastEditAt),
    inTurnSince: iso(s.inTurnSince),
    repo: repo.slug,
  };
}

/**
 * Implicit file claim (§6.3): another dev's live session seen within 30 min with
 * edit heat on the path within 15 min. Used by `claim` conflicts and `impact_of`.
 */
export function isImplicitlyClaimed(h: HeatRow, session: SessionRow | undefined, now: Date): boolean {
  if (h.kind !== 'edit') return false;
  if (ageMs(now, h.lastAt) > STALENESS.heatHotMs) return false;
  if (!session || session.endedAt) return false;
  return ageMs(now, session.lastSeenAt) <= STALENESS.implicitClaimSeenMs;
}
