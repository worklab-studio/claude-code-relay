/**
 * GET /v1/snapshot and GET /v1/query/* — the read tools of §9.2 (§10.4).
 * Every route takes `?repo=<slug>` (or falls back to the X-Relay-Session's repo).
 */
import { and, desc, eq, gte, ilike, inArray, isNull, or } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  STALENESS,
  type ChangeSetView,
  type ClaimRecord,
  type DecisionRecord,
  type DecisionsResponse,
  type Dependent,
  type Freshness,
  type HandoffsResponse,
  type HeatEntry,
  type ImpactOfResponse,
  type ImpactsResponse,
  type PresenceRecord,
  type RecentChangeItem,
  type RecentChangesResponse,
  type StatusDev,
  type StatusResponse,
  type WhoIsOnResponse,
} from '@relay/core';
import type { AppEnv } from '../auth.js';
import { decisions, depindex, devs, handoffs, heat, impacts, repos, type ClaimRow, type DevRow, type HeatRow, type RepoRow } from '../db/schema.js';
import {
  activeClaims,
  allRepos,
  changeSetsInRepos,
  changeSetsTargeting,
  heatSince,
  liveSessionsAll,
  liveSessionsInProject,
  reposInProject,
  unreadCounts,
  type ChangeSetBundle,
} from '../db/queries.js';
import { rowToRecord } from '../handoff.js';
import { sessionsByIds } from '../impact.js';
import { toPresenceRecord } from '../presence.js';
import { handoffLine } from '../render.js';
import { getSnapshot, toSnapshotChangeSet } from '../snapshot.js';
import { areaOf, areaOwners, areasForTarget } from '../util/config.js';
import { targetCovers } from '../util/glob.js';
import { iso, parseSince } from '../util/time.js';
import { resolveRepo } from './common.js';

export const queryRoutes = new Hono<AppEnv>();

function fresh(now: Date): Freshness {
  return { source: 'hub', at: now.toISOString() };
}

export function claimRecord(c: ClaimRow, dev: DevRow, repo: RepoRow): ClaimRecord {
  return {
    id: c.id,
    repo: repo.slug,
    dev: dev.handle,
    sessionId: c.sessionId,
    target: c.target,
    note: c.note,
    hard: c.hard,
    keep: c.keep,
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
    releasedAt: iso(c.releasedAt),
  };
}

export function heatEntry(h: HeatRow, dev: DevRow, me: DevRow, objective: string | null = null): HeatEntry {
  return {
    path: h.path,
    dev: dev.handle,
    sessionId: h.sessionId,
    mine: dev.id === me.id,
    branch: h.branch,
    objective,
    kind: h.kind,
    at: h.lastAt.toISOString(),
    pushed: h.pushed,
    headSha: h.headSha,
    blobId: h.blobId,
    count: h.count,
  };
}

function decisionRecord(d: typeof decisions.$inferSelect, dev: DevRow, repo: RepoRow | null): DecisionRecord {
  return {
    id: d.id,
    repo: repo?.slug ?? '',
    project: d.project,
    dev: dev.handle,
    sessionId: d.sessionId,
    topic: d.topic,
    area: d.area,
    text: d.text,
    source: d.source,
    confidence: d.confidence,
    supersedes: d.supersedes,
    createdAt: d.createdAt.toISOString(),
  };
}

function changeSetView(b: ChangeSetBundle, viewerRepo: RepoRow | null, repoSlugById: Map<string, string>): ChangeSetView {
  return {
    ...toSnapshotChangeSet(b, viewerRepo),
    sessionId: b.changeSet.sessionId,
    firstAt: b.changeSet.firstAt.toISOString(),
    stableSince: iso(b.changeSet.stableSince),
    acked: b.changeSet.acked,
    targets: b.targets.map((t) => ({
      changeSetId: t.changeSetId,
      dev: repoSlugById.get(`dev:${t.devId}`) ?? t.devId,
      repo: repoSlugById.get(t.repoId) ?? t.repoId,
      dependents: t.dependents,
      priority: t.priority,
      deliveredAt: iso(t.deliveredAt),
      ackedAt: iso(t.ackedAt),
      ackNote: t.ackNote,
    })),
  };
}

