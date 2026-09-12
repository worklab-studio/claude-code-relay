/**
 * SessionStart (no matcher: startup|resume|clear|compact|fork) → verb
 * `session-start` (§4.1, §9.3). Identity + repo via the self-healing meta
 * (parallel rev-parse), liveness file, statusline install, `POST
 * /v1/session/start` (3 s budget; delta mode on resume/fork < 12 h), digest
 * injection with the client-side lines (identity unknown, config error, plugin
 * behind), `sessionTitle` when an objective is known, CLAUDE_ENV_FILE exports,
 * detached `bg session-start`. `compact` re-injects ≤ 1,500 chars from the cache
 * with no network. Fail-open: cached digest or the offline line.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUDGET_MS,
  LIMITS,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
  breakerOpen,
  createMark,
  deriveObjective,
  isPlaceholderHandle,
  isRecord,
  loadFold,
  parseIso,
  readAncestry,
  readBreaker,
  readDigest,
  readJson,
  readMeta,
  readSnapshot,
  renderCompactReinjection,
  renderIdentityUnknownLine,
  renderOfflineDigest,
  renderPluginUpdateLine,
  sessionDir,
  toPosix,
  voteArea,
  wrapCachedDigest,
  writeAtomic,
  writeDigest,
  type HookOutput,
  type PluginRemoteFile,
  type SessionStartInput,
  type SessionStartRequest,
  type SessionStartResponse,
  type SessionStartSource,
} from '@relay/core';
import { relative } from 'node:path';
import type { HookRuntime } from '../runtime.js';
import { appendEnvExports, hubClient, output, prepareSession, type SessionContext } from '../session.js';

const SOURCES: ReadonlySet<string> = new Set<SessionStartSource>(['startup', 'resume', 'clear', 'compact', 'fork']);
const DELTA_WINDOW_MS = 12 * 3_600_000;

/** Insert client-side lines right after the opening `<relay-digest …>` tag (§9.3: identity / plugin lines come first). */
export function insertDigestLines(digest: string, lines: readonly string[]): string {
  const extra = lines.filter(Boolean);
  if (!extra.length) return digest;
  const close = digest.indexOf('>');
  if (!digest.startsWith('<relay-digest') || close < 0) return `${extra.join('\n')}\n${digest}`;
  const head = digest.slice(0, close + 1);
  let tail = digest.slice(close + 1);
  if (tail.startsWith('\n')) tail = tail.slice(1);
  return `${head}\n${extra.join('\n')}\n${tail}`;
}

/** Copy the plugin's statusline.sh into $RELAY_HOME when it changed; remember the user's own status line command (§4.1 step 2, §4.11). */
export function installStatusline(rt: HookRuntime): void {
  if (rt.env.pluginRoot) {
    const src = join(rt.env.pluginRoot, 'scripts', 'statusline.sh');
    const dst = join(rt.home, LOCAL_PATHS.statusline);
    try {
      const a = readFileSync(src, 'utf8');
      let b: string | null = null;
      try {
        b = readFileSync(dst, 'utf8');
      } catch {
        b = null;
      }
      if (a !== b) copyFileSync(src, dst);
    } catch {
      /* plugin without a statusline script */
    }
  }
  const settings = readJson(join(rt.claudeHome, 'settings.json'));
  const statusLine = isRecord(settings) ? settings['statusLine'] : null;
  const command = isRecord(statusLine) && typeof statusLine['command'] === 'string' ? statusLine['command'] : null;
  if (command && !/statusline\.sh|relay/i.test(command)) writeAtomic(join(rt.home, LOCAL_PATHS.statuslineChain), command + '\n');
}

/** Client-side digest lines: config error (401/426/413) and plugin-behind (§3.4, §4.0 rule 5). */
export function clientDigestLines(rt: HookRuntime, ctx: Pick<SessionContext, 'meta'>, opts: { offline: boolean }): string[] {
  const lines: string[] = [];
  if (opts.offline && isPlaceholderHandle(ctx.meta.dev)) lines.push(renderIdentityUnknownLine(ctx.meta.gitEmail));
  const breaker = readBreaker(rt.home, rt.now());
  if (breaker.configError) lines.push(renderPluginUpdateLine(breaker.configError.status, breaker.configError.message));
  const remote = readJson(join(rt.home, LOCAL_PATHS.pluginRemote)) as Partial<PluginRemoteFile> | null;
  const local = rt.pluginSha;
  if (remote && typeof remote.sha === 'string' && local && /^[0-9a-f]{40}$/.test(local) && /^[0-9a-f]{40}$/.test(remote.sha) && remote.sha !== local) {
    lines.push(renderPluginUpdateLine(null, `local ${local.slice(0, 7)}, marketplace ${remote.sha.slice(0, 7)}`));
  }
  return lines;
}

/** Change sets the digest already showed are `seen` for this session so the first prompt does not repeat them (§4.2 step 3); JIT notes key on `jit` marks and still fire at edit time (§4.3 step 4). */
export function markDigestChangeSetsSeen(dir: string, digest: string): string[] {
  const ids = [...new Set(digest.match(/\bcs_[0-9A-Za-z]{10,32}\b/g) ?? [])];
  for (const id of ids) createMark(dir, 'seen', id);
  return ids;
}

