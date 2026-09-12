/**
 * PreToolUse Read → verb `pre-read` (§4.4). guard-read.sh only spawns Node
 * when sessions/<sid>/pending is non-empty; here the file being read is
 * matched against the pending change sets' dependents, the note is printed
 * next to the file contents, `jit` marks are created and `pending` rewritten.
 */
import { LIMITS, derivePending, editToolPath, readPending, readSnapshot, toRepoRelative, type HookOutput, type PreToolUseInput } from '@relay/core';
import type { HookRuntime } from '../runtime.js';
import { output, prepareSession } from '../session.js';
import { jitCandidates, renderJitNotes } from './pre-edit.js';

export async function runPreRead(rt: HookRuntime, input: PreToolUseInput): Promise<HookOutput | null> {
  const filePath = editToolPath(input.tool_input);
  if (!filePath) return null;
  const ctx = await prepareSession(rt, input);
  if (!readPending(ctx.dir).length) return null;
  const rel = toRepoRelative(filePath, ctx.meta.repoRoot, ctx.cwd);
  if (!rel) return null;
  const snap = readSnapshot(rt.home, ctx.key);
  if (!snap) return null;
  const candidates = jitCandidates(snap, ctx.dir, rel, ctx.config.resolved.areas).filter((cs) => cs.dependents.some((d) => d.path === rel));
  if (!candidates.length) return null;
  const notes = renderJitNotes(rt, ctx, candidates, LIMITS.preToolUseContextChars - 4);
  derivePending(rt.home, ctx.sessionId, snap);
  if (!notes.length) return null;
  return output({ hookEventName: 'PreToolUse', additionalContext: notes.join('\n\n').slice(0, LIMITS.preToolUseContextChars) });
}
