/**
 * Snapshot document (§10.2): returned on every hub response and served for
 * GET /v1/snapshot from a per-instance in-memory cache (<= 10 s TTL, invalidated by
 * any write for that repo in the same instance). Computed from indexed tables:
 * live sessions of the project, 24 h heat with per-kind caps, others' claims,
 * change sets targeting the caller (routable, unacked, dependents filtered to this
 * repo) and the undelivered inbox.
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  STALENESS,
  type HeatEntry,
  type HubWarning,
  type InboxItem,
  type NoteKind,
  type Snapshot,
  type SnapshotChangeSet,
  type SnapshotClaim,
} from '@relay/core';
import type { Hub } from './hub.js';
import type { DevRow, RepoRow } from './db/schema.js';
import {
  activeClaims,
  changeSetsTargeting,
  heatSince,
  liveSessionsInProject,
  undeliveredNotifications,
  type ChangeSetBundle,
  type NotificationWithFrom,
} from './db/queries.js';
import { toSnapshotSession } from './presence.js';

export const SNAPSHOT_CACHE_TTL_MS = 10_000;

export interface SnapshotContext {
  repo: RepoRow;
  dev: DevRow;
  sessionId: string | null;
  warn?: HubWarning[];
}

export async function getSnapshot(hub: Hub, ctx: SnapshotContext): Promise<Snapshot> {
  const key = `${ctx.repo.slug}|${ctx.dev.id}|${ctx.sessionId ?? ''}`;
  const nowMs = hub.now().getTime();
  const hit = hub.cache.snapshots.get(key);
  if (hit && nowMs - hit.at < SNAPSHOT_CACHE_TTL_MS) {
    const cached = hit.value as Snapshot;
    return ctx.warn && ctx.warn.length > 0 ? { ...cached, warn: ctx.warn } : cached;
  }
  const snapshot = await buildSnapshot(hub, ctx);
  hub.cache.snapshots.set(key, { at: nowMs, value: ctx.warn ? { ...snapshot, warn: undefined } : snapshot, repo: ctx.repo.slug });
  return snapshot;
}

export async function buildSnapshot(hub: Hub, ctx: SnapshotContext): Promise<Snapshot> {
  const now = hub.now();
  const { repo, dev } = ctx;
  const config = hub.configOf(repo);

  const [live, heatRows, claimRows, bundles, inboxRows] = await Promise.all([
    liveSessionsInProject(hub, repo.project, now),
    heatSince(hub, repo.id, new Date(now.getTime() - STALENESS.warmMs)),
    activeClaims(hub, repo.id, now),
    changeSetsTargeting(hub, dev.id, repo.id, now),
    undeliveredNotifications(hub, dev.id),
  ]);

  const sessionsById = new Map(live.map((r) => [r.session.id, r]));

  const heatEntries: HeatEntry[] = [];
  const perKind: Record<string, number> = { edit: 0, commit: 0, dirty: 0 };
  const caps: Record<string, number> = { edit: LIMITS.heatEditCap, commit: LIMITS.heatCommitCap, dirty: LIMITS.heatDirtyCap };
  for (const { heat: h, dev: hd } of heatRows) {
    const used = perKind[h.kind] ?? 0;
    if (used >= (caps[h.kind] ?? 0)) continue;
    perKind[h.kind] = used + 1;
    const session = sessionsById.get(h.sessionId)?.session;
    heatEntries.push({
      path: h.path,
      dev: hd.handle,
      sessionId: h.sessionId,
      mine: hd.id === dev.id,
      branch: h.branch,
      objective: session?.objective ?? null,
      kind: h.kind,
      at: h.lastAt.toISOString(),
      pushed: h.pushed,
      headSha: h.headSha,
      blobId: h.blobId,
      count: h.count,
    });
  }

  const claimEntries: SnapshotClaim[] = claimRows
    .filter((c) => c.dev.id !== dev.id)
    .map((c) => ({
      id: c.claim.id,
      dev: c.dev.handle,
      target: c.claim.target,
      note: c.claim.note,
      hard: c.claim.hard,
      expiresAt: c.claim.expiresAt.toISOString(),
    }));

  const snapshot: Snapshot = {
    v: PROTOCOL_VERSION,
    serverTime: now.toISOString(),
    repo: { slug: repo.slug, project: repo.project, config },
    me: { dev: dev.handle, sessionId: ctx.sessionId },
    sessions: live.map((r) => toSnapshotSession(r.session, r.dev, r.repo, now)),
    heat: heatEntries,
    claims: claimEntries,
    changeSets: bundles.map((b) => toSnapshotChangeSet(b, repo)),
    inbox: inboxRows.map(toInboxItem),
    minClient: hub.minClient,
  };
  if (ctx.warn && ctx.warn.length > 0) snapshot.warn = ctx.warn;
  return snapshot;
}

export function toSnapshotChangeSet(b: ChangeSetBundle, viewerRepo: RepoRow | null): SnapshotChangeSet {
  const cs = b.changeSet;
  const targetsForRepo = viewerRepo ? b.targets.filter((t) => t.repoId === viewerRepo.id) : b.targets;
  const dependents = (b.target ? [b.target] : targetsForRepo).flatMap((t) => t.dependents);
  return {
    id: cs.id,
    by: b.author.handle,
    branch: cs.branch,
    status: cs.status,
    priority: b.target?.priority ?? cs.priority,
    at: cs.lastAt.toISOString(),
    impacts: b.impacts
      .filter((i) => i.supersededBy === null)
      .map((i) => ({
        id: i.id,
        rev: i.rev,
        path: i.path,
        symbols: i.symbols,
        summary: i.summary,
        hunk: i.hunk,
        blobId: i.blobId,
        commitSha: i.commitSha,
        status: i.status,
      })),
    dependents,
    repo: b.sourceRepo.slug,
  };
}

export function toInboxItem(r: NotificationWithFrom): InboxItem {
  const n = r.notification;
  const item: InboxItem = {
    id: n.id,
    kind: n.kind,
    from: r.from?.handle ?? null,
    body: n.body,
    ref: n.refId,
    at: n.createdAt.toISOString(),
  };
  if (n.noteKind) item.noteKind = n.noteKind as NoteKind;
  return item;
}
