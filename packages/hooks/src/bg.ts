/**
 * Detached background worker `hook.mjs bg <job> --session <sid> --cwd <dir>
 * [--entry <ulid>]` (§4.12, §4.0 rules 5, 6, 11). Jobs: `session-start`,
 * `prompt`, `refresh`, `session-end`. Each job is single-flight per repo
 * (mkdir lock, stale after 30 s) under the 15 s watchdog, then runs the
 * budgeted chores: outbox drain, liveness sweep by pid, ancestry + auto-acks,
 * journal rotation, dependency index upload, plugin-behind check. Workers are
 * the only processes that open the breaker.
 */
import { join } from 'node:path';
import {
  BUDGET_MS,
  LIMITS,
  LOCAL_PATHS,
  acquireBgLock,
  appendJournal,
  clearRefreshWanted,
  configForMeta,
  createMark,
  deleteOutbox,
  derivePending,
  drainOutbox,
  ensureSessionMeta,
  hasMark,
  isOutboxEntry,
  isPidAlive,
  isRecord,
  listCurrentFiles,
  loadFold,
  nowIso,
  outboxPath,
  parseIso,
  postWithWal,
  readDraft,
  readJson,
  readMeta,
  readRepoState,
  readSnapshot,
  removeCurrentFile,
  repairSessionMeta,
  rotateJournalIfLarge,
  sessionDir,
  walSender,
  writeJsonAtomic,
  writeRepoState,
  type AckRequest,
  type BgJob,
  type DepIndex,
  type EventsRequest,
  type HubClient,
  type OutboxEntry,
  type PluginRemoteFile,
  type PromptEvent,
  type Snapshot,
} from '@relay/core';
import { commitEvents, postEvents } from './reconcile.js';
import { parseFlags, type HookRuntime } from './runtime.js';
import { hubClient, isInteractive, type SessionContext } from './session.js';
import { buildSessionEndBody } from './verbs/session-end.js';
import { recordReportedSha } from './verbs/post-git.js';

const JOBS: ReadonlySet<string> = new Set<BgJob>(['session-start', 'prompt', 'refresh', 'session-end']);
const DEPINDEX_MAX_AGE_MS = 86_400_000;
const PLUGIN_REMOTE_MAX_AGE_MS = 86_400_000;
const AUTO_ACK_CAP = 20;

/** Session context for a worker (no stdin): meta.json, healed from `cwd` when missing. */
export async function loadBgContext(rt: HookRuntime, sessionId: string, cwd: string): Promise<SessionContext | null> {
  const dir = sessionDir(rt.home, sessionId);
  let meta = readMeta(dir);
  if (!meta) {
    const res = await ensureSessionMeta({ home: rt.home, sessionId, cwd, env: rt.env, team: rt.team, pid: rt.env.pid, pluginSha: rt.pluginSha, now: rt.now(), signal: rt.signal });
    meta = res.meta;
  } else {
    // a SessionStart rev-parse timeout leaves branch/startSha/emails unset; workers have the budget to fix that
    const rep = await repairSessionMeta({ home: rt.home, sessionId, cwd, team: rt.team, now: rt.now(), signal: rt.signal });
    if (rep.repaired && rep.meta) {
      meta = rep.meta;
      rt.log(`meta repaired for ${sessionId} (branch ${meta.branch}, startSha ${meta.startSha?.slice(0, 7) ?? 'none'}, emails ${meta.gitEmails.length})`);
    }
  }
  if (!meta) return null;
  return {
    input: null,
    sessionId,
    cwd,
    dir,
    meta,
    healed: false,
    config: configForMeta(meta),
    key: meta.repoKey,
    interactive: isInteractive(rt, {}),
    inSubagent: false,
  };
}

export function readOutboxEntry(rt: HookRuntime, id: string): OutboxEntry | null {
  const v = readJson(outboxPath(rt.home, id));
  return isOutboxEntry(v) ? v : null;
}

