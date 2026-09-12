/**
 * PostToolUse Edit|Write|MultiEdit|NotebookEdit → verb `post-edit` (§4.5,
 * async). Journal edit line, `asked` → `snooze` promotion for the landing
 * edit, contract detection on `git diff -U0 -w HEAD -- <path>` (retract when
 * the diff became empty), dependents grep (2 s), WAL + POST /v1/events; inbox
 * items from the response are delivered on the next turn.
 */
import {
  appendJournal,
  editToolPath,
  listMarks,
  makeEvent,
  nowIso,
  loadFold,
  promoteAskedToSnooze,
  readAskedMark,
  toRepoRelative,
  type EditEvent,
  type EditToolName,
  type HookOutput,
  type PostToolUseInput,
  type RelayEvent,
} from '@relay/core';
import { postEvents, postToolUseOutput, workingTreeContract } from '../reconcile.js';
import type { HookRuntime } from '../runtime.js';
import { areaFor, prepareSession } from '../session.js';

const EDIT_TOOLS: ReadonlySet<string> = new Set<EditToolName>(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export async function runPostEdit(rt: HookRuntime, input: PostToolUseInput): Promise<HookOutput | null> {
  const filePath = editToolPath(input.tool_input);
  if (!filePath) return null;
  const tool: EditToolName = EDIT_TOOLS.has(input.tool_name) ? (input.tool_name as EditToolName) : 'Edit';
  const ctx = await prepareSession(rt, input, { repair: true });
  const rel = toRepoRelative(filePath, ctx.meta.repoRoot, ctx.cwd);
  if (!rel) return null;
  const now = rt.now();
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : null;

  // 1. journal + the landing edit turns `asked` into a 30-min snooze (§4.5 step 1)
  appendJournal(ctx.dir, { t: 'edit', at: nowIso(now), path: rel, tool, toolUseId });
  for (const key of listMarks(ctx.dir, 'asked')) {
    const mark = readAskedMark(ctx.dir, key);
    if (mark?.path === rel) promoteAskedToSnooze(ctx.dir, key, now);
  }
  const fold = loadFold(ctx.dir);
  const events: RelayEvent[] = [makeEvent<EditEvent>({ type: 'edit', path: rel, tool, toolUseId, area: areaFor(ctx, rel) }, now)];

  // 2. contract detection (§4.5 step 2, §7.2)
  const diff = await rt.git.gitDiffU0(ctx.cwd, rel, { signal: rt.signal });
  const contract = await workingTreeContract(rt, ctx, rel, diff, fold, now);
  if (contract.event) events.push(contract.event);
  if (contract.retract) events.push(contract.retract);

  // 3. WAL + POST; the contract journal line lands once the body is durable; undelivered inbox items → next-turn context (§4.5 step 3)
  const posted = await postEvents(rt, ctx, events, { fold: loadFold(ctx.dir), journal: contract.journal });
  return postToolUseOutput(posted.context);
}
