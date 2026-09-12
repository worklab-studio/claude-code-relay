/**
 * Helpers shared by the route modules: body parsing with the 256 KB cap (§10.4),
 * repo resolution for query/action routes (`?repo=` or body.repo, else the
 * X-Relay-Session's repo, else the caller's most recent session), placeholder merge.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTP_STATUS, LIMITS, isRecord } from '@relay/core';
import type { AppEnv } from '../auth.js';
import type { Hub } from '../hub.js';
import {
  changeSets,
  claims,
  decisions,
  devRepo,
  devs,
  events,
  handoffs,
  heat,
  impactTargets,
  impacts,
  notifications,
  sessions,
  type DevRow,
  type RepoRow,
} from '../db/schema.js';
import { sessionById } from '../db/queries.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(length) && length > LIMITS.payloadMaxBytes) {
    throw new HttpError(HTTP_STATUS.payloadTooLarge, 'payload_too_large', `payload exceeds ${LIMITS.payloadMaxBytes} bytes`);
  }
  const text = await c.req.text();
  if (text.length > LIMITS.payloadMaxBytes) {
    throw new HttpError(HTTP_STATUS.payloadTooLarge, 'payload_too_large', `payload exceeds ${LIMITS.payloadMaxBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'body is not valid JSON');
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'bad_body', 'body must be a JSON object');
  return parsed;
}

export function str(x: unknown): string | null {
  return typeof x === 'string' && x.length > 0 ? x : null;
}

export function strArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
}

/** Repo scope of a query/action: explicit slug, the session header's repo, or the dev's latest session. */
export async function resolveRepo(c: Context<AppEnv>, explicit?: string | null): Promise<{ repo: RepoRow; sessionId: string | null }> {
  const hub = c.get('hub');
  const dev = c.get('dev');
  const sessionHeader = c.get('sessionHeader');
  const slug = explicit ?? c.req.query('repo') ?? null;
  if (slug) {
    const repo = await hub.repoBySlug(slug);
    if (!repo) throw new HttpError(404, 'unknown_repo', `repo ${slug} has no sessions yet`);
    return { repo, sessionId: sessionHeader };
  }
  if (sessionHeader) {
    const ref = await sessionById(hub, sessionHeader);
    if (ref) return { repo: ref.repo, sessionId: ref.session.id };
  }
  const [latest] = await hub.db
    .select()
    .from(sessions)
    .where(eq(sessions.devId, dev.id))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(1);
  if (latest) {
    const repo = await hub.repoById(latest.repoId);
    if (repo) return { repo, sessionId: latest.id };
  }
  throw new HttpError(404, 'repo_required', 'pass ?repo=<slug> or X-Relay-Session; this developer has no sessions yet');
}

/** Merges a per-machine placeholder identity into the real handle (§3.3 step 7). */
export async function mergePlaceholder(hub: Hub, placeholder: string, into: DevRow): Promise<{ merged: boolean; sessions: number }> {
  const ph = await hub.devByHandle(placeholder, false);
  if (!ph || ph.id === into.id || !ph.placeholder || ph.mergedInto) return { merged: false, sessions: 0 };
  const moved = await hub.db.update(sessions).set({ devId: into.id }).where(eq(sessions.devId, ph.id)).returning({ id: sessions.id });
  await hub.db.update(heat).set({ devId: into.id }).where(eq(heat.devId, ph.id));
  await hub.db.update(impacts).set({ devId: into.id }).where(eq(impacts.devId, ph.id));
  await hub.db.update(changeSets).set({ devId: into.id }).where(eq(changeSets.devId, ph.id));
  await hub.db.update(claims).set({ devId: into.id }).where(eq(claims.devId, ph.id));
  await hub.db.update(notifications).set({ toDevId: into.id }).where(eq(notifications.toDevId, ph.id));
  await hub.db.update(notifications).set({ fromDevId: into.id }).where(eq(notifications.fromDevId, ph.id));
  await hub.db.update(decisions).set({ devId: into.id }).where(eq(decisions.devId, ph.id));
  await hub.db.update(handoffs).set({ devId: into.id }).where(eq(handoffs.devId, ph.id));
  await hub.db.update(events).set({ devId: into.id }).where(eq(events.devId, ph.id));
  // composite-key tables: drop the placeholder's row where the real dev already has one
  const mine = await hub.db.select({ repoId: devRepo.repoId }).from(devRepo).where(eq(devRepo.devId, into.id));
  const mineRepos = mine.map((r) => r.repoId);
  if (mineRepos.length > 0) await hub.db.delete(devRepo).where(and(eq(devRepo.devId, ph.id), inArray(devRepo.repoId, mineRepos)));
  await hub.db.update(devRepo).set({ devId: into.id }).where(eq(devRepo.devId, ph.id));
  const myTargets = await hub.db.select({ cs: impactTargets.changeSetId, repoId: impactTargets.repoId }).from(impactTargets).where(eq(impactTargets.devId, into.id));
  const phTargets = await hub.db.select({ cs: impactTargets.changeSetId, repoId: impactTargets.repoId }).from(impactTargets).where(eq(impactTargets.devId, ph.id));
  const dupKeys = new Set(myTargets.map((t) => `${t.cs}|${t.repoId}`));
  const dupCs = phTargets.filter((t) => dupKeys.has(`${t.cs}|${t.repoId}`)).map((t) => t.cs);
  if (dupCs.length > 0) await hub.db.delete(impactTargets).where(and(eq(impactTargets.devId, ph.id), inArray(impactTargets.changeSetId, dupCs)));
  await hub.db.update(impactTargets).set({ devId: into.id }).where(eq(impactTargets.devId, ph.id));
  const emails = [...new Set([...into.emails, ...ph.emails])];
  await hub.db.update(devs).set({ mergedInto: into.handle }).where(eq(devs.id, ph.id));
  await hub.db.update(devs).set({ emails }).where(eq(devs.id, into.id));
  hub.cache.devs.delete(placeholder);
  hub.cache.devs.delete(into.handle);
  hub.cache.snapshots.clear();
  return { merged: true, sessions: moved.length };
}
