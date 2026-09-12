/**
 * Shared reads over the schema, with joins resolved to dev handles and repo slugs.
 * Every module that renders (snapshot, digest, query routes, sweep) goes through
 * these so the same filters (live window, routability, unacked) apply everywhere.
 */
import { and, desc, eq, gt, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { LIMITS, PRESENCE, type RelayConfigResolved } from '@relay/core';
import type { Hub } from '../hub.js';
import {
  changeSets,
  claims,
  devs,
  heat,
  impactTargets,
  impacts,
  notifications,
  repos,
  sessions,
  type ChangeSetRow,
  type ClaimRow,
  type DevRow,
  type HeatRow,
  type ImpactRow,
  type ImpactTargetRow,
  type NotificationRow,
  type RepoRow,
  type SessionRow,
} from './schema.js';
import { ageMs } from '../util/time.js';

export interface SessionWithRefs {
  session: SessionRow;
  dev: DevRow;
  repo: RepoRow;
}

export async function reposInProject(hub: Hub, project: string): Promise<RepoRow[]> {
  const rows = await hub.db
    .select()
    .from(repos)
    .where(and(eq(repos.teamId, hub.team.id), eq(repos.project, project)));
  for (const r of rows) hub.cache.repos.set(r.slug, r);
  return rows;
}

export async function allRepos(hub: Hub): Promise<RepoRow[]> {
  return hub.db.select().from(repos).where(eq(repos.teamId, hub.team.id));
}

/** Live sessions (not ended, seen within the 2 h window) of every repo of a project, mine included (§10.2). */
export async function liveSessionsInProject(hub: Hub, project: string, now: Date): Promise<SessionWithRefs[]> {
  const since = new Date(now.getTime() - PRESENCE.awayMs);
  return hub.db
    .select({ session: sessions, dev: devs, repo: repos })
    .from(sessions)
    .innerJoin(devs, eq(sessions.devId, devs.id))
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(and(eq(repos.teamId, hub.team.id), eq(repos.project, project), isNull(sessions.endedAt), gt(sessions.lastSeenAt, since)))
    .orderBy(desc(sessions.lastSeenAt));
}

export async function liveSessionsAll(hub: Hub, now: Date): Promise<SessionWithRefs[]> {
  const since = new Date(now.getTime() - PRESENCE.awayMs);
  return hub.db
    .select({ session: sessions, dev: devs, repo: repos })
    .from(sessions)
    .innerJoin(devs, eq(sessions.devId, devs.id))
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(and(eq(repos.teamId, hub.team.id), isNull(sessions.endedAt), gt(sessions.lastSeenAt, since)))
    .orderBy(desc(sessions.lastSeenAt));
}

export async function sessionById(hub: Hub, id: string): Promise<SessionWithRefs | null> {
  const [row] = await hub.db
    .select({ session: sessions, dev: devs, repo: repos })
    .from(sessions)
    .innerJoin(devs, eq(sessions.devId, devs.id))
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
}

/** Other live sessions of the same dev in the repo (claim release rule, §6.3). */
export async function otherLiveSessions(hub: Hub, devId: string, repoId: string, exceptSessionId: string, now: Date): Promise<SessionRow[]> {
  const since = new Date(now.getTime() - PRESENCE.awayMs);
  const rows = await hub.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.devId, devId), eq(sessions.repoId, repoId), isNull(sessions.endedAt), gt(sessions.lastSeenAt, since)));
  return rows.filter((s) => s.id !== exceptSessionId);
}

export interface HeatWithDev {
  heat: HeatRow;
  dev: DevRow;
}

/** Heat rows of a repo newer than `since` (24 h for the snapshot, 7 d for routing), newest first. */
export async function heatSince(hub: Hub, repoId: string, since: Date): Promise<HeatWithDev[]> {
  return hub.db
    .select({ heat, dev: devs })
    .from(heat)
    .innerJoin(devs, eq(heat.devId, devs.id))
    .where(and(eq(heat.repoId, repoId), gt(heat.lastAt, since)))
    .orderBy(desc(heat.lastAt));
}

export interface ClaimWithDev {
  claim: ClaimRow;
  dev: DevRow;
}

