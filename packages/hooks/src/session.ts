/**
 * Shared per-verb preparation (§4.0 rules 10, 11, 13, 14): self-healing
 * meta.json, the liveness file, config, interactivity, hub clients that write
 * the snapshot cache on every response, presence bodies and the inbox
 * delivery that every snapshot-bearing hook shares (§4.2 step 3, §4.5 step 3).
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  HubClient,
  LIMITS,
  applySnapshot,
  areaOfPath,
  configForMeta,
  createMark,
  deriveObjective,
  ensureSessionMeta,
  hasMark,
  isRecord,
  loadFold,
  makeCurrentFile,
  readAncestry,
  repairSessionMeta,
  renderChangeSetNote,
  renderInbox,
  renderInboxItem,
  sessionDir,
  toPosix,
  voteArea,
  writeCurrentFile,
  type HookInput,
  type HookOutput,
  type HookSpecificOutput,
  type JournalFold,
  type LoadedRelayConfig,
  type RepoKey,
  type SessionMeta,
  type SessionPresence,
  type SessionStartSource,
  type Snapshot,
} from '@relay/core';
import type { HookRuntime } from './runtime.js';

export interface SessionContext {
  /** the hook's stdin; null inside background workers */
  input: HookInput | null;
  sessionId: string;
  cwd: string;
  /** sessions/<sid> */
  dir: string;
  meta: SessionMeta;
  healed: boolean;
  config: LoadedRelayConfig;
  key: RepoKey;
  /** ask allowed (§4.0 rule 14; experiment B.5: sdk-cli entrypoints are headless) */
  interactive: boolean;
  inSubagent: boolean;
}

/** Interactivity per §4.0 rule 14 plus experiment B.5 (any entrypoint other than cli / claude-desktop is headless). */
export function isInteractive(rt: HookRuntime, input: Pick<HookInput, 'permission_mode' | 'agent_id'>): boolean {
  if (!rt.env.interactive) return false;
  if (typeof input.agent_id === 'string' && input.agent_id) return false;
  if (input.permission_mode === 'dontAsk' || input.permission_mode === 'bypassPermissions') return false;
  const entry = rt.env.entrypoint;
  if (entry && entry !== 'cli' && entry !== 'claude-desktop') return false;
  return true;
}

/** Ensure meta.json (healing it when needed), write current/<pid>.json, load config. */
export async function prepareSession(
  rt: HookRuntime,
  input: HookInput,
  opts: { force?: boolean; source?: SessionStartSource | null; model?: string | null; cwd?: string; repair?: boolean } = {},
): Promise<SessionContext> {
  const cwd = opts.cwd ?? input.cwd;
  const sessionId = input.session_id;
  const res = await ensureSessionMeta({
    home: rt.home,
    sessionId,
    cwd,
    env: rt.env,
    team: rt.team,
    pid: rt.env.pid,
    source: opts.source ?? null,
    model: opts.model ?? null,
    pluginSha: rt.pluginSha,
    force: opts.force ?? false,
    now: rt.now(),
    signal: rt.signal,
  });
  let meta = res.meta;
  // Async hooks (post-edit, post-git, stop) may spend a git call to fill holes a SessionStart
  // rev-parse timeout left behind (branch unknown / no start SHA / no author filter); sync verbs never do.
  if (opts.repair && !res.healed) {
    const rep = await repairSessionMeta({ home: rt.home, sessionId, cwd, team: rt.team, now: rt.now(), signal: rt.signal });
    if (rep.repaired && rep.meta) {
      meta = rep.meta;
      rt.log(`meta repaired for ${sessionId} (branch ${meta.branch}, startSha ${meta.startSha?.slice(0, 7) ?? 'none'}, emails ${meta.gitEmails.length})`);
    }
  }
  const dir = sessionDir(rt.home, sessionId);
  const config = res.config ?? configForMeta(meta);
  if (rt.env.pid) {
    writeCurrentFile(rt.home, makeCurrentFile({ home: rt.home, pid: rt.env.pid, sessionId, cwd, repoKey: meta.repoKey, dev: meta.dev, now: rt.now() }));
  }
  if (res.healed) rt.log(`meta healed for ${sessionId} (repo ${meta.repo}, branch ${meta.branch})`);
  return {
    input,
    sessionId,
    cwd,
    dir,
    meta,
    healed: res.healed,
    config,
    key: meta.repoKey,
    interactive: isInteractive(rt, input),
    inSubagent: typeof input.agent_id === 'string' && input.agent_id.length > 0,
  };
}

/** No team.json and no RELAY_HUB/RELAY_TOKEN: nothing can ever be sent, so verbs keep the journal but skip the WAL and workers. */
export function hubConfigured(rt: HookRuntime): boolean {
  return Boolean(rt.team?.hub && rt.team.token);
}

/** A hub client whose every 2xx response refreshes the snapshot cache (§4.0 rule 8). */
export function hubClient(rt: HookRuntime, ctx: Pick<SessionContext, 'meta' | 'sessionId' | 'key'>, role: 'sync' | 'worker'): HubClient {
  return new HubClient({
    hub: rt.team?.hub ?? '',
    token: rt.team?.token ?? '',
    dev: ctx.meta.dev,
    client: ctx.meta.client,
    sessionId: ctx.sessionId,
    pluginSha: rt.pluginSha,
    home: rt.home,
    role,
    fetch: rt.fetch,
    onSnapshot: (s: Snapshot) => {
      applySnapshot(rt.home, ctx.key, s, { sessionId: ctx.sessionId, now: rt.now(), myDev: ctx.meta.dev });
    },
  });
}

