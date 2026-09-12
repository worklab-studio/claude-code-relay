/**
 * TaskCreated / TaskCompleted → verbs `task-created` / `task-completed` (§4.7).
 * Journal line only (the open task subject becomes the objective, §5.1); the
 * `task` event rides in a WAL entry that the next worker drains. Never any
 * stdout, never a non-zero exit (exit 2 would roll the task back).
 */
import { makeEvent, nowIso, appendJournal, redact, writeOutbox, type HookOutput, type TaskEvent, type TaskHookInput } from '@relay/core';
import type { HookRuntime } from '../runtime.js';
import { buildPresence, hubConfigured, prepareSession } from '../session.js';

export async function runTask(rt: HookRuntime, input: TaskHookInput): Promise<HookOutput | null> {
  const id = typeof input.task_id === 'string' ? input.task_id : typeof input.task_id === 'number' ? String(input.task_id) : null;
  // §11.1: the task subject becomes the presence objective and lands in teammates' digests — redact at the source
  const subject = typeof input.task_subject === 'string' ? redact(input.task_subject).trim().slice(0, 300) : '';
  if (!id || !subject) return null; // unknown shape → exit 0 silently
  const status = input.hook_event_name === 'TaskCompleted' ? 'completed' : 'created';
  const ctx = await prepareSession(rt, input);
  const now = rt.now();
  appendJournal(ctx.dir, { t: 'task', at: nowIso(now), id, subject, status });
  if (!hubConfigured(rt)) return null;
  const event = makeEvent<TaskEvent>({ type: 'task', taskId: id, subject, status }, now);
  // No immediate network (§4.7): the entry is drained by the next worker (≥ 30 s), presence already carries the objective.
  writeOutbox(rt.home, {
    sessionId: ctx.sessionId,
    kind: 'events',
    endpoint: '/v1/events',
    body: { session: buildPresence(rt, ctx), events: [event] },
    ephemeral: false,
    now,
  });
  return null;
}
