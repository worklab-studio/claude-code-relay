/**
 * Impact routing (§7.5) on every contract / commit / retract / push event.
 *
 * - impact records are unique on (repo, session, path, hash); a changed hash for
 *   the same (session, path) within 30 min supersedes in place (rev+1);
 * - impacts from the same (session, branch) less than 30 min apart share a change
 *   set; everything downstream (targets, notifications, acks) is per change set;
 * - dependents = client in-repo grep (or the author repo's depindex) ∪ cross-repo
 *   depindex lookups ∪ the `depends` map; developers are scored per area and
 *   `high` requires score >= 3 plus an import-derived dependent outside the
 *   author's area;
 * - uncommitted change sets are held back until their hash has been stable for
 *   `impacts.debounce_minutes` (isRoutable in queries.ts); notifications are
 *   created by promoteRoutable once that holds;
 * - commits whose author does not resolve to the sender never create impacts
 *   (they only auto-ack change sets whose content they carry, §7.2).
 */
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import {
  GENERIC_BASENAMES,
  LIMITS,
  type CommitEvent,
  type ContractEvent,
  type Dependent,
  type ImpactPriority,
  type ImpactStatus,
  type PushEvent,
  type RelayConfigResolved,
  type RetractEvent,
} from '@relay/core';
import type { Hub } from './hub.js';
import {
  changeSets,
  depindex,
  devRepo,
  heat,
  impactTargets,
  impacts,
  notifications,
  sessions,
  type ChangeSetRow,
  type DevRow,
  type ImpactRow,
  type ImpactTargetRow,
  type RepoRow,
  type SessionRow,
} from './db/schema.js';
import { changeSetById, isRoutable, liveSessionsInProject, reposInProject, type ChangeSetBundle } from './db/queries.js';
import { areaOf } from './util/config.js';
import { isValidHandle, newId } from './util/ids.js';
import { changeSetLine } from './render.js';

export interface EventContext {
  repo: RepoRow;
  dev: DevRow;
  session: SessionRow;
  config: RelayConfigResolved;
  at: Date;
}

// ---------------------------------------------------------------------------
// contract events
// ---------------------------------------------------------------------------

export async function recordContract(hub: Hub, ctx: EventContext, ev: ContractEvent): Promise<{ impact: ImpactRow; created: boolean }> {
  const branch = ev.branch ?? ctx.session.branch;
  const summary = ev.summary ?? summarize(ev.path, ev.symbols);
  const existing = await findByHash(hub, ctx.repo.id, ctx.session.id, ev.path, ev.hash);
  if (existing) {
    // idempotent replay of the same content: touch, never reset the debounce clock
    if (existing.dependents === null && ev.dependents !== null) {
      await hub.db.update(impacts).set({ dependents: ev.dependents }).where(eq(impacts.id, existing.id));
      await routeChangeSet(hub, existing.changeSetId, { reArm: false });
    }
    return { impact: existing, created: false };
  }

  const open = await latestOpen(hub, ctx.session.id, ev.path);
  const supersede = open && ctx.at.getTime() - open.updatedAt.getTime() <= LIMITS.changeSetMergeWindowMs ? open : null;
  const cs = supersede
    ? await hub.db.select().from(changeSets).where(eq(changeSets.id, supersede.changeSetId)).limit(1).then((r) => r[0] ?? null)
    : null;
  const changeSet = cs && cs.status !== 'withdrawn' ? cs : await findOrCreateChangeSet(hub, ctx, branch);

  const row: ImpactRow = {
    id: newId('impact', ctx.at.getTime()),
    changeSetId: changeSet.id,
    repoId: ctx.repo.id,
    devId: ctx.dev.id,
    sessionId: ctx.session.id,
    path: ev.path,
    symbols: ev.symbols,
    kinds: ev.kinds,
    summary,
    hunk: ev.hunk ?? null,
    hash: ev.hash,
    blobId: ev.blobId,
    branch,
    status: 'uncommitted',
    commitSha: null,
    patchId: null,
    authorEmail: null,
    rev: supersede ? supersede.rev + 1 : 1,
    supersededBy: null,
    dependents: ev.dependents ?? supersede?.dependents ?? null,
    createdAt: ctx.at,
    updatedAt: ctx.at,
  };
  await hub.db.insert(impacts).values(row).onConflictDoNothing();
  if (supersede) {
    await hub.db.update(impacts).set({ supersededBy: row.id, updatedAt: ctx.at }).where(eq(impacts.id, supersede.id));
  }
  await touchChangeSet(hub, changeSet.id, ctx.at, { resetStable: true });
  await routeChangeSet(hub, changeSet.id, { reArm: true });
  hub.invalidateRepo(ctx.repo.slug);
  return { impact: row, created: true };
}