/** `<area>: <objective>` only when an objective is already known (§4.1 step 4). */
export function sessionTitleFor(rt: HookRuntime, ctx: Pick<SessionContext, 'dir' | 'meta' | 'config' | 'cwd'>): string | null {
  const fold = loadFold(ctx.dir);
  const objective = deriveObjective(fold, { branch: ctx.meta.branch, repoSlug: ctx.meta.repo, objectiveFromPrompts: ctx.config.resolved.privacy.objective_from_prompts });
  if (objective.source === 'branch') return null;
  let cwdRel: string | null = null;
  try {
    cwdRel = toPosix(relative(ctx.meta.repoRoot, ctx.cwd));
  } catch {
    cwdRel = null;
  }
  const area = voteArea({
    recentEdits: fold.recentPaths.slice(0, 20).map((p) => ({ path: p, at: fold.edits[p]?.lastAt ?? ctx.meta.startedAt })),
    areas: ctx.config.resolved.areas,
    branch: ctx.meta.branch,
    dev: ctx.meta.dev,
    cwdRel,
    now: rt.now(),
  });
  return `${area.display}: ${objective.text}`.slice(0, 120);
}

export async function runSessionStart(rt: HookRuntime, input: SessionStartInput): Promise<HookOutput | null> {
  const source: SessionStartSource = SOURCES.has(input.source) ? input.source : 'startup';
  const model = typeof input.model === 'string' ? input.model : null;
  const before = readMeta(sessionDir(rt.home, input.session_id));

  if (source === 'compact') {
    // No network: re-inject from the cache (§4.1 "Does (compact)")
    const ctx = await prepareSession(rt, input, { source });
    const fold = loadFold(ctx.dir);
    const objective = deriveObjective(fold, { branch: ctx.meta.branch, repoSlug: ctx.meta.repo, objectiveFromPrompts: ctx.config.resolved.privacy.objective_from_prompts });
    const text = renderCompactReinjection(readSnapshot(rt.home, ctx.key), {
      meDev: ctx.meta.dev,
      objective: objective.source === 'branch' ? null : objective.text,
      now: rt.now(),
      ancestryMerged: readAncestry(rt.home, ctx.key)?.merged,
    });
    return output({ hookEventName: 'SessionStart', additionalContext: text });
  }

  const ctx = await prepareSession(rt, input, { force: true, source, model });
  installStatusline(rt);
  appendEnvExports(rt, ctx.meta);
  const now = rt.now();
  const meta = ctx.meta;

  // mode: delta on resume/fork when the previous lastStopAt is < 12 h old (§4.1 step 3)
  const lastStopAt = before?.lastStopAt ? parseIso(before.lastStopAt) : null;
  const delta = (source === 'resume' || source === 'fork') && lastStopAt !== null && now - lastStopAt < DELTA_WINDOW_MS;
  const placeholder = before && isPlaceholderHandle(before.dev) && !isPlaceholderHandle(meta.dev) ? before.dev : undefined;

  let digest: string | null = null;
  let failure: string | null = null;
  if (rt.team && !breakerOpen(rt.home, now)) {
    const recentShas = await rt.git.gitRecentShas(ctx.cwd, LIMITS.recentShas, { signal: rt.signal });
    const body: SessionStartRequest = {
      v: PROTOCOL_VERSION,
      session: {
        id: ctx.sessionId,
        source,
        client: meta.client,
        host: meta.host,
        cwd: ctx.cwd,
        repo: { slug: meta.repo, root: meta.repoRoot, project: meta.project, config: ctx.config.raw, configHash: ctx.config.hash },
        branch: meta.branch,
        worktree: meta.worktree,
        startSha: meta.startSha,
        model: meta.model,
        pluginSha: meta.pluginSha,
      },
      mode: delta ? 'delta' : 'full',
      ...(delta && before?.lastStopAt ? { since: before.lastStopAt } : {}),
      recentShas,
      identityHint: { gitEmail: meta.gitEmail, ...(placeholder ? { placeholder } : {}), source: meta.identitySource },
    };
    const client = hubClient(rt, ctx, 'sync');
    const budgetMs = Math.min(BUDGET_MS.sessionStartPost, Math.max(300, rt.remainingMs() - 150));
    const r = await client.post<SessionStartResponse>('/v1/session/start', body, { budgetMs, signal: rt.signal });
    if (r.ok && isRecord(r.data) && typeof r.data['digest'] === 'string') {
      digest = r.data['digest'];
      writeDigest(rt.home, ctx.key, digest);
      markDigestChangeSetsSeen(ctx.dir, digest);
      rt.log(`session start ok in ${r.ms} ms (${digest.length} chars, mode ${body.mode})`);
    } else {
      failure = r.ok ? 'no digest in response' : `${r.kind}${r.status ? ` ${r.status}` : ''}: ${r.message}`;
      rt.log(`session start failed: ${failure}`);
    }
  } else {
    failure = rt.team ? 'breaker open' : 'no team.json / RELAY_HUB';
    rt.log(`session start skipped: ${failure}`);
  }

  const offline = digest === null;
  if (digest === null) {
    const cached = readDigest(rt.home, ctx.key, now);
    digest = cached ? wrapCachedDigest(cached.digest, cached.ageMs) : renderOfflineDigest(now);
  }
  digest = insertDigestLines(digest, clientDigestLines(rt, ctx, { offline }));
  if (digest.length > LIMITS.digestChars + 600) digest = digest.slice(0, LIMITS.digestChars + 600);

  rt.spawnBg('session-start', ['--session', ctx.sessionId, '--cwd', ctx.cwd]);

  const title = !ctx.inSubagent && (source === 'startup' || source === 'resume' || source === 'fork') ? sessionTitleFor(rt, ctx) : null;
  return output({ hookEventName: 'SessionStart', additionalContext: digest, ...(title ? { sessionTitle: title } : {}) });
}
