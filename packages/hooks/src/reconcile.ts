/**
 * Contract detection and event posting shared by post-edit, post-git, stop and
 * the background worker (§4.5 step 2, §4.6, §4.8 step 2, §7.2, §7.3): working-
 * tree contract events with hunk hash, blob id and in-repo dependents; own-
 * commit events with per-file contract extraction; WAL-first POST /v1/events.
 *
 * Write-ahead ordering (§4.0 rule 6): the producers below return the journal
 * lines that record a contract/commit as reported, and `postEvents` appends
 * them only once the body is durable (in the WAL or accepted by the hub). A
 * body dropped by an open configuration breaker is therefore never journaled,
 * so the next scan re-detects it instead of losing it for good.
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
  type JournalEntry,
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
  /** journal lines to append once the event body is durable (`postEvents` journal option) */
  journal: JournalEntry[];
}

/**
 * Contract event (or retract) for one working-tree path (§4.5 step 2). `diff`
 * is the caller's `git diff -U0 -w HEAD -- <path>` result so post-edit and stop
 * share the budget accounting; `null` diff (git failed) yields nothing. Nothing
 * is journaled here: the returned `journal` lines go through `postEvents`.
 */
export async function workingTreeContract(
  rt: HookRuntime,
  ctx: SessionContext,
  rel: string,
  diff: string | null,
  fold: JournalFold,
  now: number = rt.now(),
): Promise<WorkingTreeContract> {
  const none: WorkingTreeContract = { event: null, retract: null, journal: [] };
  if (diff === null) return none;
  const open = openContracts(fold)[rel];
  if (diffIsEmpty(diff)) {
    // A working tree equal to HEAD is a revert only when no own commit carried the record (§4.8 step 2):
    // once the change is committed the record is closed by the commit, not withdrawn.
    if (!open || committedAfter(fold, rel, open.at)) return none;
    const retract = makeEvent<RetractEvent>({ type: 'retract', path: rel, impactId: null, hash: open.hash }, now);
    return { event: null, retract, journal: [{ ...open, at: nowIso(now), retracted: true, eventId: retract.id }] };
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
  return { event, retract: null, journal: [{ t: 'contract', at: nowIso(now), path: rel, hash: cand.hash, blobId, symbols: cand.symbols, kinds: cand.kinds, eventId: event.id }] };
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

export interface CommitScan {
  events: CommitEvent[];
  /** journal lines for the events above, appended by `postEvents` once the body is durable */
  journal: JournalEntry[];
  /** every commit passed in was either known or fully processed (no git call was cut off) */
  complete: boolean;
  /** newest commit (in input order) that is known or fully processed; the safe value for lastStopSha / lastReportedSha when incomplete */
  lastSha: string | null;
  /** files touched by the newly processed commits (for the handoff draft's outside-Claude list) */
  files: string[];
}

/**
 * Commit events for own-author commits not yet in the journal (§4.6, §7.2), oldest
 * first. A commit whose git calls were cut off by the deadline is not emitted (its
 * contracts would be empty) and the scan stops there so the caller keeps its scan
 * position at `lastSha`; the next Stop / post-git retries from it.
 */
export async function commitEvents(rt: HookRuntime, ctx: SessionContext, commits: readonly OwnCommit[], fold: JournalFold, now: number = rt.now()): Promise<CommitScan> {
  const known = new Set(fold.commits.map((c) => c.sha));
  const scan: CommitScan = { events: [], journal: [], complete: true, lastSha: null, files: [] };
  const seen = new Set<string>();
  for (const c of commits) {
    if (known.has(c.sha)) {
      scan.lastSha = c.sha;
      continue;
    }
    if (rt.signal.aborted) {
      scan.complete = false;
      break;
    }
    const files = await rt.git.gitCommitFiles(ctx.cwd, c.sha, { signal: rt.signal });
    if (files === null) {
      scan.complete = false;
      break;
    }
    const contracts = await commitContracts(rt, ctx, c.sha, files);
    const patchId = contracts.length ? await rt.git.gitPatchId(ctx.cwd, c.sha, { signal: rt.signal }) : null;
    if (rt.signal.aborted) {
      // the show / patch-id pass may have been cut mid-way: an empty contracts list would be journaled as final
      scan.complete = false;
      break;
    }
    const event = makeEvent<CommitEvent>(
      { type: 'commit', sha: c.sha, patchId, authorEmail: c.authorEmail, subject: redact(c.subject).slice(0, 200), files: files.slice(0, LIMITS.commitFilesOnWire), contracts, branch: ctx.meta.branch },
      now,
    );
    scan.journal.push({ t: 'commit', at: nowIso(now), sha: c.sha, subject: event.subject, files: files.slice(0, 50), contracts: contracts.map((x) => x.path) });
    scan.events.push(event);
    scan.lastSha = c.sha;
    for (const f of files) if (!seen.has(f)) {
      seen.add(f);
      scan.files.push(f);
    }
  }
  return scan;
}

export interface PostEventsResult {
  ok: boolean;
  /** the body is in the WAL or was accepted: the `journal` lines were appended and `onDurable` ran */
  durable: boolean;
  /** `<relay-inbox>` block for the hook's additionalContext (async hooks: next turn) */
  context: string | null;
}

export interface PostEventsOptions {
  role?: 'sync' | 'worker';
  delivered?: string[];
  budgetMs?: number;
  fold?: JournalFold;
  /** journal lines that record the events as reported; appended once the body is durable (§4.0 rule 6) */
  journal?: readonly JournalEntry[];
  /** runs right after the journal lines, in the same durable moment (e.g. advancing lastReportedSha) */
  onDurable?: () => void | Promise<void>;
}

/** WAL-first POST /v1/events with presence from the fold; inbox items in the response become context (§4.5 step 3). */
export async function postEvents(rt: HookRuntime, ctx: SessionContext, events: RelayEvent[], opts: PostEventsOptions = {}): Promise<PostEventsResult> {
  const durable = async (): Promise<void> => {
    for (const line of opts.journal ?? []) appendJournal(ctx.dir, line);
    await opts.onDurable?.();
  };
  if (!hubConfigured(rt)) {
    // nothing can ever be sent: keep the local records so drafts and dedup stay consistent
    await durable();
    rt.log(`hub not configured; ${events.length} event(s) dropped`);
    return { ok: false, durable: true, context: null };
  }
  const fold = opts.fold ?? loadFold(ctx.dir);
  const body: EventsRequest = { session: buildPresence(rt, ctx, fold), events, ...(opts.delivered?.length ? { delivered: opts.delivered } : {}) };
  const client = hubClient(rt, ctx, opts.role ?? 'worker');
  const budgetMs = opts.budgetMs ?? Math.min(3000, Math.max(500, rt.remainingMs() - 100));
  const posted = await postWithWal<EventsResponse>(client, rt.home, { sessionId: ctx.sessionId, kind: 'events', endpoint: '/v1/events', body, now: rt.now() }, { budgetMs, signal: rt.signal, onDurable: durable });
  const { result } = posted;
  rt.log(`POST /v1/events (${events.map((e) => e.type).join(',') || 'presence'}) ${result.ok ? 'ok' : result.kind} in ${result.ms} ms`);
  if (!result.ok) return { ok: false, durable: posted.durable, context: null };
  const data = result.data;
  const inbox = data && typeof data === 'object' && Array.isArray((data as EventsResponse).inbox) ? (data as EventsResponse).inbox : [];
  const delivery = collectInbox(rt, ctx, { inbox, changeSets: [] }, { changeSets: 'none' });
  return { ok: true, durable: true, context: inboxBlock(rt, delivery) };
}

/** PostToolUse output for an inbox block (null when nothing arrived). */
export function postToolUseOutput(context: string | null): HookOutput | null {
  return context ? output({ hookEventName: 'PostToolUse', additionalContext: context }) : null;
}

/** Short display name for logs. */
export function shortPath(path: string): string {
  return basename(path);
}
