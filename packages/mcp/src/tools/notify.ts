/**
 * `notify {dev|"all", message, ref?, kind?}` (§9.2): a note delivered at the
 * teammate's next prompt (live) or next session start. Text passes redact()
 * before leaving the machine (§11.1). Write tool: honest error when the hub
 * is unreachable (§9.1).
 */
import { redact, type NotifyResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { toolResult, writeFailure } from '../format.js';
import { hubPost } from '../hub.js';
import { WRITE, defineTool } from './define.js';

export const notifyTool = defineTool({
  name: 'notify',
  description:
    'Send a short note to a teammate (or "all"). A developer with a live session sees it at their next prompt; otherwise at their next session start. ref may name a path or a change-set id; kind is "fyi" (default), "ask" or "blocker". Returns the notification ids and a delivery note with the teammate\'s last activity time. Secrets are redacted before sending. Fails honestly when the hub is unreachable.',
  schema: {
    dev: z.string().min(1).max(100).describe('teammate handle from team.json, or "all"'),
    message: z.string().min(1).max(500).describe('one line; it lands verbatim in the teammate\'s next prompt context'),
    ref: z.string().max(500).optional().describe('a repo-relative path or a change-set id (cs_…)'),
    kind: z.enum(['fyi', 'ask', 'blocker']).optional(),
  },
  annotations: WRITE,
  handler: async (ctx: CallContext, args) => {
    const body = { dev: args.dev.replace(/^@/, ''), message: redact(args.message), ...(args.ref ? { ref: args.ref } : {}), ...(args.kind ? { kind: args.kind } : {}) };
    const result = await hubPost<NotifyResponse>(ctx, '/v1/notify', body);
    if (!result?.ok) return writeFailure('notify', result);
    const r = result.data;
    return toolResult(`Relay notify ${r.ids.join(', ')} to ${body.dev} (${args.kind ?? 'fyi'}): ${r.note}`, r);
  },
});
