/**
 * POST /v1/events (§10.4, §10.1 write semantics): idempotent by event id and by
 * semantics (commit/push SHA once per repo, contract hash once per session/path,
 * heat.last_at only forward); presence updated from server time for live events
 * only — replays (`replay: true`, or `at` older than the session's end) never
 * revive an ended session or move presence backwards; contract/commit/retract/push
 * events go through impact routing (§7.5); `delivered` marks inbox items.
 */
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  LIMITS,
  inlineText,
  isRecord,
  isRelayEvent,
  type ClientKind,
  type EventsRequest,
  type EventsResponse,
  type HandoffDraft,
  type HeatKind,
  type PromptEvent,
  type SessionPresence,
  type TurnEndEvent,
} from '@relay/core';
import type { AppEnv } from '../auth.js';
import { devs, events, handoffDrafts, heat, sessions, turns, type SessionRow } from '../db/schema.js';
import { undeliveredNotifications, markDelivered } from '../db/queries.js';
import { upsertRepo, type Hub } from '../hub.js';
import { markPushed, recordCommit, recordContract, retractImpact, type EventContext } from '../impact.js';
import { getSnapshot, toInboxItem } from '../snapshot.js';
import { maybeSweep } from '../sweep.js';
import { areaOf } from '../util/config.js';
import { toDate } from '../util/time.js';
import { HttpError, readJson, str } from './common.js';

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.post('/events', async (c) => {
  const hub = c.get('hub');
  const dev = c.get('dev');
  const body = (await readJson(c)) as unknown as Partial<EventsRequest>;
  const presence = body.session;
  if (!isRecord(presence) || !str(presence.id) || !str(presence.repo)) {
    throw new HttpError(400, 'bad_body', 'session.id and session.repo are required');
  }
  const replay = body.replay === true;
  const now = hub.now();
  const repo = (await hub.repoBySlug(presence.repo)) ?? (await upsertRepo(hub, presence.repo, { project: presence.project ?? null }));
  const config = hub.configOf(repo);

  // session row: lazily created when a killed SessionStart never registered it (§4.0 rule 10)
  let session = await loadOrCreateSession(hub, presence, dev.id, repo.id, c.get('client') === 'desktop' ? 'desktop' : 'cli', now);
  const live = !replay;
  const incoming = (Array.isArray(body.events) ? body.events : []).filter(isRelayEvent);
  incoming.sort((a, b) => a.at.localeCompare(b.at));

  // an ended session is revived by a live hook whose event is newer than the end (§6.2); replays never revive (§10.4)
  if (session.endedAt && live) {
    const newest = incoming.reduce<Date | null>((acc, ev) => {
      const d = toDate(ev.at);
      return d && (!acc || d > acc) ? d : acc;
    }, null);
    if (!newest || newest >= session.endedAt) {
      await hub.db.update(sessions).set({ endedAt: null, endReason: null, state: 'working' }).where(eq(sessions.id, session.id));
      session = { ...session, endedAt: null, endReason: null };
    }
  }
  const sessionLive = live && !session.endedAt;

  const patch: Partial<SessionRow> = {};
  let editCount = session.editCount;
  let promptCount = session.promptCount;
  let commitCount = session.commitCount;
  let recentFiles = [...session.recentFiles];

  for (const ev of incoming) {
    const at = toDate(ev.at) ?? now;
    const eventLive = sessionLive && (!session.endedAt || at >= session.endedAt);
    const inserted = await hub.db
      .insert(events)
      .values({
        id: ev.id,
        at,
        serverAt: now,
        replay,
        teamId: hub.team.id,
        repoId: repo.id,
        devId: dev.id,
        sessionId: session.id,
        type: ev.type,
        path: 'path' in ev && typeof ev.path === 'string' ? ev.path : null,
        area: 'path' in ev && typeof ev.path === 'string' ? areaOf(ev.path, config.areas) : null,
        sha: 'sha' in ev && typeof ev.sha === 'string' ? ev.sha : null,
        payload: ev as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: events.id });
    let rerun = false;
    if (inserted.length === 0) {
      // Duplicate id, or a commit/push SHA already known for this repo. The row is inserted before its
      // handler runs and outside any transaction, so a 500 raised by the handler leaves the row behind
      // and the client's WAL retry arrives as a replay of the same id: re-run the record handlers, which
      // are idempotent by hash / sha (§10.1), but never the presence counters or heat increments.
      if (!replay) continue;
      const [own] = await hub.db.select({ sessionId: events.sessionId }).from(events).where(eq(events.id, ev.id)).limit(1);
      if (!own || own.sessionId !== session.id) continue;
      if (ev.type !== 'contract' && ev.type !== 'commit' && ev.type !== 'retract' && ev.type !== 'push') continue;
      rerun = true;
    }

    const heatAt = replay ? at : now;
    const ctx: EventContext = { repo, dev, session, config, at: heatAt };
    switch (ev.type) {
      case 'prompt': {
        promptCount += 1;
        if (eventLive) {
          patch.lastPromptAt = now;
          patch.inTurnSince = now;
          if (ev.objective) {
            patch.objective = inlineText(ev.objective, LIMITS.objectiveChars);
            patch.objectiveSource = ev.objectiveSource;
          }
          if (ev.branch) patch.branch = ev.branch;
        }
        await replaceDirtyHeat(hub, ctx, ev, heatAt);
        break;
      }
      case 'edit': {
        editCount += 1;
        if (eventLive) patch.lastEditAt = now;
        recentFiles = [ev.path, ...recentFiles.filter((p) => p !== ev.path)].slice(0, LIMITS.recentFiles);
        await upsertHeat(hub, { repoId: repo.id, path: ev.path, devId: dev.id, sessionId: session.id, branch: presence.branch ?? session.branch, kind: 'edit', at: heatAt, increment: true });
        break;
      }
      case 'contract':
        await recordContract(hub, ctx, ev);
        break;
      case 'retract':
        await retractImpact(hub, ctx, ev);
        break;
      case 'commit': {
        const result = await recordCommit(hub, ctx, ev);
        if (result.own && !rerun) {
          commitCount += 1;
          for (const file of ev.files.slice(0, 200)) {
            await upsertHeat(hub, {
              repoId: repo.id,
              path: file,
              devId: dev.id,
              sessionId: session.id,
              branch: ev.branch ?? presence.branch ?? session.branch,
              kind: 'commit',
              at: heatAt,
              headSha: ev.sha,
              blobId: ev.contracts.find((x) => x.path === file)?.blobId ?? null,
              increment: true,
            });
          }
        }
        break;
      }
      case 'push':
        await markPushed(hub, ctx, ev);
        break;
      case 'branch':
        if (eventLive) {
          patch.branch = ev.branch;
          patch.worktree = ev.worktree;
          if (ev.startSha !== undefined) patch.startSha = ev.startSha;
        }
        break;
      case 'task':
        break;
      case 'turn_end':
        await storeTurn(hub, session.id, ev, at);
        if (eventLive) patch.inTurnSince = null;
        break;
      case 'cwd':
        if (eventLive) patch.cwd = ev.to;
        break;
    }
  }

  if (sessionLive) {
    patch.lastSeenAt = now;
    patch.state = 'working';
    if (presence.branch) patch.branch = patch.branch ?? presence.branch;
    if (presence.worktree !== undefined) patch.worktree = presence.worktree;
    // null area/objective on the wire means "not derived yet", never "cleared" (§5.1, §5.2)
    if (presence.area) patch.area = inlineText(presence.area, 80);
    if (presence.objective && patch.objective === undefined) {
      patch.objective = inlineText(presence.objective, LIMITS.objectiveChars);
      patch.objectiveSource = presence.objectiveSource ?? null;
    }
    if (presence.pluginSha) patch.pluginSha = presence.pluginSha;
    await hub.db.update(devs).set({ lastSeenAt: now }).where(eq(devs.id, dev.id));
  }
  patch.editCount = editCount;
  patch.promptCount = promptCount;
  patch.commitCount = commitCount;
  patch.recentFiles = recentFiles;
  await hub.db.update(sessions).set(patch).where(eq(sessions.id, session.id));

  const delivered = Array.isArray(body.delivered) ? body.delivered.filter((x): x is string => typeof x === 'string') : [];
  if (delivered.length > 0) await markDelivered(hub, delivered, dev.id, 'prompt', now);

  hub.invalidateRepo(repo.slug);
  await maybeSweep(hub);

  const warn = c.get('warn');
  const snapshot = await getSnapshot(hub, { repo, dev, sessionId: session.id, warn });
  const inbox = (await undeliveredNotifications(hub, dev.id)).map(toInboxItem);
  const response: EventsResponse = { snapshot, inbox };
  return c.json(response);
});

