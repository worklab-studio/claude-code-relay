/**
 * Stop → verb `stop` (§4.8, async, DEADLINE 5 s). Journal the turn's prose,
 * reconcile the tree author-filtered and merge-base-bounded (own commits made
 * outside Claude, dirty contract paths, retracts), write the heuristic draft,
 * WAL + POST `turn_end` with the contract/commit/retract events. Prints
 * nothing (a Stop `additionalContext` would soft-continue the turn).
 */
import {
  LIMITS,
  appendJournal,
  loadFold,
  makeEvent,
  nowIso,
  openContracts,
  prose,
  redact,
  updateMetaBranch,
  writeDraft,
  type BranchEvent,
  type HookOutput,
  type RelayEvent,
  type StopInput,
  type TurnEndEvent,
} from '@relay/core';
import { buildHandoffDraft, isTrivialSession } from '../handoff-draft.js';
import { commitEvents, contractCandidatePaths, postEvents, workingTreeContract } from '../reconcile.js';
import type { HookRuntime } from '../runtime.js';
import { prepareSession } from '../session.js';
import { recordReportedSha } from './post-git.js';

const DIRTY_CONTRACT_CAP = 12;

export async function runStop(rt: HookRuntime, input: StopInput): Promise<HookOutput | null> {
  const ctx = await prepareSession(rt, input, { repair: true });
  const now = rt.now();
  const privacy = ctx.config.resolved.privacy;
  const promptId = typeof input.prompt_id === 'string' ? input.prompt_id : null;
  const raw = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';

  // 1. turn line: prose ≤ 3,000 chars, redacted (§4.8 step 1, §11.1)
  const text = privacy.send_turns === false ? null : redact(privacy.send_turns === 'full' ? raw.slice(0, LIMITS.turnTextChars) : prose(raw));
  appendJournal(ctx.dir, { t: 'turn', at: nowIso(now), promptId, text: text ?? '' });
  const events: RelayEvent[] = [];
  const meta = ctx.meta;

  // 2. reconciliation (§4.8 step 2): branch first, then own commits since lastStopSha ?? merge-base, then dirty contract paths
  const [branch, head] = await Promise.all([rt.git.gitBranch(ctx.cwd, { signal: rt.signal }), rt.git.gitHead(ctx.cwd, { signal: rt.signal })]);
  const outside = new Set<string>();
  if (head) {
    if (branch && branch !== meta.branch) {
      const startSha = (meta.startSha ? await rt.git.gitMergeBase(ctx.cwd, meta.startSha, 'HEAD', { signal: rt.signal }) : null) ?? head;
      const updated = await updateMetaBranch(ctx.dir, { branch, startSha, lastStopSha: null });
      if (updated) ctx.meta = updated;
      appendJournal(ctx.dir, { t: 'branch', at: nowIso(now), branch, worktree: meta.worktree, startSha });
      events.push(makeEvent<BranchEvent>({ type: 'branch', branch, worktree: meta.worktree, startSha }, now));
    }
    const cur = ctx.meta;
    const base = cur.startSha ? await rt.git.gitMergeBase(ctx.cwd, cur.startSha, 'HEAD', { signal: rt.signal }) : null;
    const from = cur.lastStopSha ?? base;
    const fold0 = loadFold(ctx.dir);
    if (from !== head) {
      const own = (await rt.git.gitOwnCommits(ctx.cwd, { emails: cur.gitEmails, from }, { signal: rt.signal })) ?? [];
      for (const c of own) for (const f of (await rt.git.gitCommitFiles(ctx.cwd, c.sha, { signal: rt.signal })) ?? []) outside.add(f);
      events.push(...(await commitEvents(rt, ctx, own.reverse(), fold0, now)));
      if (own.length && !rt.signal.aborted) recordReportedSha(rt, ctx, cur.branch, head);
    }
    const dirty = (await rt.git.gitDirtyPaths(ctx.cwd, { signal: rt.signal })) ?? [];
    for (const p of dirty) outside.add(p);
    // contract records for dirty contract paths this session touched or that changed outside Claude
    const fold1 = loadFold(ctx.dir);
    const touched = new Set([...dirty, ...Object.keys(openContracts(fold1))]);
    for (const rel of contractCandidatePaths(ctx, [...touched], DIRTY_CONTRACT_CAP)) {
      if (rt.signal.aborted || rt.remainingMs() < 1200) break;
      const diff = await rt.git.gitDiffU0(ctx.cwd, rel, { signal: rt.signal });
      const r = await workingTreeContract(rt, ctx, rel, diff, loadFold(ctx.dir), now);
      if (r.event) events.push(r.event);
      if (r.retract) events.push(r.retract);
    }
    await updateMetaBranch(ctx.dir, { lastStopSha: head, lastStopAt: nowIso(now) });
  }
  for (const p of Object.keys(loadFold(ctx.dir).edits)) outside.delete(p);

  // 3. heuristic draft (§8.2 tier 1), skipped for trivial sessions (§8.1)
  const fold = loadFold(ctx.dir);
  const draft = isTrivialSession(fold)
    ? null
    : buildHandoffDraft({
        fold,
        areas: ctx.config.resolved.areas,
        branch: ctx.meta.branch,
        repoSlug: ctx.meta.repo,
        objectiveFromPrompts: privacy.objective_from_prompts,
        outsideFiles: [...outside].slice(0, 100),
        now,
      });
  if (draft) writeDraft(ctx.dir, draft);

  // 4. WAL + POST (§4.8 step 4)
  events.push(makeEvent<TurnEndEvent>({ type: 'turn_end', promptId, text, draft }, now));
  await postEvents(rt, ctx, events, { fold });
  return null; // §4.8 step 5
}