queryRoutes.get('/snapshot', async (c) => {
  const hub = c.get('hub');
  const { repo, sessionId } = await resolveRepo(c);
  const snapshot = await getSnapshot(hub, { repo, dev: c.get('dev'), sessionId, warn: c.get('warn') });
  return c.json(snapshot);
});

queryRoutes.get('/query/status', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const scope: 'current' | 'all' = c.req.query('project') === 'all' ? 'all' : 'current';
  const { repo, sessionId } = await resolveRepo(c);
  const live = scope === 'all' ? await liveSessionsAll(hub, now) : await liveSessionsInProject(hub, repo.project, now);
  const repoRows = scope === 'all' ? await allRepos(hub) : await reposInProject(hub, repo.project);
  const claimRows = (await Promise.all(repoRows.map((r) => activeClaims(hub, r.id, now).then((rows) => rows.map((x) => ({ ...x, repo: r })))))).flat();

  const projects = new Map<string, { project: string; repos: Set<string>; devs: Map<string, StatusDev> }>();
  const ensureProject = (p: string) => {
    let entry = projects.get(p);
    if (!entry) {
      entry = { project: p, repos: new Set(), devs: new Map() };
      projects.set(p, entry);
    }
    return entry;
  };
  for (const r of repoRows) ensureProject(r.project).repos.add(r.slug);
  const ensureDev = (p: string, dev: DevRow) => {
    const entry = ensureProject(p);
    let d = entry.devs.get(dev.handle);
    if (!d) {
      d = { dev: dev.handle, sessions: [], claims: [], lastSeenAt: null };
      entry.devs.set(dev.handle, d);
    }
    return d;
  };
  for (const s of live) {
    const d = ensureDev(s.repo.project, s.dev);
    d.sessions.push(toPresenceRecord(s.session, s.dev, s.repo, now));
    const seen = s.session.lastSeenAt.toISOString();
    if (!d.lastSeenAt || seen > d.lastSeenAt) d.lastSeenAt = seen;
  }
  for (const cl of claimRows) {
    ensureDev(cl.repo.project, cl.dev).claims.push(claimRecord(cl.claim, cl.dev, cl.repo));
  }
  const counts = await unreadCounts(hub, me.id, repo.id, now);
  const response: StatusResponse = {
    at: now.toISOString(),
    scope,
    projects: [...projects.values()].map((p) => ({ project: p.project, repos: [...p.repos], devs: [...p.devs.values()] })),
    me: { dev: me.handle, sessionId, ...counts },
    freshness: fresh(now),
  };
  return c.json(response);
});

queryRoutes.get('/query/who_is_on', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const target = (c.req.query('target') ?? '').trim();
  const { repo } = await resolveRepo(c);
  const cfg = hub.configOf(repo);
  const targetKind: WhoIsOnResponse['targetKind'] = cfg.areas[target] ? 'area' : /[*?{]/.test(target) ? 'glob' : 'path';
  const covers = (path: string): boolean => {
    if (targetKind === 'area') return areaOf(path, cfg.areas) === target;
    return targetCovers(target, path);
  };
  const areaNames = targetKind === 'area' ? [target] : areasForTarget(target, cfg.areas);

  const live = await liveSessionsInProject(hub, repo.project, now);
  const heatRows = await heatSince(hub, repo.id, new Date(now.getTime() - STALENESS.warmMs));
  const sessionIds = new Set(heatRows.filter((h) => covers(h.heat.path)).map((h) => h.heat.sessionId));
  const liveMatching = live.filter(
    (s) => s.repo.id === repo.id && (sessionIds.has(s.session.id) || (s.session.area !== null && areaNames.some((a) => s.session.area === a || s.session.area?.includes(a)))) ,
  );
  const sessionObjectives = new Map(live.map((s) => [s.session.id, s.session.objective]));
  const claimRows = await activeClaims(hub, repo.id, now);
  const response: WhoIsOnResponse = {
    at: now.toISOString(),
    target,
    targetKind,
    live: liveMatching.map((s) => toPresenceRecord(s.session, s.dev, s.repo, now)),
    recentEditors: heatRows.filter((h) => h.heat.kind !== 'dirty' && covers(h.heat.path)).map((h) => heatEntry(h.heat, h.dev, me, sessionObjectives.get(h.heat.sessionId) ?? null)),
    dirty: heatRows.filter((h) => h.heat.kind === 'dirty' && covers(h.heat.path)).map((h) => heatEntry(h.heat, h.dev, me, sessionObjectives.get(h.heat.sessionId) ?? null)),
    claims: claimRows.filter((cl) => targetCovers(cl.claim.target, target) || targetCovers(target, cl.claim.target) || areaNames.includes(cl.claim.target)).map((cl) => claimRecord(cl.claim, cl.dev, repo)),
    freshness: fresh(now),
  };
  return c.json(response);
});