/** Send one WAL entry; delete it on 2xx or on a permanent rejection (mirrors postWithWal). */
export async function sendEntry(rt: HookRuntime, client: HubClient, entry: OutboxEntry, budgetMs: number): Promise<boolean> {
  const send = walSender(client, { budgetMs, signal: rt.signal });
  let outcome: boolean | 'discard';
  try {
    outcome = await send(entry, entry.body);
  } catch {
    outcome = false;
  }
  if (outcome === true || outcome === 'discard') deleteOutbox(rt.home, entry.id);
  rt.log(`entry ${entry.id} (${entry.kind}) ${outcome === true ? 'sent' : outcome === 'discard' ? 'discarded' : 'kept'}`);
  return outcome === true;
}

/** Prompt worker (§4.2 step 4): add dirty paths and the current branch to the WAL body, then POST it. */
export async function postPromptEntry(rt: HookRuntime, ctx: SessionContext, client: HubClient, entryId: string): Promise<void> {
  const entry = readOutboxEntry(rt, entryId);
  if (!entry || entry.kind !== 'events') return;
  const body = entry.body as EventsRequest;
  const prompt = body.events.find((e): e is PromptEvent => e.type === 'prompt');
  if (prompt) {
    const [dirty, branch] = await Promise.all([rt.git.gitDirtyPaths(ctx.cwd, { signal: rt.signal, cap: LIMITS.dirtyPathsCap }), rt.git.gitBranch(ctx.cwd, { signal: rt.signal })]);
    if (dirty) prompt.dirty = dirty;
    if (branch) {
      prompt.branch = branch;
      body.session.branch = branch;
    }
    writeJsonAtomic(outboxPath(rt.home, entry.id), entry);
  }
  await sendEntry(rt, client, entry, BUDGET_MS.workerPost);
}

