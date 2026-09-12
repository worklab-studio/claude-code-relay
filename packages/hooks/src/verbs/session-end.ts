/**
 * SessionEnd → verb `session-end` (§4.9): no git, no fetch inside the 1.5 s
 * budget. Journal `end` line, `ended` mark, WAL entry built from the fold,
 * detached `bg session-end <ulid>` worker (it POSTs with a 5 s budget and
 * deletes the entry on 2xx). Exit in ~70 ms; prints nothing.
 */
import {
  appendJournal,
  createMark,
  loadFold,
  nowIso,
  readDraft,
  writeOutbox,
  type ClaudeSessionEndReason,
  type HookOutput,
  type JournalFold,
  type SessionEndInput,
  type SessionEndRequest,
  type SessionEndReason,
} from '@relay/core';
import type { HookRuntime } from '../runtime.js';
import { areaFor, hubConfigured, prepareSession, type SessionContext } from '../session.js';

const REASONS: ReadonlySet<string> = new Set<ClaudeSessionEndReason>(['clear', 'resume', 'logout', 'prompt_input_exit', 'other']);

/** The /v1/session/end body from a session's fold (decision 7: file summaries + HandoffCommit[]). */
export function buildSessionEndBody(ctx: Pick<SessionContext, 'sessionId' | 'config' | 'dir'>, reason: SessionEndReason, fold: JournalFold, now: number): SessionEndRequest {
  return {
    sessionId: ctx.sessionId,
    reason,
    at: nowIso(now),
    files: Object.entries(fold.edits).map(([path, e]) => ({ path, area: areaFor(ctx, path), edits: e.count })),
    commits: fold.commits.map((c) => ({ sha: c.sha, subject: c.subject, pushed: c.pushed === true })),
    draft: readDraft(ctx.dir),
  };
}

export async function runSessionEnd(rt: HookRuntime, input: SessionEndInput): Promise<HookOutput | null> {
  const reason: ClaudeSessionEndReason = REASONS.has(input.reason) ? input.reason : 'other';
  const ctx = await prepareSession(rt, input);
  const now = rt.now();
  appendJournal(ctx.dir, { t: 'end', at: nowIso(now), reason });
  createMark(ctx.dir, 'ended');
  if (!hubConfigured(rt)) return null;
  const body = buildSessionEndBody(ctx, reason, loadFold(ctx.dir), now);
  const entry = writeOutbox(rt.home, { sessionId: ctx.sessionId, kind: 'session_end', endpoint: '/v1/session/end', body, now });
  if (entry) rt.spawnBg('session-end', ['--entry', entry.id, '--session', ctx.sessionId, '--cwd', ctx.cwd]);
  else rt.log('session-end WAL write failed');
  return null;
}