queryRoutes.get('/query/recent_changes', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const { repo } = await resolveRepo(c);
  const area = c.req.query('area') ?? null;
  const kind = (c.req.query('kind') ?? 'all') as 'contracts' | 'commits' | 'edits' | 'all';
  const since = parseSince(c.req.query('since'), now, 7 * 86_400_000);
  const projectRepos = await reposInProject(hub, repo.project);
  const items: RecentChangeItem[] = [];

  if (kind === 'contracts' || kind === 'all') {
    const bundles = await changeSetsInRepos(hub, projectRepos.map((r) => r.id), since);
    for (const b of bundles) {
      if (b.author.id === me.id) continue;
      for (const i of b.impacts) {
        if (i.supersededBy) continue;
        if (area && areaOf(i.path, hub.configOf(b.sourceRepo).areas) !== area && !b.targets.some((t) => t.dependents.some((d) => d.area === area))) continue;
        items.push({
          kind: 'contract',
          at: i.updatedAt.toISOString(),
          dev: b.author.handle,
          repo: b.sourceRepo.slug,
          branch: i.branch,
          changeSetId: b.changeSet.id,
          impactId: i.id,
          rev: i.rev,
          path: i.path,
          symbols: i.symbols,
          summary: i.summary,
          hunk: i.hunk,
          status: i.status,
          priority: b.changeSet.priority,
          commitSha: i.commitSha,
        });
      }
    }
  }
  if (kind === 'commits' || kind === 'edits' || kind === 'all') {
    for (const r of projectRepos) {
      const rows = await heatSince(hub, r.id, since);
      const rcfg = hub.configOf(r);
      const byCommit = new Map<string, { at: Date; dev: DevRow; branch: string; files: string[]; pushed: boolean }>();
      for (const h of rows) {
        if (h.dev.id === me.id) continue;
        if (area && areaOf(h.heat.path, rcfg.areas) !== area) continue;
        if (h.heat.kind === 'commit' && (kind === 'commits' || kind === 'all')) {
          const sha = h.heat.headSha ?? 'unknown';
          const entry = byCommit.get(sha) ?? { at: h.heat.lastAt, dev: h.dev, branch: h.heat.branch, files: [], pushed: h.heat.pushed };
          entry.files.push(h.heat.path);
          byCommit.set(sha, entry);
        } else if (h.heat.kind === 'edit' && (kind === 'edits' || kind === 'all')) {
          items.push({ kind: 'edit', at: h.heat.lastAt.toISOString(), dev: h.dev.handle, repo: r.slug, branch: h.heat.branch, path: h.heat.path, count: h.heat.count });
        }
      }
      for (const [sha, e] of byCommit) {
        items.push({ kind: 'commit', at: e.at.toISOString(), dev: e.dev.handle, repo: r.slug, branch: e.branch, sha, subject: '', pushed: e.pushed, files: e.files });
      }
    }
  }
  if (kind === 'all') {
    const hs = await hub.db
      .select({ handoff: handoffs, dev: devs, repo: repos })
      .from(handoffs)
      .innerJoin(devs, eq(handoffs.devId, devs.id))
      .innerJoin(repos, eq(handoffs.repoId, repos.id))
      .where(and(eq(handoffs.project, repo.project), gte(handoffs.generatedAt, since)))
      .orderBy(desc(handoffs.generatedAt))
      .limit(10);
    for (const h of hs) {
      if (h.dev.id === me.id) continue;
      items.push({
        kind: 'handoff',
        at: h.handoff.generatedAt.toISOString(),
        dev: h.dev.handle,
        repo: h.repo.slug,
        branch: h.handoff.branch,
        handoffId: h.handoff.id,
        objective: h.handoff.objective,
        line: handoffLine(h.handoff, h.dev),
      });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  const response: RecentChangesResponse = { at: now.toISOString(), since: since.toISOString(), items, freshness: fresh(now) };
  return c.json(response);
});

queryRoutes.get('/query/decisions', async (c) => {
  const hub = c.get('hub');
  const now = hub.now();
  const { repo } = await resolveRepo(c);
  const topic = c.req.query('topic') ?? null;
  const area = c.req.query('area') ?? null;
  const since = c.req.query('since') ? parseSince(c.req.query('since'), now, 30 * 86_400_000) : null;
  const rows = await hub.db
    .select({ decision: decisions, dev: devs, repo: repos })
    .from(decisions)
    .innerJoin(devs, eq(decisions.devId, devs.id))
    .leftJoin(repos, eq(decisions.repoId, repos.id))
    .where(
      and(
        eq(decisions.project, repo.project),
        area ? eq(decisions.area, area) : undefined,
        since ? gte(decisions.createdAt, since) : undefined,
        topic ? or(ilike(decisions.topic, `%${topic}%`), ilike(decisions.text, `%${topic}%`)) : undefined,
      ),
    )
    .orderBy(desc(decisions.createdAt))
    .limit(50);
  const response: DecisionsResponse = { at: now.toISOString(), items: rows.map((r) => decisionRecord(r.decision, r.dev, r.repo)) };
  return c.json(response);
});

queryRoutes.get('/query/handoffs', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const devParam = c.req.query('dev');
  const n = Math.min(20, Math.max(1, Number(c.req.query('n') ?? 3) || 3));
  const repoParam = c.req.query('repo');
  const { repo } = await resolveRepo(c);
  const full = c.req.query('full') === 'true';
  let devFilter: DevRow | null = null;
  if (devParam === 'me') devFilter = me;
  else if (devParam) devFilter = await hub.devByHandle(devParam, false);
  const rows = await hub.db
    .select({ handoff: handoffs, dev: devs, repo: repos })
    .from(handoffs)
    .innerJoin(devs, eq(handoffs.devId, devs.id))
    .innerJoin(repos, eq(handoffs.repoId, repos.id))
    .where(and(repoParam ? eq(handoffs.repoId, repo.id) : eq(handoffs.project, repo.project), devFilter ? eq(handoffs.devId, devFilter.id) : undefined))
    .orderBy(desc(handoffs.generatedAt))
    .limit(n);
  const items = rows.map((r) => {
    const rec = rowToRecord(r.handoff, r.dev, r.repo);
    if (!full) rec.changed = rec.changed.slice(0, 5);
    return rec;
  });
  const response: HandoffsResponse = { at: now.toISOString(), items, freshness: fresh(now) };
  return c.json(response);
});