/** Liveness sweep (§4.0 rule 11): end sessions whose Claude pid is gone. */
export async function livenessSweep(rt: HookRuntime, ctx: SessionContext): Promise<number> {
  let ended = 0;
  for (const f of listCurrentFiles(rt.home)) {
    if (rt.signal.aborted) break;
    if (isPidAlive(f.pid)) continue;
    const dir = sessionDir(rt.home, f.sessionId);
    if (hasMark(dir, 'ended')) {
      removeCurrentFile(rt.home, f.pid);
      continue;
    }
    const meta = readMeta(dir);
    const now = rt.now();
    const sctx: SessionContext = { ...ctx, sessionId: f.sessionId, dir, cwd: f.cwd, meta: meta ?? ctx.meta, key: meta?.repoKey ?? f.repoKey, config: meta ? configForMeta(meta) : ctx.config };
    const body = buildSessionEndBody(sctx, 'crash', loadFold(dir), now);
    appendJournal(dir, { t: 'end', at: nowIso(now), reason: 'crash' });
    createMark(dir, 'ended');
    const client = hubClient(rt, { meta: sctx.meta, sessionId: f.sessionId, key: sctx.key }, 'worker');
    const { result } = await postWithWal(client, rt.home, { sessionId: f.sessionId, kind: 'session_end', endpoint: '/v1/session/end', body, now }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
    rt.log(`liveness: ended ${f.sessionId} (pid ${f.pid} gone) ${result.ok ? 'ok' : result.kind}`);
    removeCurrentFile(rt.home, f.pid);
    ended += 1;
  }
  return ended;
}

/** Ancestry refresh + auto-acks for change sets that reached my branch (§4.12, §7.2 last row). */
export async function ancestryChore(rt: HookRuntime, ctx: SessionContext, client: HubClient): Promise<string[]> {
  const snapshot = readSnapshot(rt.home, ctx.key);
  if (!snapshot) return [];
  const { newlyMerged } = await rt.git.refreshAncestry(rt.home, ctx.key, ctx.cwd, snapshot, { signal: rt.signal, now: rt.now(), maxChecks: 40 });
  for (const id of newlyMerged.slice(0, AUTO_ACK_CAP)) {
    if (rt.signal.aborted) break;
    const r = await client.post('/v1/ack', { id, auto: true } satisfies AckRequest, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
    rt.log(`auto-ack ${id}: ${r.ok ? 'ok' : r.kind}`);
  }
  derivePending(rt.home, ctx.sessionId, readSnapshot(rt.home, ctx.key) ?? snapshot);
  return newlyMerged;
}

/** Dependency index rebuild + upload when HEAD changed or the index is > 24 h old (§7.4). */
export async function depindexChore(rt: HookRuntime, ctx: SessionContext, client: HubClient): Promise<boolean> {
  const head = await rt.git.gitHead(ctx.cwd, { signal: rt.signal });
  if (!head) return false;
  const state = readRepoState(rt.home, ctx.key);
  const builtAt = parseIso(state.depindexAt);
  if (state.depindexHead === head && builtAt !== null && rt.now() - builtAt < DEPINDEX_MAX_AGE_MS) return false;
  const idx = await rt.git.buildDepIndex(ctx.cwd, { repo: ctx.meta.repo, head }, { signal: rt.signal, timeoutMs: Math.min(8000, Math.max(1000, rt.remainingMs() - 3500)) });
  if (!idx) return false;
  const { result } = await postWithWal<{ ok: true }>(client, rt.home, { sessionId: ctx.sessionId, kind: 'depindex', endpoint: '/v1/depindex', body: idx satisfies DepIndex, now: rt.now() }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
  if (result.ok) writeRepoState(rt.home, ctx.key, { ...readRepoState(rt.home, ctx.key), depindexHead: head, depindexAt: nowIso(rt.now()) });
  rt.log(`depindex ${head.slice(0, 7)}: ${Object.keys(idx.imports).length} specifiers, upload ${result.ok ? 'ok' : result.kind}`);
  return result.ok;
}

/** Plugin-behind check: marketplace clone `ls-remote` vs the installed commit, cached 24 h (§3.4). */
export async function pluginBehindChore(rt: HookRuntime): Promise<void> {
  const path = join(rt.home, LOCAL_PATHS.pluginRemote);
  const cached = readJson(path) as Partial<PluginRemoteFile> | null;
  const checkedAt = cached && typeof cached.checkedAt === 'string' ? parseIso(cached.checkedAt) : null;
  if (checkedAt !== null && rt.now() - checkedAt < PLUGIN_REMOTE_MAX_AGE_MS) return;
  const names = [rt.team?.marketplace, 'relay'].filter((n): n is string => typeof n === 'string' && /^[\w.-]+$/.test(n));
  for (const name of names) {
    const sha = await rt.git.gitLsRemoteHead(join(rt.claudeHome, 'plugins', 'marketplaces', name), 'origin', { signal: rt.signal });
    if (sha) {
      writeJsonAtomic(path, { sha, checkedAt: nowIso(rt.now()) } satisfies PluginRemoteFile);
      return;
    }
  }
  // no clone reachable: remember the attempt so it is not retried on every worker
  writeJsonAtomic(path, { sha: cached?.sha ?? '', checkedAt: nowIso(rt.now()) });
}

/** Author-filtered commit backfill for commits made outside Claude (§4.1 step 6, §7.2). */
export async function backfillCommits(rt: HookRuntime, ctx: SessionContext): Promise<number> {
  const head = await rt.git.gitHead(ctx.cwd, { signal: rt.signal });
  if (!head) return 0;
  const state = readRepoState(rt.home, ctx.key);
  const from = state.lastReportedSha[ctx.meta.branch] ?? ctx.meta.startSha;
  if (!from || from === head) {
    if (!state.lastReportedSha[ctx.meta.branch]) recordReportedSha(rt, ctx, ctx.meta.branch, head, { onlyIfUnknown: true });
    return 0;
  }
  const own = (await rt.git.gitOwnCommits(ctx.cwd, { emails: ctx.meta.gitEmails, from, cap: LIMITS.commitBackfillCap }, { signal: rt.signal })) ?? [];
  const events = await commitEvents(rt, ctx, own.reverse(), loadFold(ctx.dir), rt.now());
  if (events.length) await postEvents(rt, ctx, events, { role: 'worker', budgetMs: BUDGET_MS.workerPost });
  if (!rt.signal.aborted) recordReportedSha(rt, ctx, ctx.meta.branch, head);
  return events.length;
}

export interface ChoreOptions {
  ancestry?: boolean;
  depindex?: boolean;
  plugin?: boolean;
  rotate?: boolean;
}

/** The shared chores, each budgeted by the worker's abort signal (§4.12). */
export async function runChores(rt: HookRuntime, ctx: SessionContext, client: HubClient, opts: ChoreOptions = {}): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    if (rt.signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      rt.log(`chore ${name} failed: ${String(err)}`);
    }
  };
  await step('drain', async () => {
    const r = await drainOutbox(rt.home, walSender(client, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal }), { now: rt.now() });
    if (r.sent.length || r.dropped.length || r.failedAt) rt.log(`drain: sent ${r.sent.length}, dropped ${r.dropped.length}, skipped ${r.skipped.length}${r.failedAt ? `, stopped at ${r.failedAt}` : ''}`);
  });
  await step('liveness', () => livenessSweep(rt, ctx));
  if (opts.ancestry !== false) await step('ancestry', () => ancestryChore(rt, ctx, client));
  if (opts.rotate !== false) await step('rotate', () => rotateJournalIfLarge(ctx.dir));
  if (opts.depindex) await step('depindex', () => depindexChore(rt, ctx, client));
  if (opts.plugin) await step('plugin', () => pluginBehindChore(rt));
}

