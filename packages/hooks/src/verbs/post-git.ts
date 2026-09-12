/**
 * PostToolUse Bash with `if: "Bash(git *)"` → verb `post-git` (§4.6, async).
 * Compares HEAD / branch with meta.json: a branch change resets `startSha` to
 * the merge-base and emits a `branch` event; HEAD moving on the same branch
 * emits own-author commit events (author-filtered log, never a raw range);
 * `git push` (or HEAD already on a remote) emits a `push` event.
 */
import {
  acquireBgLock,
  appendJournal,
  isRecord,
  loadFold,
  makeEvent,
  nowIso,
  readRepoState,
  updateMetaBranch,
  writeRepoState,
  type BranchEvent,
  type HookOutput,
  type PostToolUseInput,
  type PushEvent,
  type RelayEvent,
} from '@relay/core';
import { commitEvents, postEvents, postToolUseOutput } from '../reconcile.js';
import type { HookRuntime } from '../runtime.js';
import { prepareSession, type SessionContext } from '../session.js';

/** Record the last own commit reported on a branch (state.json is bg-lock guarded, §10.3). */
export function recordReportedSha(rt: HookRuntime, ctx: Pick<SessionContext, 'key'>, branch: string, sha: string, opts: { onlyIfUnknown?: boolean } = {}): boolean {
  const release = acquireBgLock(rt.home, 'state', ctx.key, { now: rt.now() });
  if (!release) return false;
  try {
    const state = readRepoState(rt.home, ctx.key);
    if (opts.onlyIfUnknown && state.lastReportedSha[branch]) return true;
    return writeRepoState(rt.home, ctx.key, { ...state, lastReportedSha: { ...state.lastReportedSha, [branch]: sha } });
  } finally {
    release();
  }
}

export async function runPostGit(rt: HookRuntime, input: PostToolUseInput): Promise<HookOutput | null> {
  const command = isRecord(input.tool_input) && typeof input.tool_input['command'] === 'string' ? input.tool_input['command'] : '';
  const ctx = await prepareSession(rt, input, { repair: true });
  const now = rt.now();
  const [branch, head] = await Promise.all([rt.git.gitBranch(ctx.cwd, { signal: rt.signal }), rt.git.gitHead(ctx.cwd, { signal: rt.signal })]);
  if (!head) return null; // no commits yet or git unavailable
  const events: RelayEvent[] = [];
  const fold = loadFold(ctx.dir);
  const meta = ctx.meta;

  if (branch && branch !== meta.branch) {
    // Branch changed: startSha := merge-base(old startSha, HEAD) || HEAD; a cross-branch diff is never taken (§4.6).
    const startSha = (meta.startSha ? await rt.git.gitMergeBase(ctx.cwd, meta.startSha, 'HEAD', { signal: rt.signal }) : null) ?? head;
    const updated = await updateMetaBranch(ctx.dir, { branch, startSha, lastStopSha: null });
    if (updated) ctx.meta = updated;
    appendJournal(ctx.dir, { t: 'branch', at: nowIso(now), branch, worktree: meta.worktree, startSha });
    events.push(makeEvent<BranchEvent>({ type: 'branch', branch, worktree: meta.worktree, startSha }, now));
    recordReportedSha(rt, ctx, branch, head, { onlyIfUnknown: true });
    rt.log(`branch ${meta.branch} -> ${branch}, startSha ${startSha.slice(0, 7)}`);
  } else {
    const state = readRepoState(rt.home, ctx.key);
    const from = state.lastReportedSha[meta.branch] ?? meta.lastStopSha ?? meta.startSha;
    if (from !== head) {
      const own = (await rt.git.gitOwnCommits(ctx.cwd, { emails: meta.gitEmails, from }, { signal: rt.signal })) ?? [];
      const commits = await commitEvents(rt, ctx, own.reverse(), fold, now);
      events.push(...commits);
      if (!rt.signal.aborted) recordReportedSha(rt, ctx, meta.branch, head);
      rt.log(`HEAD ${from?.slice(0, 7) ?? 'none'} -> ${head.slice(0, 7)}: ${own.length} own commit(s), ${commits.length} new`);
    }
  }

  if (/\bgit\s+(?:[^\n;&|]*\s)?push\b/.test(command) && (await rt.git.gitHeadOnRemote(ctx.cwd, { signal: rt.signal }))) {
    const b = branch ?? meta.branch;
    events.push(makeEvent<PushEvent>({ type: 'push', branch: b, sha: head }, now));
    for (const c of loadFold(ctx.dir).commits.filter((c) => !c.pushed).slice(-50)) appendJournal(ctx.dir, { ...c, at: nowIso(now), pushed: true });
  }

  if (!events.length) return null;
  const posted = await postEvents(rt, ctx, events, { fold: loadFold(ctx.dir) });
  return postToolUseOutput(posted.context);
}