async function loadOrCreateSession(hub: Hub, presence: SessionPresence, devId: string, repoId: string, client: ClientKind, now: Date): Promise<SessionRow> {
  const [existing] = await hub.db.select().from(sessions).where(eq(sessions.id, presence.id)).limit(1);
  if (existing) return existing;
  const row: SessionRow = {
    id: presence.id,
    devId,
    repoId,
    client: presence.client ?? client,
    host: presence.host ?? 'unknown',
    cwd: presence.cwd ?? '',
    branch: presence.branch ?? 'unknown',
    worktree: presence.worktree ?? null,
    startSha: presence.startSha ?? null,
    model: null,
    pluginSha: presence.pluginSha ?? null,
    area: presence.area ? inlineText(presence.area, 80) : null,
    objective: presence.objective ? inlineText(presence.objective, LIMITS.objectiveChars) : null,
    objectiveSource: presence.objectiveSource ?? null,
    state: 'working',
    startedAt: now,
    lastSeenAt: now,
    lastEditAt: null,
    lastPromptAt: null,
    inTurnSince: null,
    endedAt: null,
    endReason: null,
    editCount: 0,
    promptCount: 0,
    commitCount: 0,
    gitEmailHint: null,
    recentFiles: [],
  };
  await hub.db.insert(sessions).values(row).onConflictDoNothing();
  const [again] = await hub.db.select().from(sessions).where(eq(sessions.id, presence.id)).limit(1);
  return again ?? row;
}