export async function runBg(rt: HookRuntime): Promise<void> {
  const [job, ...rest] = rt.args;
  if (!job || !JOBS.has(job)) return;
  const flags = parseFlags(rest);
  const sessionId = flags['session'] ?? rt.env.sessionId ?? null;
  const cwd = flags['cwd'] ?? process.cwd();
  if (!sessionId) return;
  const ctx = await loadBgContext(rt, sessionId, cwd);
  if (!ctx) return;
  const client = hubClient(rt, ctx, 'worker');
  rt.log(`bg ${job} for ${sessionId} (${ctx.meta.repo})`);

  // Entry posts are idempotent (event ids, WAL) and never wait for the single-flight lock.
  const entryId = flags['entry'];
  if (job === 'session-end' && entryId) {
    const entry = readOutboxEntry(rt, entryId);
    if (entry) await sendEntry(rt, client, entry, BUDGET_MS.sessionEndPost);
  } else if (job === 'prompt' && entryId) {
    await postPromptEntry(rt, ctx, client, entryId);
  }

  const release = acquireBgLock(rt.home, job, ctx.key, { now: rt.now() });
  if (!release) {
    rt.log(`bg ${job}: another worker holds the lock`);
    return;
  }
  try {
    switch (job as BgJob) {
      case 'session-start': {
        await postEvents(rt, ctx, [], { role: 'worker', budgetMs: BUDGET_MS.workerPost }); // first presence post
        await backfillCommits(rt, ctx);
        await runChores(rt, ctx, client, { depindex: true, plugin: true });
        break;
      }
      case 'prompt':
        await runChores(rt, ctx, client, {});
        break;
      case 'refresh': {
        const r = await client.get<Snapshot>('/v1/snapshot', { repo: ctx.meta.repo }, { budgetMs: BUDGET_MS.workerPost, signal: rt.signal });
        if (r.ok) clearRefreshWanted(rt.home);
        rt.log(`refresh: ${r.ok ? 'ok' : r.kind} in ${r.ms} ms`);
        await runChores(rt, ctx, client, {});
        break;
      }
      case 'session-end':
        await runChores(rt, ctx, client, { ancestry: false, rotate: false });
        break;
    }
  } finally {
    release();
  }
}

/** Exposed for tests: is a value an events body with a prompt event? */
export function isPromptBody(v: unknown): v is EventsRequest {
  return isRecord(v) && Array.isArray(v['events']) && v['events'].some((e) => isRecord(e) && e['type'] === 'prompt');
}
