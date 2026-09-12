/**
 * Contract detection and event posting shared by post-edit, post-git, stop and
 * the background worker (§4.5 step 2, §4.6, §4.8 step 2, §7.2, §7.3): working-
 * tree contract events with hunk hash, blob id and in-repo dependents; own-
 * commit events with per-file contract extraction; WAL-first POST /v1/events.
 */
import { basename } from 'node:path';
import {
  LIMITS,
  appendJournal,
  detectContract,
  diffIsEmpty,
  fileLang,
  isContractPath,
  loadFold,
  makeEvent,
  nearestPackageName,
  nowIso,
  openContracts,
  postWithWal,
  redact,
  type CommitContract,
  type CommitEvent,
  type ContractEvent,
  type EventsRequest,
  type EventsResponse,
  type HookOutput,
  type JournalFold,
  type OwnCommit,
  type RelayEvent,
  type RetractEvent,
} from '@relay/core';
import type { HookRuntime } from './runtime.js';
import { buildPresence, collectInbox, hubClient, hubConfigured, inboxBlock, output, type SessionContext } from './session.js';

/** Files the export scan can look at (§7.1 signal 2). */
export function exportScanEligible(path: string): boolean {
  const lang = fileLang(path);
  return lang === 'ts' || lang === 'js' || lang === 'py' || lang === 'go';
}

/** Contract candidate paths: glob/shared-area matches always, export-scan-eligible files when the scan is on. */
export function contractCandidatePaths(ctx: Pick<SessionContext, 'config'>, paths: readonly string[], cap = 20): string[] {
  const cfg = ctx.config.resolved;
  const out: string[] = [];
  for (const p of paths) {
    if (isContractPath(p, { globs: cfg.contracts.globs, areas: cfg.areas })) out.push(p);
    else if (cfg.contracts.export_scan && exportScanEligible(p)) out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

/** Split a multi-file `git show`/`git diff` into per-file diff texts keyed by the new path. */
export function splitDiffByFile(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current && buf.length) out[current] = (out[current] ? out[current] + '\n' : '') + buf.join('\n');
    buf = [];
  };
  for (const line of text.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      flush();
      current = m[2] ?? null;
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && !current) current = plus[1] ?? null;
    if (current) buf.push(line);
  }
  flush();
  return out;
}

/** Did an own commit touching `rel` land at or after the open record was written? */
export function committedAfter(fold: JournalFold, rel: string, recordAt: string): boolean {
  return fold.commits.some((c) => (c.contracts.includes(rel) || c.files.includes(rel)) && c.at >= recordAt);
}

export interface WorkingTreeContract {
  event: ContractEvent | null;
  retract: RetractEvent | null;
}

/**
 * Contract event (or retract) for one working-tree path (§4.5 step 2). `diff`
 * is the caller's `git diff -U0 -w HEAD -- <path>` result so post-edit and stop
 * share the budget accounting; `null` diff (git failed) yields nothing.
 */
export async function workingTreeContract(
  rt: HookRuntime,
  ctx: SessionContext,
  rel: string,
  diff: string | null,
  fold: JournalFold,
  now: number = rt.now(),
): Promise<WorkingTreeContract> {
  const none: WorkingTreeContract = { event: null, retract: null };
  if (diff === null) return none;
  const open = openContracts(fold)[rel];
  if (diffIsEmpty(diff)) {
    // A working tree equal to HEAD is a revert only when no own commit carried the record (§4.8 step 2):
    // once the change is committed the record is closed by the commit, not withdrawn.
    if (!open || committedAfter(fold, rel, open.at)) return none;
    const retract = makeEvent<RetractEvent>({ type: 'retract', path: rel, impactId: null, hash: open.hash }, now);
    appendJournal(ctx.dir, { ...open, at: nowIso(now), retracted: true, eventId: retract.id });
    return { event: null, retract };
  }
  const cand = detectContract({ path: rel, diffText: diff, config: ctx.config.resolved });
  if (!cand) return none;
  if (fold.contracts[rel]?.hash === cand.hash && !fold.contracts[rel]?.retracted) return none; // unchanged since the last record
  const blobId = await rt.git.gitHashObject(ctx.cwd, rel, { signal: rt.signal });
  const kind = cand.lang === 'prisma' || cand.lang === 'openapi' || cand.lang === 'graphql' ? cand.lang : 'ts';
  const deps = await rt.git.findDependents(
    ctx.cwd,
    { path: rel, packageName: nearestPackageName(ctx.meta.repoRoot, rel), symbols: cand.symbols, kind },
    { signal: rt.signal, timeoutMs: Math.min(2000, Math.max(300, rt.remainingMs() - 500)) },
  );
  const event = makeEvent<ContractEvent>(
    {
      type: 'contract',
      path: rel,
      symbols: cand.symbols,
      kinds: cand.kinds,
      ...(ctx.config.resolved.privacy.send_diffs === 'none' ? {} : { hunk: redact(cand.hunk).slice(0, LIMITS.hunkChars) }),
      hash: cand.hash,
      blobId,
      dependents: deps,
      summary: cand.summary,
      branch: ctx.meta.branch,
    },
    now,
  );
  appendJournal(ctx.dir, { t: 'contract', at: nowIso(now), path: rel, hash: cand.hash, blobId, symbols: cand.symbols, kinds: cand.kinds, eventId: event.id });
  return { event, retract: null };
}

