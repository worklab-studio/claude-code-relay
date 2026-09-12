/**
 * `decide {text, topic?, area?, supersedes?}` (§9.2): records an explicit
 * architectural decision; it appears in teammates' SessionStart digests.
 */
import { redact, shortTime, type DecideResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { toolResult, writeFailure } from '../format.js';
import { hubPost } from '../hub.js';
import { WRITE, defineTool } from './define.js';

export const decideTool = defineTool({
  name: 'decide',
  description:
    'Record an architectural or product decision for this project. It is stored with your handle and time, appears in every teammate\'s next session digest and in decisions(); supersedes may name an earlier decision id. Secrets are redacted before sending. Fails honestly when the hub is unreachable.',
  schema: {
    text: z.string().min(1).max(500).describe('the decision, one or two sentences'),
    topic: z.string().max(200).optional(),
    area: z.string().max(200).optional().describe('an area name from .relay.json'),
    supersedes: z.string().max(100).optional().describe('id (dec_…) of the decision this replaces'),
  },
  annotations: WRITE,
  handler: async (ctx: CallContext, args) => {
    const body = {
      text: redact(args.text),
      ...(args.topic ? { topic: redact(args.topic) } : {}),
      ...(args.area ? { area: args.area } : {}),
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
    };
    const result = await hubPost<DecideResponse>(ctx, '/v1/decide', body);
    if (!result?.ok) return writeFailure('decide', result);
    const d = result.data.decision;
    return toolResult(`Relay decision ${d.id} recorded at ${shortTime(d.createdAt)} by ${d.dev} (project ${d.project}${d.topic ? `, topic ${d.topic}` : ''}${d.area ? `, area ${d.area}` : ''}): ${d.text}`, result.data);
  },
});