export async function activeClaims(hub: Hub, repoId: string, now: Date): Promise<ClaimWithDev[]> {
  return hub.db
    .select({ claim: claims, dev: devs })
    .from(claims)
    .innerJoin(devs, eq(claims.devId, devs.id))
    .where(and(eq(claims.repoId, repoId), isNull(claims.releasedAt), gt(claims.expiresAt, now)))
    .orderBy(desc(claims.createdAt));
}

export interface NotificationWithFrom {
  notification: NotificationRow;
  from: DevRow | null;
}

/** Undelivered notifications for a dev, oldest first; impact notifications are carried by change sets instead (snapshot.changeSets). */
export async function undeliveredNotifications(hub: Hub, devId: string, opts: { includeImpacts?: boolean } = {}): Promise<NotificationWithFrom[]> {
  const rows = await hub.db
    .select({ notification: notifications, from: devs })
    .from(notifications)
    .leftJoin(devs, eq(notifications.fromDevId, devs.id))
    .where(and(eq(notifications.toDevId, devId), isNull(notifications.deliveredAt)))
    .orderBy(notifications.createdAt);
  return rows.filter((r) => opts.includeImpacts || r.notification.kind !== 'impact');
}

export async function markDelivered(hub: Hub, ids: string[], devId: string, via: NotificationRow['deliveredVia'], now: Date): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await hub.db
    .update(notifications)
    .set({ deliveredAt: now, deliveredVia: via })
    .where(and(eq(notifications.toDevId, devId), isNull(notifications.deliveredAt), or(inArray(notifications.id, ids), inArray(notifications.refId, ids))))
    .returning({ id: notifications.id });
  await hub.db
    .update(impactTargets)
    .set({ deliveredAt: now })
    .where(and(eq(impactTargets.devId, devId), isNull(impactTargets.deliveredAt), inArray(impactTargets.changeSetId, ids)));
  return rows.length;
}

/**
 * Debounce rule (§7.5 step 7): a change set with any committed/pushed impact is
 * routable at once (a sibling file still in progress does not hold it back);
 * an all-uncommitted one after `debounce_minutes` of a stable hash.
 */
export function isRoutable(cs: ChangeSetRow, cfg: RelayConfigResolved, now: Date, impactRows: ImpactRow[]): boolean {
  if (cs.status === 'withdrawn') return false;
  if (cs.status !== 'uncommitted') return true;
  if (impactRows.some((i) => i.supersededBy === null && i.status !== 'withdrawn' && i.commitSha)) return true;
  if (!cs.stableSince) return false;
  return ageMs(now, cs.stableSince) >= cfg.impacts.debounce_minutes * 60_000;
}

export interface ChangeSetBundle {
  changeSet: ChangeSetRow;
  author: DevRow;
  sourceRepo: RepoRow;
  impacts: ImpactRow[];
  /** target row for the viewer; null in author/global views */
  target: ImpactTargetRow | null;
  targets: ImpactTargetRow[];
}

