/**
 * UserPromptSubmit → verb `prompt` (§4.2). Synchronous, cache-first, no git:
 * journal line + objective rule, a throttled `GET /v1/snapshot` (800 ms; 1,500
 * ms after a > 5 min pause; a timeout never opens the breaker), inbox items
 * and high-priority change sets delivered once per session via `wx` marks,
 * then a WAL entry for the prompt event and a detached `bg prompt` worker
 * that adds the dirty paths and POSTs it.
 */
import {
  BREAKER,
  BUDGET_MS,
  LIMITS,
  appendJournal,
  breakerOpen,
  candidateFromPrompt,
  loadFold,
  makeEvent,
  nextPromptObjective,
  nowIso,
  readSnapshot,
  redact,
  sha1,
  snapshotAgeMs,
  writeOutbox,
  type HookOutput,
  type PromptEvent,
  type Snapshot,
  type UserPromptSubmitInput,
} from '@relay/core';
import type { HookRuntime } from '../runtime.js';
import { buildPresence, collectInbox, hubClient, hubConfigured, inboxBlock, output, prepareSession } from '../session.js';

const JOURNAL_PROMPT_CHARS = 300;

/** `Relay: 1 impact, 1 note (in Claude's context)` for the user (experiment B.11: systemMessage is routed to the user channel). */
export function systemMessageFor(lines: readonly string[]): string | null {
  if (!lines.length) return null;
  const impacts = lines.filter((l) => l.startsWith('IMPACT')).length;
  const notes = lines.length - impacts;
  const parts: string[] = [];
  if (impacts) parts.push(`${impacts} impact${impacts === 1 ? '' : 's'}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  return `Relay: ${parts.join(', ')} (in Claude's context)`;
}

export async function runPrompt(rt: HookRuntime, input: UserPromptSubmitInput): Promise<HookOutput | null> {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const ctx = await prepareSession(rt, input);
  const now = rt.now();
  const privacy = ctx.config.resolved.privacy;
  const fold = loadFold(ctx.dir);

  // 1. journal (text only with privacy.send_prompts) + objective rule (§5.1)
  const promptId = typeof input.prompt_id === 'string' ? input.prompt_id : null;
  appendJournal(ctx.dir, {
    t: 'prompt',
    at: nowIso(now),
    promptId,
    len: prompt.length,
    sha1: sha1(prompt),
    ...(privacy.send_prompts ? { text: redact(prompt).slice(0, JOURNAL_PROMPT_CHARS) } : {}),
  });
  let objectiveChanged = false;
  if (privacy.objective_from_prompts) {
    const cand = candidateFromPrompt(prompt, { lastTurnWasQuestion: fold.lastTurnWasQuestion });
    const next = nextPromptObjective(fold.objective, cand, now);
    if (next) {
      appendJournal(ctx.dir, { t: 'objective', at: nowIso(now), objective: next, source: 'prompt' });
      objectiveChanged = true;
    }
  }
  const foldNow = objectiveChanged ? loadFold(ctx.dir) : fold;

  // 2. throttled refresh (sync role: a timeout keeps the cache and writes refresh-wanted, never opens the breaker)
  let snap = readSnapshot(rt.home, ctx.key);
  const age = snapshotAgeMs(snap, now);
  const ttl = rt.env.snapshotTtlMs ?? BREAKER.snapshotTtlMs;
  if ((age === null || age > ttl) && !breakerOpen(rt.home, now) && rt.team) {
    const budgetMs = Math.min(age === null || age > BREAKER.pauseMs ? BUDGET_MS.promptRefreshAfterPause : BUDGET_MS.promptRefresh, Math.max(100, rt.remainingMs() - 150));
    const client = hubClient(rt, ctx, 'sync');
    const r = await client.get<Snapshot>('/v1/snapshot', { repo: ctx.meta.repo }, { budgetMs, signal: rt.signal });
    rt.log(`snapshot refresh ${r.ok ? 'ok' : r.kind} in ${r.ms} ms`);
    if (r.ok) snap = readSnapshot(rt.home, ctx.key) ?? snap;
  }

  // 3. inbox + high-priority change sets, once per session (§4.2 step 3)
  const delivery = collectInbox(rt, ctx, snap, { changeSets: 'high' });
  const block = inboxBlock(rt, delivery, LIMITS.promptInboxChars);

  // 4. WAL entry for the prompt event; the worker adds `dirty` and POSTs it (§4.2 step 4)
  if (!hubConfigured(rt)) return block ? output({ hookEventName: 'UserPromptSubmit', additionalContext: block }) : null;
  const event = makeEvent<PromptEvent>(
    {
      type: 'prompt',
      promptId,
      objective: null,
      objectiveSource: null,
      dirty: [],
      branch: ctx.meta.branch,
      ...(privacy.send_prompts ? { text: redact(prompt).slice(0, LIMITS.promptWireChars) } : {}),
    },
    now,
  );
  const presence = buildPresence(rt, ctx, foldNow);
  event.objective = presence.objective;
  event.objectiveSource = presence.objectiveSource;
  const entry = writeOutbox(rt.home, {
    sessionId: ctx.sessionId,
    kind: 'events',
    endpoint: '/v1/events',
    body: { session: presence, events: [event], ...(delivery.delivered.length ? { delivered: delivery.delivered } : {}) },
    now,
  });
  rt.spawnBg('prompt', ['--session', ctx.sessionId, '--cwd', ctx.cwd, ...(entry ? ['--entry', entry.id] : [])]);

  if (!block) return null;
  const systemMessage = systemMessageFor(delivery.lines);
  return output({ hookEventName: 'UserPromptSubmit', additionalContext: block }, systemMessage ? { systemMessage } : {});
}