/** Contract records inside one own commit (§4.6): `git show -U0 -w` per candidate file. */
export async function commitContracts(rt: HookRuntime, ctx: SessionContext, sha: string, files: readonly string[]): Promise<CommitContract[]> {
  const candidates = contractCandidatePaths(ctx, files);
  if (!candidates.length) return [];
  const text = await rt.git.gitShowU0(ctx.cwd, sha, candidates, { signal: rt.signal });
  const byFile = splitDiffByFile(text);
  const out: CommitContract[] = [];
  for (const path of candidates) {
    const cand = detectContract({ path, diffText: byFile[path] ?? null, config: ctx.config.resolved });
    if (!cand) continue;
    const blobId = await rt.git.gitBlobAt(ctx.cwd, sha, path, { signal: rt.signal });
    out.push({
      path,
      symbols: cand.symbols,
      kinds: cand.kinds,
      ...(ctx.config.resolved.privacy.send_diffs === 'none' ? {} : { hunk: redact(cand.hunk).slice(0, LIMITS.hunkChars) }),
      hash: cand.hash,
      blobId,
    });
  }
  return out;
}

/** Commit events for own-author commits not yet in the journal (§4.6, §7.2); each is journaled as it is built. */
export async function commitEvents(rt: HookRuntime, ctx: SessionContext, commits: readonly OwnCommit[], fold: JournalFold, now: number = rt.now()): Promise<CommitEvent[]> {
  const known = new Set(fold.commits.map((c) => c.sha));
  const events: CommitEvent[] = [];
  for (const c of commits) {
    if (known.has(c.sha) || rt.signal.aborted) continue;
    const files = (await rt.git.gitCommitFiles(ctx.cwd, c.sha, { signal: rt.signal })) ?? [];
    const contracts = await commitContracts(rt, ctx, c.sha, files);
    const patchId = contracts.length ? await rt.git.gitPatchId(ctx.cwd, c.sha, { signal: rt.signal }) : null;
    const event = makeEvent<CommitEvent>(
      { type: 'commit', sha: c.sha, patchId, authorEmail: c.authorEmail, subject: c.subject.slice(0, 200), files: files.slice(0, 200), contracts, branch: ctx.meta.branch },
      now,
    );
    appendJournal(ctx.dir, { t: 'commit', at: nowIso(now), sha: c.sha, subject: event.subject, files: files.slice(0, 50), contracts: contracts.map((x) => x.path) });
    events.push(event);
  }
  return events;
}

export interface PostEventsResult {
  ok: boolean;
  /** `<relay-inbox>` block for the hook's additionalContext (async hooks: next turn) */
  context: string | null;
}

/** WAL-first POST /v1/events with presence from the fold; inbox items in the response become context (§4.5 step 3). */
export async function postEvents(
  rt: HookRuntime,
  ctx: SessionContext,
  events: RelayEvent[],
  opts: { role?: 'sync' | 'worker'; delivered?: string[]; budgetMs?: number; fold?: JournalFold } = {},
): Promise<PostEventsResult> {
  if (!hubConfigured(rt)) {
    rt.log(`hub not configured; ${events.length} event(s) dropped`);
    return { ok: false, context: null };
  }
  const fold = opts.fold ?? loadFold(ctx.dir);
  const body: EventsRequest = { session: buildPresence(rt, ctx, fold), events, ...(opts.delivered?.length ? { delivered: opts.delivered } : {}) };
  const client = hubClient(rt, ctx, opts.role ?? 'worker');
  const budgetMs = opts.budgetMs ?? Math.min(3000, Math.max(500, rt.remainingMs() - 100));
  const { result } = await postWithWal<EventsResponse>(client, rt.home, { sessionId: ctx.sessionId, kind: 'events', endpoint: '/v1/events', body, now: rt.now() }, { budgetMs, signal: rt.signal });
  rt.log(`POST /v1/events (${events.map((e) => e.type).join(',') || 'presence'}) ${result.ok ? 'ok' : result.kind} in ${result.ms} ms`);
  if (!result.ok) return { ok: false, context: null };
  const data = result.data;
  const inbox = data && typeof data === 'object' && Array.isArray((data as EventsResponse).inbox) ? (data as EventsResponse).inbox : [];
  const delivery = collectInbox(rt, ctx, { inbox, changeSets: [] }, { changeSets: 'none' });
  return { ok: true, context: inboxBlock(rt, delivery) };
}

/** PostToolUse output for an inbox block (null when nothing arrived). */
export function postToolUseOutput(context: string | null): HookOutput | null {
  return context ? output({ hookEventName: 'PostToolUse', additionalContext: context }) : null;
}

/** Short display name for logs. */
export function shortPath(path: string): string {
  return basename(path);
}
