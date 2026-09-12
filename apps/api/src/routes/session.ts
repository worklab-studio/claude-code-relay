/**
 * POST /v1/session/start, POST /v1/session/end, POST /v1/iam (§10.4, §4.1, §4.9, §3.3).
 */
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  isRecord,
  isRelayConfig,
  type ClientKind,
  type HandoffDraft,
  type IamResponse,
  type OkResponse,
  type SessionEndReason,
  type SessionEndRequest,
  type SessionStartRequest,
  type SessionStartResponse,
  type SessionStartSource,
} from '@relay/core';
import type { AppEnv } from '../auth.js';
import { devRepo, devs, events, handoffDrafts, repos, sessions, type SessionRow } from '../db/schema.js';
import { renderDigest } from '../digest.js';
import { upsertRepo } from '../hub.js';
import { getSnapshot } from '../snapshot.js';
import { endSession, maybeSweep } from '../sweep.js';
import { ulid } from '../util/ids.js';
import { toDate } from '../util/time.js';
import { HttpError, mergePlaceholder, readJson, str } from './common.js';

const END_REASONS: SessionEndReason[] = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other', 'crash', 'timeout'];
const SOURCES: SessionStartSource[] = ['startup', 'resume', 'clear', 'compact', 'fork'];
const SEVEN_DAYS_MS = 7 * 86_400_000;

export const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.post('/session/start', async (c) => {
  const hub = c.get('hub');
  let dev = c.get('dev');
  const body = (await readJson(c)) as unknown as Partial<SessionStartRequest>;
  const s = body.session;
  if (!isRecord(s) || !str(s.id) || !isRecord(s.repo) || !str(s.repo.slug)) {
    throw new HttpError(400, 'bad_body', 'session.id and session.repo.slug are required');
  }
  const now = hub.now();
  const source: SessionStartSource = SOURCES.includes(s.source) ? s.source : 'startup';
  const client: ClientKind = s.client === 'desktop' ? 'desktop' : 'cli';
  const config = isRelayConfig(s.repo.config) ? s.repo.config : null;
  const repo = await upsertRepo(hub, s.repo.slug, {
    project: s.repo.project ?? null,
    config,
    configHash: s.repo.configHash ?? null,
  });

  // identity: learn the git email for the author filter (§7.2); merge a placeholder into the real handle (§3.3 step 7)
  const hint: Record<string, unknown> = isRecord(body.identityHint) ? (body.identityHint as unknown as Record<string, unknown>) : {};
  const gitEmail = str(hint['gitEmail']);
  if (gitEmail && !dev.placeholder && !dev.emails.map((e) => e.toLowerCase()).includes(gitEmail.toLowerCase())) {
    await hub.db.update(devs).set({ emails: [...dev.emails, gitEmail], lastSeenAt: now }).where(eq(devs.id, dev.id));
    hub.cache.devs.delete(dev.handle);
    dev = (await hub.devByHandle(dev.handle)) ?? dev;
  } else {
    await hub.db.update(devs).set({ lastSeenAt: now }).where(eq(devs.id, dev.id));
  }
  const placeholder = str(hint['placeholder']);
  if (placeholder && !dev.placeholder && placeholder !== dev.handle) {
    await mergePlaceholder(hub, placeholder, dev);
  }

  // `since` = end of this dev's previous session in the project, computed before this session touches dev_repo (§9.3)
  const projectRepos = await hub.db.select({ id: repos.id }).from(repos).where(and(eq(repos.teamId, hub.team.id), eq(repos.project, repo.project)));
  const [lastEnd] = await hub.db
    .select({ at: devRepo.lastSessionEndAt })
    .from(devRepo)
    .where(and(eq(devRepo.devId, dev.id), inArray(devRepo.repoId, projectRepos.map((r) => r.id)), isNotNull(devRepo.lastSessionEndAt)))
    .orderBy(desc(devRepo.lastSessionEndAt))
    .limit(1);
  const mode: 'full' | 'delta' = body.mode === 'delta' ? 'delta' : 'full';
  const since = (mode === 'delta' ? toDate(body.since) : null) ?? lastEnd?.at ?? new Date(now.getTime() - SEVEN_DAYS_MS);
  // Handoffs window (§8.4, §12 moment 6): a teammate's handoff generated while this dev's previous
  // session was still live was never pushed to them (only the handoffs tool shows it), so the
  // "Handoffs since your last session" section opens at that session's START, not its end.
  const [prevSession] = await hub.db
    .select({ startedAt: sessions.startedAt })
    .from(sessions)
    .where(and(eq(sessions.devId, dev.id), inArray(sessions.repoId, projectRepos.map((r) => r.id)), isNotNull(sessions.endedAt), ne(sessions.id, s.id)))
    .orderBy(desc(sessions.endedAt))
    .limit(1);
  const handoffsSince = mode === 'full' && prevSession && prevSession.startedAt < since ? prevSession.startedAt : since;

  // session row: create, or refresh/revive on resume/clear/fork (§4.1, §6.2)
  const [existing] = await hub.db.select().from(sessions).where(eq(sessions.id, s.id)).limit(1);
  const branch = str(s.branch) ?? existing?.branch ?? 'unknown';
  const base = {
    devId: dev.id,
    repoId: repo.id,
    client,
    host: str(s.host) ?? existing?.host ?? 'unknown',
    cwd: str(s.cwd) ?? existing?.cwd ?? '',
    branch,
    worktree: str(s.worktree),
    model: str(s.model),
    pluginSha: str(s.pluginSha) ?? c.get('pluginSha'),
    lastSeenAt: now,
    endedAt: null,
    endReason: null,
    state: 'working' as const,
    gitEmailHint: gitEmail ?? existing?.gitEmailHint ?? null,
  };
  if (existing) {
    const keepStartSha = source === 'resume' && existing.branch === branch && existing.startSha;
    await hub.db
      .update(sessions)
      .set({ ...base, startSha: keepStartSha ? existing.startSha : (str(s.startSha) ?? existing.startSha) })
      .where(eq(sessions.id, s.id));
  } else {
    const row: SessionRow = {
      id: s.id,
      ...base,
      startSha: str(s.startSha),
      area: null,
      objective: null,
      objectiveSource: null,
      startedAt: now,
      lastEditAt: null,
      lastPromptAt: null,
      inTurnSince: null,
      editCount: 0,
      promptCount: 0,
      commitCount: 0,
      recentFiles: [],
    };
    await hub.db.insert(sessions).values(row).onConflictDoNothing();
  }
  await hub.db
    .insert(devRepo)
    .values({ devId: dev.id, repoId: repo.id, homeAreas: [], lastSeenAt: now, lastSessionEndAt: null })
    .onConflictDoUpdate({ target: [devRepo.devId, devRepo.repoId], set: { lastSeenAt: now } });
  await hub.db
    .insert(events)
    .values({
      id: ulid(now.getTime()),
      at: now,
      serverAt: now,
      replay: false,
      teamId: hub.team.id,
      repoId: repo.id,
      devId: dev.id,
      sessionId: s.id,
      type: 'session_start',
      path: null,
      area: null,
      sha: null,
      payload: { source, mode, client, branch },
    })
    .onConflictDoNothing();
  hub.invalidateRepo(repo.slug);

  await maybeSweep(hub);

  const warn = c.get('warn');
  const digest = await renderDigest(hub, { repo, dev, sessionId: s.id, mode, since, handoffsSince, gitEmail, warn });
  const snapshot = await getSnapshot(hub, { repo, dev, sessionId: s.id, warn });
  const response: SessionStartResponse = { digest, snapshot, minClient: hub.minClient };
  if (warn.length > 0) response.warn = warn;
  return c.json(response);
});