// ---------------------------------------------------------------------------
// commit events
// ---------------------------------------------------------------------------

/** Emails that resolve to the sender: learned identity hints, the session's hint, the handle itself and its GitHub noreply form (§3.3). */
export function authorResolvesToSender(authorEmail: string, dev: DevRow, session: SessionRow): boolean {
  const email = authorEmail.trim().toLowerCase();
  if (!email) return false;
  const known = new Set<string>(dev.emails.map((e) => e.toLowerCase()));
  if (session.gitEmailHint) known.add(session.gitEmailHint.toLowerCase());
  if (known.size === 0) {
    // nothing known about this dev yet: the client already author-filters, accept
    return true;
  }
  if (known.has(email)) return true;
  const local = email.split('@')[0] ?? '';
  if (local === dev.handle.toLowerCase()) return true;
  const noreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (noreply && (noreply[1] === dev.github?.toLowerCase() || noreply[1] === dev.handle.toLowerCase())) return true;
  return false;
}

export async function recordCommit(hub: Hub, ctx: EventContext, ev: CommitEvent): Promise<{ own: boolean; impacts: ImpactRow[] }> {
  const own = authorResolvesToSender(ev.authorEmail, ctx.dev, ctx.session);
  const blobIds = ev.contracts.map((c) => c.blobId).filter((b): b is string => !!b);
  // any commit that carries a teammate's contract content marks that change set merged for the sender (§7.2 last row)
  await ackByContent(hub, ctx, blobIds);
  if (!own) return { own: false, impacts: [] };

  const branch = ev.branch ?? ctx.session.branch;
  const out: ImpactRow[] = [];
  for (const c of ev.contracts) {
    // a rebased commit with a known patch id updates the SHA instead of creating a record (§7.5 step 1).
    // Scoped to the sender: a teammate who lands the identical diff on their own branch keeps their own
    // record (their commit is an ack-by-content for ours, above, not a rebase of it).
    if (ev.patchId) {
      const [byPatch] = await hub.db
        .select()
        .from(impacts)
        .where(and(eq(impacts.repoId, ctx.repo.id), eq(impacts.devId, ctx.dev.id), eq(impacts.patchId, ev.patchId), eq(impacts.path, c.path)))
        .limit(1);
      if (byPatch) {
        if (byPatch.commitSha !== ev.sha) {
          await hub.db.update(impacts).set({ commitSha: ev.sha, updatedAt: ctx.at }).where(eq(impacts.id, byPatch.id));
        }
        out.push(byPatch);
        continue;
      }
    }
    const open = await latestOpen(hub, ctx.session.id, c.path);
    if (open) {
      const next: Partial<ImpactRow> = {
        commitSha: ev.sha,
        patchId: ev.patchId,
        blobId: c.blobId ?? open.blobId,
        authorEmail: ev.authorEmail,
        updatedAt: ctx.at,
      };
      if (open.status === 'uncommitted') next.status = 'committed';
      if (c.symbols.length > 0 && open.symbols.length === 0) next.symbols = c.symbols;
      if (c.hunk && !open.hunk) next.hunk = c.hunk;
      await hub.db.update(impacts).set(next).where(eq(impacts.id, open.id));
      await touchChangeSet(hub, open.changeSetId, ctx.at, { resetStable: false });
      await routeChangeSet(hub, open.changeSetId, { reArm: false });
      out.push({ ...open, ...next } as ImpactRow);
      continue;
    }
    const existing = await findByHash(hub, ctx.repo.id, ctx.session.id, c.path, c.hash);
    if (existing) {
      out.push(existing);
      continue;
    }
    // committed from a human editor: the edit was never seen, create the record as committed
    const changeSet = await findOrCreateChangeSet(hub, ctx, branch);
    const row: ImpactRow = {
      id: newId('impact', ctx.at.getTime()),
      changeSetId: changeSet.id,
      repoId: ctx.repo.id,
      devId: ctx.dev.id,
      sessionId: ctx.session.id,
      path: c.path,
      symbols: c.symbols,
      kinds: c.kinds ?? [],
      summary: summarize(c.path, c.symbols),
      hunk: c.hunk ?? null,
      hash: c.hash,
      blobId: c.blobId,
      branch,
      status: 'committed',
      commitSha: ev.sha,
      patchId: ev.patchId,
      authorEmail: ev.authorEmail,
      rev: 1,
      supersededBy: null,
      dependents: null,
      createdAt: ctx.at,
      updatedAt: ctx.at,
    };
    await hub.db.insert(impacts).values(row).onConflictDoNothing();
    await touchChangeSet(hub, changeSet.id, ctx.at, { resetStable: false });
    await routeChangeSet(hub, changeSet.id, { reArm: true });
    out.push(row);
  }
  hub.invalidateRepo(ctx.repo.slug);
  return { own: true, impacts: out };
}

