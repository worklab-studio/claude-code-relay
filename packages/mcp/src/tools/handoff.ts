/**
 * `handoff {summary?}` (§8.1 trigger, §9.2): generate this session's handoff
 * now; with `summary` the record is stored as quality "self" (never
 * overwritten by later automatic tiers). Strings pass redact() (§11.1).
 */
import { redactDeep, shortTime, type HandoffResponse, type HandoffSelfSummary } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { toolResult, writeFailure } from '../format.js';
import { hubPost } from '../hub.js';
import { handoffLine } from '../render.js';
import { WRITE, defineTool } from './define.js';

const summarySchema = z
  .object({
    objective: z.string().max(140).optional(),
    done: z.array(z.string().max(300)).max(20).optional(),
    changed: z.array(z.union([z.string().max(500), z.object({ path: z.string(), area: z.string().nullable().optional(), edits: z.number().int().optional(), why: z.string().nullable().optional() })])).max(200).optional(),
    interfaces_changed: z.array(z.union([z.string().max(500), z.object({ path: z.string(), symbols: z.array(z.string()).optional(), summary: z.string().optional() })])).max(50).optional(),
    decisions: z.array(z.string().max(300)).max(20).optional(),
    blockers: z.array(z.string().max(300)).max(20).optional(),
    next: z.array(z.string().max(300)).max(20).optional(),
    notes_to: z.array(z.object({ dev: z.string().max(64), intent: z.enum(['action', 'feedback', 'fyi']), text: z.string().max(300) })).max(20).optional(),
  })
  .describe('your own summary of the session; stored as quality "self"');

export const handoffTool = defineTool({
  name: 'handoff',
  description:
    'Generate the handoff for the current session now (the hub also does this automatically at session end and after idle periods). With summary {done[], changed[], interfaces_changed[], decisions[], blockers[], next[], notes_to[{dev,intent,text}], objective} your text is stored as the authoritative "self" tier; notes_to reach the named teammates. Returns the record id, revision and the rendered markdown. Secrets are redacted. Fails honestly when the hub is unreachable or the session is unknown.',
  schema: { summary: summarySchema.optional() },
  annotations: WRITE,
  handler: async (ctx: CallContext, args) => {
    if (!ctx.session.sessionId) {
      return toolResult('Relay handoff not generated: no live session was found (no current/<pid>.json for this Claude process and no CLAUDE_CODE_SESSION_ID).', { error: 'no_session' }, { isError: true });
    }
    const summary = args.summary ? (redactDeep(args.summary) as HandoffSelfSummary) : undefined;
    const result = await hubPost<HandoffResponse>(ctx, '/v1/handoff', { sessionId: ctx.session.sessionId, ...(summary ? { summary } : {}) });
    if (!result?.ok) return writeFailure('handoff', result);
    const h = result.data.handoff;
    const text = [`Relay handoff ${h.id} rev ${h.rev} (${h.quality}) generated at ${shortTime(h.generatedAt)} for session ${h.sessionId.slice(0, 8)}: ${handoffLine(h)}`, '', h.markdown.trim()].join('\n');
    return toolResult(text, result.data);
  },
});