/** Presence fields of every POST /v1/events (§6.1; decision 6: enough to lazily create the session row). */
export function buildPresence(rt: HookRuntime, ctx: Pick<SessionContext, 'meta' | 'sessionId' | 'cwd' | 'config'>, fold: JournalFold = loadFold(sessionDir(rt.home, ctx.sessionId))): SessionPresence {
  const meta = ctx.meta;
  const areas = ctx.config.resolved.areas;
  const objective = deriveObjective(fold, {
    branch: meta.branch,
    repoSlug: meta.repo,
    objectiveFromPrompts: ctx.config.resolved.privacy.objective_from_prompts,
  });
  let cwdRel: string | null = null;
  try {
    cwdRel = toPosix(relative(meta.repoRoot, ctx.cwd));
  } catch {
    cwdRel = null;
  }
  const area = voteArea({
    recentEdits: fold.recentPaths.slice(0, 20).map((p) => ({ path: p, at: fold.edits[p]?.lastAt ?? meta.startedAt })),
    areas,
    branch: meta.branch,
    dev: meta.dev,
    cwdRel,
    now: rt.now(),
  });
  return {
    id: ctx.sessionId,
    repo: meta.repo,
    branch: meta.branch,
    worktree: meta.worktree,
    area: area.display,
    objective: objective.text,
    objectiveSource: objective.source,
    cwd: ctx.cwd,
    client: meta.client,
    host: meta.host,
    project: meta.project,
    startSha: meta.startSha,
    pluginSha: meta.pluginSha,
  };
}

/** `areaOfPath` for the session's config (session-end file summaries, drafts). */
export function areaFor(ctx: Pick<SessionContext, 'config'>, path: string): string | null {
  return areaOfPath(path, ctx.config.resolved.areas);
}

export interface InboxDelivery {
  lines: string[];
  /** ids marked as delivered (inbox items and change sets) */
  delivered: string[];
}

/**
 * Undelivered inbox items (and optionally change sets) for this session. A
 * `wx` mark is created before a line is emitted: of N parallel hooks exactly
 * one prints each item (§4.0 rule 9, §4.2 step 3).
 */
export function collectInbox(
  rt: HookRuntime,
  ctx: Pick<SessionContext, 'dir' | 'key'>,
  snapshot: Pick<Snapshot, 'inbox' | 'changeSets'> | null,
  opts: { changeSets?: 'high' | 'all' | 'none'; withHunk?: boolean } = {},
): InboxDelivery {
  const out: InboxDelivery = { lines: [], delivered: [] };
  if (!snapshot) return out;
  for (const item of snapshot.inbox ?? []) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    if (hasMark(ctx.dir, 'seen', item.id)) continue;
    if (createMark(ctx.dir, 'seen', item.id) !== 'created') continue;
    out.lines.push(renderInboxItem(item));
    out.delivered.push(item.id);
  }
  const mode = opts.changeSets ?? 'none';
  if (mode !== 'none') {
    const merged = readAncestry(rt.home, ctx.key)?.merged ?? {};
    for (const cs of snapshot.changeSets ?? []) {
      if (mode === 'high' && cs.priority !== 'high') continue;
      if (merged[cs.id]) continue;
      if (hasMark(ctx.dir, 'jit', cs.id) || hasMark(ctx.dir, 'seen', cs.id)) continue;
      if (createMark(ctx.dir, 'jit', cs.id) !== 'created') continue;
      out.lines.push(renderChangeSetNote(cs, { now: rt.now(), withHunk: opts.withHunk ?? false, merged: merged[cs.id] }));
      out.delivered.push(cs.id);
    }
  }
  return out;
}

/** `<relay-inbox>` block or null (≤ 1,500 chars, §4.2 step 3). */
export function inboxBlock(rt: HookRuntime, delivery: InboxDelivery, maxChars: number = LIMITS.promptInboxChars): string | null {
  return renderInbox(delivery.lines, { now: rt.now(), maxChars });
}

/** Append `export RELAY_*` lines to $CLAUDE_ENV_FILE (§4.1 step 5, §4.7). */
export function appendEnvExports(rt: HookRuntime, meta: Pick<SessionMeta, 'dev' | 'project'>): boolean {
  const file = rt.env.envFile;
  if (!file) return false;
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    appendFileSync(file, `export RELAY_DEV=${q(meta.dev)}\nexport RELAY_PROJECT=${q(meta.project)}\n`);
    return true;
  } catch (err) {
    rt.log(`env file append failed: ${String(err)}`);
    return false;
  }
}

/** Build the single stdout object; null when there is nothing to say (§4.0 rule 3). */
export function output(specific: HookSpecificOutput | null, extra: Omit<HookOutput, 'hookSpecificOutput'> = {}): HookOutput | null {
  const out: HookOutput = { ...extra };
  if (specific) {
    const hasField = Object.entries(specific).some(([k, v]) => k !== 'hookEventName' && v !== undefined && v !== '');
    if (hasField) out.hookSpecificOutput = specific;
  }
  return Object.keys(out).length ? out : null;
}