export async function markPushed(hub: Hub, ctx: EventContext, ev: PushEvent): Promise<void> {
  const rows = await hub.db
    .update(impacts)
    .set({ status: 'pushed', updatedAt: ctx.at })
    .where(and(eq(impacts.repoId, ctx.repo.id), eq(impacts.devId, ctx.dev.id), eq(impacts.branch, ev.branch), eq(impacts.status, 'committed')))
    .returning({ changeSetId: impacts.changeSetId });
  for (const id of new Set(rows.map((r) => r.changeSetId))) {
    await recomputeStatus(hub, id, ctx.at);
  }
  await hub.db
    .update(heat)
    .set({ pushed: true })
    .where(and(eq(heat.repoId, ctx.repo.id), eq(heat.sessionId, ctx.session.id), eq(heat.kind, 'commit'), eq(heat.branch, ev.branch)));
  hub.invalidateRepo(ctx.repo.slug);
}

// ---------------------------------------------------------------------------
// retract
// ---------------------------------------------------------------------------

export async function retractImpact(hub: Hub, ctx: EventContext, ev: RetractEvent): Promise<ImpactRow | null> {
  let target: ImpactRow | null = null;
  if (ev.impactId) {
    const [byId] = await hub.db.select().from(impacts).where(eq(impacts.id, ev.impactId)).limit(1);
    target = byId ?? null;
  }
  if (!target && ev.hash) target = await findByHash(hub, ctx.repo.id, ctx.session.id, ev.path, ev.hash);
  if (!target) target = await latestOpen(hub, ctx.session.id, ev.path);
  if (!target || target.status === 'withdrawn') return null;
  await hub.db.update(impacts).set({ status: 'withdrawn', updatedAt: ctx.at }).where(eq(impacts.id, target.id));
  await touchChangeSet(hub, target.changeSetId, ctx.at, { resetStable: false });
  await routeChangeSet(hub, target.changeSetId, { reArm: false });
  hub.invalidateRepo(ctx.repo.slug);
  return { ...target, status: 'withdrawn' };
}

// ---------------------------------------------------------------------------
// acks
// ---------------------------------------------------------------------------

export interface AckInput {
  id: string;
  dev: DevRow;
  note?: string | null;
  auto?: boolean;
  at: Date;
}