/** Change sets with an unacked target for (dev, repo), routable, within 7 days (§10.2 snapshot.changeSets). */
export async function changeSetsTargeting(
  hub: Hub,
  devId: string,
  repoId: string,
  now: Date,
  opts: { includeAcked?: boolean; includeUnroutable?: boolean } = {},
): Promise<ChangeSetBundle[]> {
  const since = new Date(now.getTime() - LIMITS.changeSetExpiryMs);
  const targetRows = await hub.db
    .select({ target: impactTargets, changeSet: changeSets, author: devs, sourceRepo: repos })
    .from(impactTargets)
    .innerJoin(changeSets, eq(impactTargets.changeSetId, changeSets.id))
    .innerJoin(devs, eq(changeSets.devId, devs.id))
    .innerJoin(repos, eq(changeSets.repoId, repos.id))
    .where(
      and(
        eq(impactTargets.devId, devId),
        eq(impactTargets.repoId, repoId),
        gt(changeSets.lastAt, since),
        opts.includeAcked ? undefined : isNull(impactTargets.ackedAt),
      ),
    )
    .orderBy(desc(changeSets.lastAt));
  const candidates = targetRows.filter((r) => r.changeSet.status !== 'withdrawn' && r.target.priority !== 'low');
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((r) => r.changeSet.id);
  const impactRows = await hub.db
    .select()
    .from(impacts)
    .where(and(inArray(impacts.changeSetId, candidateIds), isNull(impacts.supersededBy)))
    .orderBy(impacts.updatedAt);
  const filtered = candidates.filter(
    (r) => opts.includeUnroutable || isRoutable(r.changeSet, hub.configOf(r.sourceRepo), now, impactRows.filter((i) => i.changeSetId === r.changeSet.id)),
  );
  if (filtered.length === 0) return [];
  const ids = filtered.map((r) => r.changeSet.id);
  const allTargets = await hub.db.select().from(impactTargets).where(inArray(impactTargets.changeSetId, ids));
  return filtered.map((r) => ({
    changeSet: r.changeSet,
    author: r.author,
    sourceRepo: r.sourceRepo,
    impacts: impactRows.filter((i) => i.changeSetId === r.changeSet.id && i.status !== 'withdrawn'),
    target: r.target,
    targets: allTargets.filter((t) => t.changeSetId === r.changeSet.id),
  }));
}

/** Change sets of a repo (any author) newer than `since`, for recent_changes and the low-priority FYI line. */
export async function changeSetsInRepos(hub: Hub, repoIds: string[], since: Date): Promise<ChangeSetBundle[]> {
  if (repoIds.length === 0) return [];
  const rows = await hub.db
    .select({ changeSet: changeSets, author: devs, sourceRepo: repos })
    .from(changeSets)
    .innerJoin(devs, eq(changeSets.devId, devs.id))
    .innerJoin(repos, eq(changeSets.repoId, repos.id))
    .where(and(inArray(changeSets.repoId, repoIds), gte(changeSets.lastAt, since)))
    .orderBy(desc(changeSets.lastAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.changeSet.id);
  const impactRows = await hub.db.select().from(impacts).where(inArray(impacts.changeSetId, ids)).orderBy(impacts.updatedAt);
  const allTargets = await hub.db.select().from(impactTargets).where(inArray(impactTargets.changeSetId, ids));
  return rows.map((r) => ({
    changeSet: r.changeSet,
    author: r.author,
    sourceRepo: r.sourceRepo,
    impacts: impactRows.filter((i) => i.changeSetId === r.changeSet.id),
    target: null,
    targets: allTargets.filter((t) => t.changeSetId === r.changeSet.id),
  }));
}

export async function changeSetById(hub: Hub, id: string): Promise<ChangeSetBundle | null> {
  const [row] = await hub.db
    .select({ changeSet: changeSets, author: devs, sourceRepo: repos })
    .from(changeSets)
    .innerJoin(devs, eq(changeSets.devId, devs.id))
    .innerJoin(repos, eq(changeSets.repoId, repos.id))
    .where(eq(changeSets.id, id))
    .limit(1);
  if (!row) return null;
  const impactRows = await hub.db.select().from(impacts).where(eq(impacts.changeSetId, id)).orderBy(impacts.updatedAt);
  const allTargets = await hub.db.select().from(impactTargets).where(eq(impactTargets.changeSetId, id));
  return { changeSet: row.changeSet, author: row.author, sourceRepo: row.sourceRepo, impacts: impactRows, target: null, targets: allTargets };
}

/** Sessions silent for longer than `ms` and not ended (sweep, §6.2/§8.1). */
export async function silentSessions(hub: Hub, olderThan: Date): Promise<SessionRow[]> {
  return hub.db.select().from(sessions).where(and(isNull(sessions.endedAt), lt(sessions.lastSeenAt, olderThan)));
}

/** Count of unacked routable change sets and unread inbox items for the status tool (§9.2). */
export async function unreadCounts(hub: Hub, devId: string, repoId: string, now: Date): Promise<{ unackedChangeSets: number; unreadInbox: number }> {
  const cs = await changeSetsTargeting(hub, devId, repoId, now);
  const inbox = await undeliveredNotifications(hub, devId);
  return { unackedChangeSets: cs.length, unreadInbox: inbox.length };
}

