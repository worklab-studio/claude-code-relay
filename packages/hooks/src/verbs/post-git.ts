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
  type JournalEntry,
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
  const journal: JournalEntry[] = [];
  const onDurable: Array<() => void> = [];
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
      const own = await rt.git.gitOwnCommits(ctx.cwd, { emails: meta.gitEmails, from }, { signal: rt.signal });
      if (own === null) {
        rt.log(`HEAD ${from?.slice(0, 7) ?? 'none'} -> ${head.slice(0, 7)}: git log cut off, scan position kept`);
      } else {
        const scan = await commitEvents(rt, ctx, own.reverse(), fold, now);
        events.push(...scan.events);
        journal.push(...scan.journal);
        // the scan position moves only with a durable body (§4.0 rule 6): to HEAD when every commit was
        // processed, else to the last one that was; with nothing to send it moves right away
        const next = scan.complete ? head : scan.lastSha;
        if (scan.events.length === 0) {
          if (next) recordReportedSha(rt, ctx, meta.branch, next);
        } else if (next) {
          const sha = next;
          onDurable.push(() => void recordReportedSha(rt, ctx, meta.branch, sha));
        }
        rt.log(`HEAD ${from?.slice(0, 7) ?? 'none'} -> ${head.slice(0, 7)}: ${own.length} own commit(s), ${scan.events.length} new${scan.complete ? '' : ' (cut off)'}`);
      }
    }
  }

  if (/\bgit\s+(?:[^\n;&|]*\s)?push\b/.test(command) && (await rt.git.gitHeadOnRemote(ctx.cwd, { signal: rt.signal }))) {
    const b = branch ?? meta.branch;
    events.push(makeEvent<PushEvent>({ type: 'push', branch: b, sha: head }, now));
    for (const c of loadFold(ctx.dir).commits.filter((c) => !c.pushed).slice(-50)) appendJournal(ctx.dir, { ...c, at: nowIso(now), pushed: true });
    for (const line of journal) if (line.t === 'commit') line.pushed = true; // the commits scanned just now are on the remote too
  }

  if (!events.length) return null;
  const posted = await postEvents(rt, ctx, events, {
    fold: loadFold(ctx.dir),
    journal,
    onDurable: () => {
      for (const fn of onDurable) fn();
    },
  });
  return postToolUseOutput(posted.context);
}