export async function ackChangeSet(hub: Hub, input: AckInput): Promise<{ changeSetId: string; ackedAt: string; notifiedAuthor: boolean } | null> {
  let csId = input.id;
  if (input.id.startsWith('imp_')) {
    const [imp] = await hub.db.select({ changeSetId: impacts.changeSetId }).from(impacts).where(eq(impacts.id, input.id)).limit(1);
    if (!imp) return null;
    csId = imp.changeSetId;
  }
  const bundle = await changeSetById(hub, csId);
  if (!bundle) return null;
  await hub.db
    .update(impactTargets)
    .set({ ackedAt: input.at, ackNote: input.note ?? (input.auto ? 'auto: already in branch' : null) })
    .where(and(eq(impactTargets.changeSetId, csId), eq(impactTargets.devId, input.dev.id), isNull(impactTargets.ackedAt)));
  const acked = { ...bundle.changeSet.acked, [input.dev.handle]: input.at.toISOString() };
  await hub.db.update(changeSets).set({ acked }).where(eq(changeSets.id, csId));
  await hub.db
    .update(notifications)
    .set({ deliveredAt: input.at, deliveredVia: 'mcp' })
    .where(and(eq(notifications.refId, csId), eq(notifications.toDevId, input.dev.id), isNull(notifications.deliveredAt)));
  let notifiedAuthor = false;
  if (!input.auto && bundle.author.id !== input.dev.id) {
    await hub.db.insert(notifications).values({
      id: newId('notification', input.at.getTime()),
      teamId: hub.team.id,
      repoId: bundle.sourceRepo.id,
      toDevId: bundle.author.id,
      fromDevId: input.dev.id,
      kind: 'note',
      refId: csId,
      body: `${input.dev.handle} acknowledged ${csId}${input.note ? `: ${input.note}` : ''}`,
      noteKind: 'fyi',
      createdAt: input.at,
      deliveredAt: null,
      deliveredVia: null,
    });
    notifiedAuthor = true;
  }
  hub.invalidateRepo(bundle.sourceRepo.slug);
  for (const t of bundle.targets) {
    const r = await hub.repoById(t.repoId);
    if (r) hub.invalidateRepo(r.slug);
  }
  return { changeSetId: csId, ackedAt: input.at.toISOString(), notifiedAuthor };
}

