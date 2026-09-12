/**
 * Admin routes (§10.4, §11.2), admin token only: POST /admin/token/rotate,
 * GET /admin/export?project=, DELETE /admin/purge?repo=.
 *
 * Rotation on the hub records `rotatedAt` (the 14-day grace counts from it) and,
 * when the body carries `current`, swaps the in-process tokens — the persistent
 * values live in the deployment's environment (RELAY_TEAM_TOKEN[_PREV]) and are
 * written there by the admin CLI.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { LIMITS, type AdminExport, type PurgeResponse, type TokenRotateResponse } from '@relay/core';
import type { AppEnv } from '../auth.js';
import {
  changeSets,
  claims,
  decisions,
  depindex,
  devRepo,
  devs,
  events,
  handoffDrafts,
  handoffs,
  heat,
  impactTargets,
  impacts,
  meta,
  notifications,
  repos,
  sessions,
  turns,
} from '../db/schema.js';
import { changeSetsInRepos, reposInProject } from '../db/queries.js';
import { rowToRecord } from '../handoff.js';
import { toPresenceRecord } from '../presence.js';
import { HttpError, readJson, str } from './common.js';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.post('/token/rotate', async (c) => {
  const hub = c.get('hub');
  const now = hub.now();
  const body = await readJson(c);
  const next = str(body['current']);
  if (next) {
    hub.tokens.previous = hub.tokens.current;
    hub.tokens.current = next;
  }
  hub.tokens.rotatedAt = now;
  await hub.db
    .insert(meta)
    .values({ key: 'token_rotated_at', value: now.toISOString() })
    .onConflictDoUpdate({ target: meta.key, set: { value: now.toISOString() } });
  const response: TokenRotateResponse = {
    ok: true,
    rotatedAt: now.toISOString(),
    graceUntil: new Date(now.getTime() + LIMITS.tokenGraceMs).toISOString(),
  };
  return c.json(response);
});

adminRoutes.get('/export', async (c) => {
  const hub = c.get('hub');
  const now = hub.now();
  const project = c.req.query('project');
  if (!project) throw new HttpError(400, 'project_required');
  const projectRepos = await reposInProject(hub, project);
  const repoIds = projectRepos.map((r) => r.id);
  if (repoIds.length === 0) throw new HttpError(404, 'unknown_project');
  const sessionRows = await hub.db
    .select({ session: sessions, dev: devs, repo: repos })
    .from(sessions)
    .innerJoin(devs, eq(sessions.devId, devs.id))
    .innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(inArray(sessions.repoId, repoIds));
  const handoffRows = await hub.db
    .select({ handoff: handoffs, dev: devs, repo: repos })
    .from(handoffs)
    .innerJoin(devs, eq(handoffs.devId, devs.id))
    .innerJoin(repos, eq(handoffs.repoId, repos.id))
    .where(eq(handoffs.project, project));
  const decisionRows = await hub.db
    .select({ decision: decisions, dev: devs, repo: repos })
    .from(decisions)
    .innerJoin(devs, eq(decisions.devId, devs.id))
    .innerJoin(repos, eq(decisions.repoId, repos.id))
    .where(eq(decisions.project, project));
  const bundles = await changeSetsInRepos(hub, repoIds, new Date(0));
  const response: AdminExport = {
    project,
    exportedAt: now.toISOString(),
    sessions: sessionRows.map((r) => toPresenceRecord(r.session, r.dev, r.repo, now)),
    handoffs: handoffRows.map((r) => rowToRecord(r.handoff, r.dev, r.repo)),
    decisions: decisionRows.map((r) => ({
      id: r.decision.id,
      repo: r.repo.slug,
      project: r.decision.project,
      dev: r.dev.handle,
      sessionId: r.decision.sessionId,
      topic: r.decision.topic,
      area: r.decision.area,
      text: r.decision.text,
      source: r.decision.source,
      confidence: r.decision.confidence,
      supersedes: r.decision.supersedes,
      createdAt: r.decision.createdAt.toISOString(),
    })),
    changeSets: bundles.map((b) => ({
      id: b.changeSet.id,
      repo: b.sourceRepo.slug,
      dev: b.author.handle,
      sessionId: b.changeSet.sessionId,
      branch: b.changeSet.branch,
      status: b.changeSet.status,
      priority: b.changeSet.priority,
      firstAt: b.changeSet.firstAt.toISOString(),
      lastAt: b.changeSet.lastAt.toISOString(),
      stableSince: b.changeSet.stableSince?.toISOString() ?? null,
      acked: b.changeSet.acked,
    })),
    impacts: bundles.flatMap((b) =>
      b.impacts.map((i) => ({
        id: i.id,
        changeSetId: i.changeSetId,
        repo: b.sourceRepo.slug,
        dev: b.author.handle,
        sessionId: i.sessionId,
        path: i.path,
        symbols: i.symbols,
        kinds: i.kinds,
        summary: i.summary,
        hunk: i.hunk,
        hash: i.hash,
        blobId: i.blobId,
        branch: i.branch,
        status: i.status,
        commitSha: i.commitSha,
        patchId: i.patchId,
        authorEmail: i.authorEmail,
        rev: i.rev,
        supersededBy: i.supersededBy,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      })),
    ),
  };
  return c.json(response);
});

adminRoutes.delete('/purge', async (c) => {
  const hub = c.get('hub');
  const slug = c.req.query('repo');
  if (!slug) throw new HttpError(400, 'repo_required');
  const repo = await hub.repoBySlug(slug);
  if (!repo) throw new HttpError(404, 'unknown_repo');
  const deleted: Record<string, number> = {};
  const count = async (name: string, p: Promise<Array<unknown>>) => {
    deleted[name] = (await p).length;
  };
  const sessionIds = (await hub.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.repoId, repo.id))).map((r) => r.id);
  const csIds = (await hub.db.select({ id: changeSets.id }).from(changeSets).where(eq(changeSets.repoId, repo.id))).map((r) => r.id);
  await count('impact_targets', hub.db.delete(impactTargets).where(csIds.length > 0 ? inArray(impactTargets.changeSetId, csIds) : eq(impactTargets.repoId, repo.id)).returning({ id: impactTargets.changeSetId }));
  await count('impact_targets_here', hub.db.delete(impactTargets).where(eq(impactTargets.repoId, repo.id)).returning({ id: impactTargets.changeSetId }));
  await count('impacts', hub.db.delete(impacts).where(eq(impacts.repoId, repo.id)).returning({ id: impacts.id }));
  await count('change_sets', hub.db.delete(changeSets).where(eq(changeSets.repoId, repo.id)).returning({ id: changeSets.id }));
  await count('notifications', hub.db.delete(notifications).where(eq(notifications.repoId, repo.id)).returning({ id: notifications.id }));
  await count('heat', hub.db.delete(heat).where(eq(heat.repoId, repo.id)).returning({ id: heat.path }));
  await count('claims', hub.db.delete(claims).where(eq(claims.repoId, repo.id)).returning({ id: claims.id }));
  await count('decisions', hub.db.delete(decisions).where(eq(decisions.repoId, repo.id)).returning({ id: decisions.id }));
  await count('handoffs', hub.db.delete(handoffs).where(eq(handoffs.repoId, repo.id)).returning({ id: handoffs.id }));
  if (sessionIds.length > 0) {
    await count('handoff_drafts', hub.db.delete(handoffDrafts).where(inArray(handoffDrafts.sessionId, sessionIds)).returning({ id: handoffDrafts.sessionId }));
    await count('turns', hub.db.delete(turns).where(inArray(turns.sessionId, sessionIds)).returning({ id: turns.sessionId }));
  }
  await count('events', hub.db.delete(events).where(eq(events.repoId, repo.id)).returning({ id: events.id }));
  await count('sessions', hub.db.delete(sessions).where(eq(sessions.repoId, repo.id)).returning({ id: sessions.id }));
  await count('dev_repo', hub.db.delete(devRepo).where(eq(devRepo.repoId, repo.id)).returning({ id: devRepo.devId }));
  await count('depindex', hub.db.delete(depindex).where(eq(depindex.repoId, repo.id)).returning({ id: depindex.repoId }));
  await count('repos', hub.db.delete(repos).where(and(eq(repos.id, repo.id))).returning({ id: repos.id }));
  hub.cache.repos.delete(slug);
  hub.cache.configs.delete(repo.id);
  hub.cache.snapshots.clear();
  const response: PurgeResponse = { ok: true, repo: slug, deleted };
  return c.json(response);
});