queryRoutes.get('/query/impacts', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const { repo } = await resolveRepo(c);
  const mine = c.req.query('mine') !== 'false';
  const bundles = mine
    ? await changeSetsTargeting(hub, me.id, repo.id, now, { includeUnroutable: true })
    : await changeSetsInRepos(hub, (await reposInProject(hub, repo.project)).map((r) => r.id), new Date(now.getTime() - 7 * 86_400_000));
  const ids = new Map<string, string>();
  for (const b of bundles) {
    for (const t of b.targets) {
      const r = await hub.repoById(t.repoId);
      if (r) ids.set(t.repoId, r.slug);
      const d = await hub.devById(t.devId);
      if (d) ids.set(`dev:${t.devId}`, d.handle);
    }
  }
  const response: ImpactsResponse = { at: now.toISOString(), changeSets: bundles.map((b) => changeSetView(b, repo, ids)), freshness: fresh(now) };
  return c.json(response);
});

queryRoutes.get('/query/impact_of', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const { repo } = await resolveRepo(c);
  const cfg = hub.configOf(repo);
  const path = c.req.query('path') ?? null;
  const sha = c.req.query('sha') ?? null;
  const projectRepos = await reposInProject(hub, repo.project);
  const dependents: Dependent[] = [];
  let symbols: string[] = [];
  let kinds: ImpactOfResponse['kinds'] = [];
  const paths: string[] = [];
  if (path) paths.push(path);
  if (sha) {
    const rows = await hub.db.select().from(heat).where(and(eq(heat.repoId, repo.id), eq(heat.headSha, sha)));
    for (const r of rows) if (!paths.includes(r.path)) paths.push(r.path);
  }
  const known = await hub.db
    .select()
    .from(impacts)
    .where(and(eq(impacts.repoId, repo.id), paths.length > 0 ? inArray(impacts.path, paths) : undefined, isNull(impacts.supersededBy)))
    .orderBy(desc(impacts.updatedAt))
    .limit(20);
  for (const k of known) {
    symbols = [...new Set([...symbols, ...k.symbols])];
    kinds = [...new Set([...kinds, ...k.kinds])];
    for (const d of k.dependents ?? []) dependents.push({ path: d, area: areaOf(d, cfg.areas), via: 'import', repo: repo.slug });
  }
  const idxRows = projectRepos.length > 0 ? await hub.db.select().from(depindex).where(inArray(depindex.repoId, projectRepos.map((r) => r.id))) : [];
  for (const p of paths) {
    const noExt = p.replace(/\.[a-z0-9]+$/i, '');
    const base = noExt.split('/').pop() ?? noExt;
    for (const idx of idxRows) {
      const r = projectRepos.find((x) => x.id === idx.repoId);
      if (!r) continue;
      const rcfg = hub.configOf(r);
      const found = new Set<string>();
      for (const [spec, files] of Object.entries(idx.imports)) {
        if (spec === noExt || spec === p || spec.endsWith('/' + noExt) || noExt.endsWith('/' + spec) || cfg.contracts.packages.some((pkg) => spec === pkg || spec === `${pkg}/${base}`)) {
          for (const f of files) found.add(f);
        }
      }
      for (const s of symbols) for (const f of idx.symbols[s] ?? []) found.add(f);
      for (const f of idx.contractPaths[base] ?? []) found.add(f);
      for (const f of found) if (f !== p) dependents.push({ path: f, area: areaOf(f, rcfg.areas), via: 'import', repo: r.slug });
    }
  }
  const seen = new Set<string>();
  const uniqueDependents = dependents.filter((d) => {
    const key = `${d.repo}|${d.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const area = path ? areaOf(path, cfg.areas) : null;
  const owners = [...new Set(uniqueDependents.flatMap((d) => areaOwners(d.area, cfg)).concat(areaOwners(area, cfg)))];
  const live = await liveSessionsInProject(hub, repo.project, now);
  const heatRows = await heatSince(hub, repo.id, new Date(now.getTime() - STALENESS.warmMs));
  const relevant = heatRows.filter((h) => paths.includes(h.heat.path) || uniqueDependents.some((d) => d.repo === repo.slug && d.path === h.heat.path));
  const sessionRows = await sessionsByIds(hub, relevant.map((h) => h.heat.sessionId));
  const active: PresenceRecord[] = live
    .filter((s) => relevant.some((h) => h.heat.sessionId === s.session.id) || (area !== null && s.session.area === area))
    .map((s) => toPresenceRecord(s.session, s.dev, s.repo, now));
  const openChangeSets = [...new Set(known.filter((k) => k.status !== 'withdrawn' && k.status !== 'merged').map((k) => k.changeSetId))];
  const response: ImpactOfResponse = {
    at: now.toISOString(),
    path,
    sha,
    symbols,
    kinds,
    dependents: uniqueDependents,
    owners,
    active,
    heat: relevant.map((h) => heatEntry(h.heat, h.dev, me, sessionRows.get(h.heat.sessionId)?.objective ?? null)),
    openChangeSets,
  };
  return c.json(response);
});