/** Auto-ack (for the sender) every change set by another dev whose content the sender now carries (§7.2 merged by content). */
export async function ackByContent(hub: Hub, ctx: EventContext, blobIds: string[]): Promise<string[]> {
  if (blobIds.length === 0) return [];
  const rows = await hub.db
    .select({ changeSetId: impacts.changeSetId, id: impacts.id })
    .from(impacts)
    .where(and(eq(impacts.repoId, ctx.repo.id), inArray(impacts.blobId, blobIds), ne(impacts.devId, ctx.dev.id), ne(impacts.status, 'withdrawn')));
  const acked: string[] = [];
  for (const csId of new Set(rows.map((r) => r.changeSetId))) {
    const [target] = await hub.db
      .select()
      .from(impactTargets)
      .where(and(eq(impactTargets.changeSetId, csId), eq(impactTargets.devId, ctx.dev.id), isNull(impactTargets.ackedAt)))
      .limit(1);
    if (!target) continue;
    await ackChangeSet(hub, { id: csId, dev: ctx.dev, auto: true, note: 'auto: merged by content', at: ctx.at });
    acked.push(csId);
  }
  return acked;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

interface DevScore {
  score: number;
  importDerived: boolean;
  /** areas that contributed points; a target's dependents are filtered to them ("Your dependents", §9.3) */
  areas: Set<string>;
}

export async function routeChangeSet(hub: Hub, csId: string, opts: { reArm: boolean }): Promise<void> {
  const bundle = await changeSetById(hub, csId);
  if (!bundle) return;
  const open = bundle.impacts.filter((i) => i.status !== 'withdrawn' && i.supersededBy === null);
  const now = hub.now();
  if (open.length === 0) {
    await hub.db.update(changeSets).set({ status: 'withdrawn', priority: 'low' }).where(eq(changeSets.id, csId));
    await hub.db.delete(impactTargets).where(eq(impactTargets.changeSetId, csId));
    await hub.db.delete(notifications).where(and(eq(notifications.refId, csId), eq(notifications.kind, 'impact'), isNull(notifications.deliveredAt)));
    return;
  }

  const sourceRepo = bundle.sourceRepo;
  const sourceCfg = hub.configOf(sourceRepo);
  const projectRepos = await reposInProject(hub, sourceRepo.project);
  const repoById = new Map(projectRepos.map((r) => [r.id, r]));
  const indexes = new Map<string, typeof depindex.$inferSelect>();
  if (projectRepos.length > 0) {
    const rows = await hub.db.select().from(depindex).where(inArray(depindex.repoId, projectRepos.map((r) => r.id)));
    for (const r of rows) indexes.set(r.repoId, r);
  }

  // dependents per target repo: {path -> Dependent}
  const perRepo = new Map<string, Map<string, Dependent>>();
  const add = (repoId: string, dep: Dependent) => {
    let m = perRepo.get(repoId);
    if (!m) {
      m = new Map();
      perRepo.set(repoId, m);
    }
    const prev = m.get(dep.path);
    if (!prev || rank(dep.via) > rank(prev.via)) m.set(dep.path, dep);
  };
  const authorAreas = new Set<string>();

  for (const imp of open) {
    const authorArea = areaOf(imp.path, sourceCfg.areas);
    if (authorArea) authorAreas.add(authorArea);
    // 1. in-repo dependents: client grep, or the chain's previous revs, or the author repo's own index (§7.3)
    let inRepo: string[] = imp.dependents ?? [];
    if (imp.dependents === null) {
      const chain = bundle.impacts.filter((i) => i.path === imp.path && i.dependents !== null);
      inRepo = chain.flatMap((i) => i.dependents ?? []);
      if (inRepo.length === 0) inRepo = lookupInRepo(indexes.get(sourceRepo.id), imp.path);
    }
    for (const p of dedupe(inRepo).slice(0, LIMITS.dependentsCap)) {
      if (p === imp.path) continue;
      const area = areaOf(p, sourceCfg.areas);
      if (area && area === authorArea) continue; // same-area churn is never a notice (§7.5 step 6)
      add(sourceRepo.id, { path: p, area, via: 'import' });
    }
    // schema-type files with no importers default to every other area (§7.3)
    if (inRepo.length === 0 && isSchemaKind(imp.kinds)) {
      const consumers = Object.entries(sourceCfg.contracts.consumers).find(([glob]) => matchesGlobSafe(imp.path, glob))?.[1];
      const targets = consumers ?? Object.keys(sourceCfg.areas).filter((a) => a !== authorArea);
      for (const area of targets) {
        const glob = sourceCfg.areas[area]?.paths[0];
        if (glob) add(sourceRepo.id, { path: glob, area, via: 'depends' });
      }
    }
    // 2. cross-repo via dependency indexes (§7.4)
    for (const other of projectRepos) {
      if (other.id === sourceRepo.id) continue;
      const idx = indexes.get(other.id);
      if (!idx) continue;
      const otherCfg = hub.configOf(other);
      const found = new Map<string, 'import' | 'basename'>();
      const base = basenameNoExt(imp.path);
      for (const pkg of sourceCfg.contracts.packages) {
        for (const f of idx.imports[pkg] ?? []) found.set(f, 'import');
        for (const f of idx.imports[`${pkg}/${base}`] ?? []) found.set(f, 'import');
      }
      for (const key of Object.keys(idx.imports)) {
        if (key === stripExt(imp.path) || key.endsWith('/' + stripExt(imp.path))) for (const f of idx.imports[key] ?? []) found.set(f, 'import');
      }
      for (const s of imp.symbols) for (const f of idx.symbols[s] ?? []) found.set(f, 'import');
      if (!GENERIC_BASENAMES.includes(base)) {
        for (const f of idx.contractPaths[base] ?? idx.contractPaths[imp.path] ?? []) if (!found.has(f)) found.set(f, 'basename');
      }
      for (const [f, via] of found) add(other.id, { path: f, area: areaOf(f, otherCfg.areas), via });
    }
  }

  // 3. `depends` map of every repo in the project (§7.5 step 4)
  for (const r of projectRepos) {
    const cfg = hub.configOf(r);
    for (const [area, deps] of Object.entries(cfg.depends)) {
      if (r.id === sourceRepo.id && authorAreas.has(area)) continue;
      if (deps.some((d) => authorAreas.has(d))) {
        const glob = cfg.areas[area]?.paths[0] ?? `${area}/**`;
        add(r.id, { path: glob, area, via: 'depends' });
      }
    }
  }

  // 4. developers per (repo, area) with scores (§7.5 step 5)
  const live = await liveSessionsInProject(hub, sourceRepo.project, now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const scores = new Map<string, Map<string, DevScore>>(); // repoId -> devId -> score
  const bump = (repoId: string, devId: string, points: number, importDerived: boolean, area: string) => {
    if (devId === bundle.author.id) return;
    let m = scores.get(repoId);
    if (!m) {
      m = new Map();
      scores.set(repoId, m);
    }
    const s = m.get(devId) ?? { score: 0, importDerived: false, areas: new Set<string>() };
    s.areas.add(area);
    m.set(devId, { score: Math.max(s.score, points), importDerived: s.importDerived || importDerived, areas: s.areas });
  };

  for (const [repoId, deps] of perRepo) {
    const repo = repoById.get(repoId);
    if (!repo) continue;
    const cfg = hub.configOf(repo);
    const byArea = new Map<string, { importDerived: boolean; paths: string[] }>();
    for (const d of deps.values()) {
      const key = d.area ?? '*';
      const entry = byArea.get(key) ?? { importDerived: false, paths: [] };
      entry.importDerived = entry.importDerived || d.via !== 'depends';
      entry.paths.push(d.path);
      byArea.set(key, entry);
    }
    const learned = await hub.db.select().from(devRepo).where(eq(devRepo.repoId, repoId));
    const heatRows = await hub.db
      .select({ devId: heat.devId, path: heat.path })
      .from(heat)
      .where(and(eq(heat.repoId, repoId), gt(heat.lastAt, weekAgo)));
    const devRowsByHandle = new Map<string, DevRow>();
    for (const [area, entry] of byArea) {
      const perDev = new Map<string, number>();
      const addPoints = (devId: string, n: number) => perDev.set(devId, (perDev.get(devId) ?? 0) + n);
      const via = entry.importDerived;
      for (const owner of cfg.areas[area]?.owners ?? []) {
        if (!isValidHandle(owner)) continue;
        let row = devRowsByHandle.get(owner);
        if (!row) {
          // declared owners are routed to before their first session (the row waits for them)
          row = (await hub.devByHandle(owner, true)) ?? undefined;
          if (row) devRowsByHandle.set(owner, row);
        }
        if (row) addPoints(row.id, 2);
      }
      for (const l of learned) if (l.homeAreas.includes(area)) addPoints(l.devId, 1);
      for (const s of live) if (s.repo.id === repoId && s.session.area && sameArea(s.session.area, area)) addPoints(s.dev.id, 2);
      const paths = new Set(entry.paths);
      for (const h of heatRows) if (paths.has(h.path)) addPoints(h.devId, 2);
      for (const [devId, points] of perDev) bump(repoId, devId, points, via, area);
    }
  }

  // 5. persist targets (§7.5 step 8), one per (change set, dev, repo)
  const existing = bundle.targets;
  const keep = new Set<string>();
  let csPriority: ImpactPriority = 'low';
  for (const [repoId, devMap] of scores) {
    const allDeps = [...(perRepo.get(repoId)?.values() ?? [])];
    if (allDeps.length === 0) continue;
    for (const [devId, s] of devMap) {
      const own = allDeps.filter((d) => s.areas.has(d.area ?? '*'));
      const deps = own.length > 0 ? own : allDeps;
      const priority = priorityFor(s);
      csPriority = maxPriority(csPriority, priority);
      keep.add(`${devId}|${repoId}`);
      const prev = existing.find((t) => t.devId === devId && t.repoId === repoId);
      if (prev) {
        const next: Partial<ImpactTargetRow> = { dependents: deps, priority };
        if (opts.reArm && prev.ackedAt) {
          next.ackedAt = null; // a new rev re-arms delivery once (§7.5 step 10)
          next.ackNote = null;
          next.deliveredAt = null;
        }
        await hub.db.update(impactTargets).set(next).where(and(eq(impactTargets.changeSetId, csId), eq(impactTargets.devId, devId), eq(impactTargets.repoId, repoId)));
      } else {
        await hub.db.insert(impactTargets).values({ changeSetId: csId, devId, repoId, dependents: deps, priority, deliveredAt: null, ackedAt: null, ackNote: null }).onConflictDoNothing();
      }
    }
  }
  for (const t of existing) {
    if (!keep.has(`${t.devId}|${t.repoId}`)) {
      await hub.db.delete(impactTargets).where(and(eq(impactTargets.changeSetId, csId), eq(impactTargets.devId, t.devId), eq(impactTargets.repoId, t.repoId)));
      await hub.db.delete(notifications).where(and(eq(notifications.refId, csId), eq(notifications.toDevId, t.devId), eq(notifications.kind, 'impact'), isNull(notifications.deliveredAt)));
    }
  }
  const status = statusOf(open);
  await hub.db.update(changeSets).set({ priority: csPriority, status }).where(eq(changeSets.id, csId));
  if (isRoutable({ ...bundle.changeSet, status }, sourceCfg, now, open)) {
    await promoteChangeSet(hub, csId, now);
  }
  for (const r of projectRepos) hub.invalidateRepo(r.slug);
}

/** Creates the `impact` notification per (change set, dev) once the change set is routable (§7.5 step 8–9); updates bodies in place on rev+1. */
export async function promoteChangeSet(hub: Hub, csId: string, now: Date): Promise<number> {
  const bundle = await changeSetById(hub, csId);
  if (!bundle || bundle.changeSet.status === 'withdrawn') return 0;
  if (!isRoutable(bundle.changeSet, hub.configOf(bundle.sourceRepo), now, bundle.impacts)) return 0;
  let created = 0;
  for (const t of bundle.targets) {
    if (t.priority === 'low' || t.ackedAt) continue;
    const viewerRepo = await hub.repoById(t.repoId);
    const body = changeSetLine(bundle, viewerRepo, { withDependents: true });
    const [existing] = await hub.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.refId, csId), eq(notifications.toDevId, t.devId), eq(notifications.kind, 'impact')))
      .limit(1);
    if (existing) {
      if (existing.body !== body) await hub.db.update(notifications).set({ body }).where(eq(notifications.id, existing.id));
      continue;
    }
    await hub.db.insert(notifications).values({
      id: newId('notification', now.getTime()),
      teamId: hub.team.id,
      repoId: t.repoId,
      toDevId: t.devId,
      fromDevId: bundle.author.id,
      kind: 'impact',
      refId: csId,
      body,
      noteKind: null,
      createdAt: now,
      deliveredAt: null,
      deliveredVia: null,
    });
    created += 1;
  }
  return created;
}