export interface HeatUpsert {
  repoId: string;
  path: string;
  devId: string;
  sessionId: string;
  branch: string;
  kind: HeatKind;
  at: Date;
  increment: boolean;
  blobId?: string | null;
  headSha?: string | null;
}

/** heat.last_at only moves forward (GREATEST), counts accumulate (§10.1). */
export async function upsertHeat(hub: Hub, h: HeatUpsert): Promise<void> {
  await hub.db
    .insert(heat)
    .values({
      repoId: h.repoId,
      path: h.path,
      devId: h.devId,
      sessionId: h.sessionId,
      branch: h.branch,
      kind: h.kind,
      lastAt: h.at,
      count: 1,
      pushed: false,
      blobId: h.blobId ?? null,
      headSha: h.headSha ?? null,
    })
    .onConflictDoUpdate({
      target: [heat.repoId, heat.path, heat.sessionId, heat.kind],
      set: {
        lastAt: sql`greatest(${heat.lastAt}, excluded.last_at)`,
        count: h.increment ? sql`${heat.count} + 1` : heat.count,
        branch: sql`excluded.branch`,
        devId: sql`excluded.dev_id`,
        blobId: sql`coalesce(excluded.blob_id, ${heat.blobId})`,
        headSha: sql`coalesce(excluded.head_sha, ${heat.headSha})`,
      },
    });
}

/** The dirty set reported at a prompt replaces the session's previous one (§6.3 warm heat). */
async function replaceDirtyHeat(hub: Hub, ctx: EventContext, ev: PromptEvent, at: Date): Promise<void> {
  const dirty = Array.isArray(ev.dirty) ? ev.dirty.filter((p): p is string => typeof p === 'string').slice(0, LIMITS.dirtyPathsCap) : [];
  if (dirty.length === 0) {
    await hub.db.delete(heat).where(and(eq(heat.repoId, ctx.repo.id), eq(heat.sessionId, ctx.session.id), eq(heat.kind, 'dirty')));
    return;
  }
  await hub.db.delete(heat).where(and(eq(heat.repoId, ctx.repo.id), eq(heat.sessionId, ctx.session.id), eq(heat.kind, 'dirty'), not(inArray(heat.path, dirty))));
  for (const path of dirty) {
    await upsertHeat(hub, { repoId: ctx.repo.id, path, devId: ctx.dev.id, sessionId: ctx.session.id, branch: ev.branch || ctx.session.branch, kind: 'dirty', at, increment: false });
  }
}

async function storeTurn(hub: Hub, sessionId: string, ev: TurnEndEvent, at: Date): Promise<void> {
  if (ev.promptId && typeof ev.text === 'string' && ev.text.length > 0) {
    await hub.db
      .insert(turns)
      .values({ sessionId, promptId: ev.promptId, at, text: ev.text.slice(0, LIMITS.turnTextChars) })
      .onConflictDoUpdate({ target: [turns.sessionId, turns.promptId], set: { at, text: ev.text.slice(0, LIMITS.turnTextChars) } });
  }
  if (ev.draft && isRecord(ev.draft) && Array.isArray((ev.draft as HandoffDraft).changed)) {
    const draft = ev.draft as HandoffDraft;
    await hub.db
      .insert(handoffDrafts)
      .values({ sessionId, at, draft })
      .onConflictDoUpdate({ target: handoffDrafts.sessionId, set: { at, draft } });
  }
}
