/**
 * POST /v1/{notify,claim,release,decide,ack,handoff} — the write tools of §9.2 (§10.4).
 * Bodies may carry `repo` (slug) to scope the action; otherwise the X-Relay-Session's repo.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  LIMITS,
  STALENESS,
  type AckResponse,
  type ClaimResponse,
  type DecideResponse,
  type HandoffResponse,
  type NotifyResponse,
  type ReleaseResponse,
} from '@relay/core';
import type { AppEnv } from '../auth.js';
import { claims, decisions, devs, notifications, type ClaimRow } from '../db/schema.js';
import { activeClaims, heatSince, liveSessionsInProject } from '../db/queries.js';
import { generateHandoff } from '../handoff.js';
import { ackChangeSet, sessionsByIds } from '../impact.js';
import { deriveState, isImplicitlyClaimed, toPresenceRecord } from '../presence.js';
import { targetCovers } from '../util/glob.js';
import { newId } from '../util/ids.js';
import { parseTtlMs } from '../util/time.js';
import { HttpError, readJson, resolveRepo } from './common.js';
import { claimRecord, heatEntry } from './query.js';

export const actionRoutes = new Hono<AppEnv>();

const notifySchema = z.object({
  dev: z.string().min(1),
  message: z.string().min(1).max(4000),
  ref: z.string().max(500).optional(),
  kind: z.enum(['fyi', 'ask', 'blocker']).optional(),
  repo: z.string().optional(),
});

actionRoutes.post('/notify', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const body = notifySchema.parse(await readJson(c));
  const { repo } = await resolveRepo(c, body.repo ?? null);
  let targets: Array<typeof devs.$inferSelect>;
  if (body.dev === 'all') {
    targets = (await hub.db.select().from(devs).where(and(eq(devs.teamId, hub.team.id), eq(devs.placeholder, false), isNull(devs.mergedInto), ne(devs.id, me.id))));
  } else {
    const d = await hub.devByHandle(body.dev, true);
    if (!d) throw new HttpError(400, 'unknown_dev');
    targets = [d];
  }
  const live = await liveSessionsInProject(hub, repo.project, now);
  const ids: string[] = [];
  const out: NotifyResponse['targets'] = [];
  for (const t of targets) {
    const id = newId('notification', now.getTime());
    await hub.db.insert(notifications).values({
      id,
      teamId: hub.team.id,
      repoId: repo.id,
      toDevId: t.id,
      fromDevId: me.id,
      kind: 'note',
      refId: body.ref ?? null,
      body: body.message,
      noteKind: body.kind ?? 'fyi',
      createdAt: now,
      deliveredAt: null,
      deliveredVia: null,
    });
    ids.push(id);
    const sessions = live.filter((s) => s.dev.id === t.id);
    const active = sessions.some((s) => deriveState(s.session, now) === 'working' || deriveState(s.session, now) === 'idle');
    const lastSeen = sessions.map((s) => s.session.lastSeenAt.toISOString()).sort().pop() ?? t.lastSeenAt.toISOString();
    out.push({ dev: t.handle, active, lastSeenAt: lastSeen, via: active ? 'next-prompt' : 'next-session' });
  }
  hub.cache.snapshots.clear();
  const note = out
    .map((t) => (t.active ? `${t.dev} active at ${t.lastSeenAt?.slice(11, 19)}Z — delivered at their next prompt` : `${t.dev} not active; will see it at their next session start`))
    .join('; ');
  const response: NotifyResponse = { ids, targets: out, note };
  return c.json(response);
});

const claimSchema = z.object({
  target: z.string().min(1).max(500),
  note: z.string().max(1000).optional(),
  ttl: z.string().max(10).optional(),
  hard: z.boolean().optional(),
  keep: z.boolean().optional(),
  repo: z.string().optional(),
});

actionRoutes.post('/claim', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const body = claimSchema.parse(await readJson(c));
  const { repo, sessionId } = await resolveRepo(c, body.repo ?? null);
  const ttl = Math.min(parseTtlMs(body.ttl) ?? LIMITS.claimDefaultTtlMs, LIMITS.claimMaxTtlMs);
  const target = body.target.replace(/^\.\//, '');
  const row: ClaimRow = {
    id: newId('claim', now.getTime()),
    repoId: repo.id,
    devId: me.id,
    sessionId,
    target,
    note: body.note ?? null,
    hard: body.hard ?? false,
    keep: body.keep ?? false,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttl),
    releasedAt: null,
  };
  await hub.db.insert(claims).values(row);
  hub.invalidateRepo(repo.slug);

  // conflicts: other devs' overlapping claims, their heat on the target (24 h) and their live sessions with implicit claims (§6.3)
  const others = (await activeClaims(hub, repo.id, now)).filter((cl) => cl.dev.id !== me.id && (targetCovers(cl.claim.target, target) || targetCovers(target, cl.claim.target)));
  const heatRows = (await heatSince(hub, repo.id, new Date(now.getTime() - STALENESS.warmMs))).filter((h) => h.dev.id !== me.id && targetCovers(target, h.heat.path));
  const sessionRows = await sessionsByIds(hub, heatRows.map((h) => h.heat.sessionId));
  const live = await liveSessionsInProject(hub, repo.project, now);
  const hotSessionIds = new Set(heatRows.filter((h) => isImplicitlyClaimed(h.heat, sessionRows.get(h.heat.sessionId), now)).map((h) => h.heat.sessionId));
  const response: ClaimResponse = {
    claim: claimRecord(row, me, repo),
    conflicts: {
      claims: others.map((cl) => claimRecord(cl.claim, cl.dev, repo)),
      heat: heatRows.map((h) => heatEntry(h.heat, h.dev, me, sessionRows.get(h.heat.sessionId)?.objective ?? null)),
      sessions: live.filter((s) => hotSessionIds.has(s.session.id)).map((s) => toPresenceRecord(s.session, s.dev, s.repo, now)),
    },
  };
  return c.json(response);
});

const releaseSchema = z.object({ target: z.string().optional(), repo: z.string().optional() });

actionRoutes.post('/release', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const body = releaseSchema.parse(await readJson(c));
  const { repo } = await resolveRepo(c, body.repo ?? null);
  const target = body.target && body.target !== 'all' ? body.target.replace(/^\.\//, '') : null;
  const rows = await hub.db
    .update(claims)
    .set({ releasedAt: now })
    .where(and(eq(claims.devId, me.id), eq(claims.repoId, repo.id), isNull(claims.releasedAt), target ? eq(claims.target, target) : undefined))
    .returning({ id: claims.id });
  hub.invalidateRepo(repo.slug);
  const response: ReleaseResponse = { released: rows.map((r) => r.id) };
  return c.json(response);
});

const decideSchema = z.object({
  text: z.string().min(1).max(2000),
  topic: z.string().max(200).optional(),
  area: z.string().max(200).optional(),
  supersedes: z.string().max(100).optional(),
  repo: z.string().optional(),
});

actionRoutes.post('/decide', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const now = hub.now();
  const body = decideSchema.parse(await readJson(c));
  const { repo, sessionId } = await resolveRepo(c, body.repo ?? null);
  const row = {
    id: newId('decision', now.getTime()),
    repoId: repo.id,
    project: repo.project,
    devId: me.id,
    sessionId,
    topic: body.topic ?? null,
    area: body.area ?? null,
    text: body.text,
    source: 'explicit' as const,
    confidence: 1,
    supersedes: body.supersedes ?? null,
    createdAt: now,
  };
  await hub.db.insert(decisions).values(row);
  const response: DecideResponse = {
    decision: { ...row, repo: repo.slug, dev: me.handle, createdAt: now.toISOString() },
  };
  return c.json(response);
});

const ackSchema = z.object({ id: z.string().min(1), note: z.string().max(1000).optional(), auto: z.boolean().optional() });

actionRoutes.post('/ack', async (c) => {
  const hub = c.get('hub');
  const me = c.get('dev');
  const body = ackSchema.parse(await readJson(c));
  const result = await ackChangeSet(hub, { id: body.id, dev: me, note: body.note ?? null, auto: body.auto ?? false, at: hub.now() });
  if (!result) throw new HttpError(404, 'unknown_change_set', `${body.id} is not a change set or impact id`);
  const response: AckResponse = result;
  return c.json(response);
});

const handoffSchema = z.object({
  sessionId: z.string().optional(),
  summary: z
    .object({
      done: z.array(z.string()).optional(),
      changed: z.array(z.union([z.string(), z.object({ path: z.string(), area: z.string().nullable().optional(), edits: z.number().optional(), why: z.string().nullable().optional() })])).optional(),
      interfaces_changed: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
      decisions: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      next: z.array(z.string()).optional(),
      notes_to: z.array(z.object({ dev: z.string(), intent: z.enum(['action', 'feedback', 'fyi']), text: z.string() })).optional(),
      objective: z.string().optional(),
    })
    .optional(),
});

actionRoutes.post('/handoff', async (c) => {
  const hub = c.get('hub');
  const body = handoffSchema.parse(await readJson(c));
  const sessionId = body.sessionId ?? c.get('sessionHeader');
  if (!sessionId) throw new HttpError(400, 'session_required', 'sessionId or X-Relay-Session is required');
  const summary = body.summary
    ? {
        ...body.summary,
        changed: body.summary.changed?.map((x) => (typeof x === 'string' ? x : { path: x.path, area: x.area ?? null, edits: x.edits ?? 0, why: x.why ?? null })),
        interfaces_changed: body.summary.interfaces_changed as never,
      }
    : null;
  const record = await generateHandoff(hub, sessionId, { trigger: 'manual', self: summary });
  if (!record) throw new HttpError(409, 'no_handoff', 'the session has no summarizable activity yet, or a generation is in progress');
  const response: HandoffResponse = { handoff: record };
  return c.json(response);
});