/** Sweep hook: promote every uncommitted change set whose debounce elapsed (§7.5 step 7). */
export async function promoteRoutable(hub: Hub, now: Date): Promise<number> {
  const since = new Date(now.getTime() - LIMITS.changeSetExpiryMs);
  const rows = await hub.db
    .select()
    .from(changeSets)
    .where(and(ne(changeSets.status, 'withdrawn'), gt(changeSets.lastAt, since)))
    .orderBy(desc(changeSets.lastAt));
  let n = 0;
  for (const cs of rows) {
    n += await promoteChangeSet(hub, cs.id, now);
  }
  return n;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function findByHash(hub: Hub, repoId: string, sessionId: string, path: string, hash: string): Promise<ImpactRow | null> {
  const [row] = await hub.db
    .select()
    .from(impacts)
    .where(and(eq(impacts.repoId, repoId), eq(impacts.sessionId, sessionId), eq(impacts.path, path), eq(impacts.hash, hash)))
    .limit(1);
  return row ?? null;
}

async function latestOpen(hub: Hub, sessionId: string, path: string): Promise<ImpactRow | null> {
  const [row] = await hub.db
    .select()
    .from(impacts)
    .where(and(eq(impacts.sessionId, sessionId), eq(impacts.path, path), isNull(impacts.supersededBy), ne(impacts.status, 'withdrawn')))
    .orderBy(desc(impacts.updatedAt))
    .limit(1);
  return row ?? null;
}

async function findOrCreateChangeSet(hub: Hub, ctx: EventContext, branch: string): Promise<ChangeSetRow> {
  const windowStart = new Date(ctx.at.getTime() - LIMITS.changeSetMergeWindowMs);
  const [recent] = await hub.db
    .select()
    .from(changeSets)
    .where(and(eq(changeSets.sessionId, ctx.session.id), eq(changeSets.branch, branch), ne(changeSets.status, 'withdrawn'), gt(changeSets.lastAt, windowStart)))
    .orderBy(desc(changeSets.lastAt))
    .limit(1);
  if (recent) return recent;
  const row: ChangeSetRow = {
    id: newId('changeSet', ctx.at.getTime()),
    repoId: ctx.repo.id,
    devId: ctx.dev.id,
    sessionId: ctx.session.id,
    branch,
    status: 'uncommitted',
    priority: 'low',
    firstAt: ctx.at,
    lastAt: ctx.at,
    stableSince: ctx.at,
    acked: {},
  };
  await hub.db.insert(changeSets).values(row);
  return row;
}

/** lastAt always moves; a new hash restarts the debounce clock (stableSince = at). */
async function touchChangeSet(hub: Hub, csId: string, at: Date, opts: { resetStable: boolean }): Promise<void> {
  await hub.db
    .update(changeSets)
    .set(opts.resetStable ? { lastAt: at, stableSince: at } : { lastAt: at })
    .where(eq(changeSets.id, csId));
}

async function recomputeStatus(hub: Hub, csId: string, at: Date): Promise<void> {
  const rows = await hub.db.select().from(impacts).where(and(eq(impacts.changeSetId, csId), isNull(impacts.supersededBy)));
  const open = rows.filter((r) => r.status !== 'withdrawn');
  await hub.db.update(changeSets).set({ status: statusOf(open), lastAt: at }).where(eq(changeSets.id, csId));
}

export function statusOf(open: ImpactRow[]): ImpactStatus {
  if (open.length === 0) return 'withdrawn';
  if (open.some((i) => i.status === 'uncommitted')) return 'uncommitted';
  if (open.some((i) => i.status === 'committed')) return 'committed';
  if (open.some((i) => i.status === 'pushed')) return 'pushed';
  return 'merged';
}

export function priorityFor(s: DevScore): ImpactPriority {
  if (s.score >= 3 && s.importDerived) return 'high';
  if (s.score >= 1) return 'normal';
  return 'low';
}

function maxPriority(a: ImpactPriority, b: ImpactPriority): ImpactPriority {
  const order: ImpactPriority[] = ['low', 'normal', 'high'];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

function rank(via: Dependent['via']): number {
  return via === 'import' ? 3 : via === 'basename' ? 2 : 1;
}

function sameArea(sessionArea: string, area: string): boolean {
  // session areas can read `app (+contracts)` (§5.2)
  return sessionArea === area || sessionArea.startsWith(area + ' ') || sessionArea.includes(`(+${area})`);
}

function isSchemaKind(kinds: string[]): boolean {
  return kinds.some((k) => k === 'prisma' || k === 'openapi' || k === 'graphql' || k === 'sql' || k === 'proto');
}

function matchesGlobSafe(path: string, glob: string): boolean {
  try {
    return path === glob || new RegExp('^' + glob.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$').test(path);
  } catch {
    return false;
  }
}

function lookupInRepo(idx: typeof depindex.$inferSelect | undefined, path: string): string[] {
  if (!idx) return [];
  const out = new Set<string>();
  const noExt = stripExt(path);
  for (const [spec, files] of Object.entries(idx.imports)) {
    if (spec === noExt || spec === path || spec.endsWith('/' + noExt) || noExt.endsWith('/' + spec)) for (const f of files) out.add(f);
  }
  const base = basenameNoExt(path);
  if (!GENERIC_BASENAMES.includes(base)) for (const f of idx.contractPaths[base] ?? []) out.add(f);
  out.delete(path);
  return [...out];
}

function stripExt(p: string): string {
  return p.replace(/\.[a-z0-9]+$/i, '');
}

function basenameNoExt(p: string): string {
  const b = p.split('/').pop() ?? p;
  return stripExt(b);
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function summarize(path: string, symbols: string[]): string {
  const base = path.split('/').pop() ?? path;
  return symbols.length > 0 ? `${base} (${symbols.join(', ')})` : `edited ${path}`;
}

/** Session rows referenced by heat (for who_is_on and claims); kept here to avoid a queries.ts cycle. */
export async function sessionsByIds(hub: Hub, ids: string[]): Promise<Map<string, SessionRow>> {
  if (ids.length === 0) return new Map();
  const rows = await hub.db.select().from(sessions).where(inArray(sessions.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

export type { ChangeSetBundle };