sessionRoutes.post('/session/end', async (c) => {
  const hub = c.get('hub');
  const body = (await readJson(c)) as unknown as Partial<SessionEndRequest>;
  const sessionId = str(body.sessionId);
  if (!sessionId) throw new HttpError(400, 'bad_body', 'sessionId is required');
  const reason: SessionEndReason = END_REASONS.includes(body.reason as SessionEndReason) ? (body.reason as SessionEndReason) : 'other';
  const at = toDate(body.at) ?? hub.now();
  // A delayed WAL replay, or a liveness-sweep crash end, must not end a session that was resumed
  // in the meantime (§10.4): when a session_start for it is newer than the end's own clock, the end is stale.
  if (body.replay === true || reason === 'crash') {
    const [restart] = await hub.db
      .select({ at: events.at })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, 'session_start')))
      .orderBy(desc(events.at))
      .limit(1);
    if (restart && restart.at > at) {
      const ignored: OkResponse & { ignored: true } = { ok: true, ignored: true };
      return c.json(ignored);
    }
  }
  const draft = body.draft;
  if (draft && isRecord(draft) && Array.isArray((draft as HandoffDraft).changed)) {
    await hub.db
      .insert(handoffDrafts)
      .values({ sessionId, at, draft: draft as HandoffDraft })
      .onConflictDoUpdate({ target: handoffDrafts.sessionId, set: { at, draft: draft as HandoffDraft } });
  }
  await endSession(hub, sessionId, reason, at);
  const response: OkResponse = { ok: true };
  return c.json(response);
});

sessionRoutes.post('/iam', async (c) => {
  const hub = c.get('hub');
  const dev = c.get('dev');
  const body = await readJson(c);
  const placeholder = str(body['placeholder']);
  if (!placeholder) throw new HttpError(400, 'bad_body', 'placeholder is required');
  if (dev.placeholder) throw new HttpError(400, 'placeholder_target', 'X-Relay-Dev must be the real handle, not a placeholder');
  const result: IamResponse = await mergePlaceholder(hub, placeholder, dev);
  return c.json(result);
});
