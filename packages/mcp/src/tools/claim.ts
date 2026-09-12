/**
 * `claim {target, note?, ttl?, hard?, keep?}` (§6.3, §9.2): an explicit claim
 * scoped to (dev, repo); the hub reports conflicting claims, heat and live
 * sessions on the target. Relay informs, it does not lock.
 */
import { redact, shortTime, type ClaimResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { plural, toolResult, writeFailure } from '../format.js';
import { hubPost } from '../hub.js';
import { claimLine, heatLine, sessionLine } from '../render.js';
import { WRITE, defineTool } from './define.js';

export const claimTool = defineTool({
  name: 'claim',
  description:
    'Claim an area, path or glob for this developer in this repo (default 4 h, max 24 h). Teammates whose Claude edits under the target are asked first (hard=true: refused) until release, expiry, or the end of your last live session here (keep=true survives that). Returns the claim id plus conflicting claims, 24 h edit/commit heat and live sessions on the target — a claim informs, it does not lock. Fails honestly when the hub is unreachable.',
  schema: {
    target: z.string().min(1).max(500).describe('area name, repo-relative path, or glob'),
    note: z.string().max(1000).optional().describe('shown to teammates who hit the claim'),
    ttl: z.string().max(10).optional().describe('"4h" default, "24h" max; e.g. "90m", "2h"'),
    hard: z.boolean().optional().describe('true = teammates\' Claude edits are refused instead of asked'),
    keep: z.boolean().optional().describe('true = the claim survives the end of your sessions'),
  },
  annotations: WRITE,
  handler: async (ctx: CallContext, args) => {
    const body = {
      target: args.target.trim().replace(/^\.\//, ''),
      ...(args.note ? { note: redact(args.note) } : {}),
      ...(args.ttl ? { ttl: args.ttl } : {}),
      ...(args.hard !== undefined ? { hard: args.hard } : {}),
      ...(args.keep !== undefined ? { keep: args.keep } : {}),
    };
    const result = await hubPost<ClaimResponse>(ctx, '/v1/claim', body);
    if (!result?.ok) return writeFailure('claim', result);
    const r = result.data;
    const c = r.claim;
    const lines = [`Relay claim ${claimLine(c)} (created ${shortTime(c.createdAt)}, repo ${c.repo})`];
    const n = r.conflicts.claims.length + r.conflicts.heat.length + r.conflicts.sessions.length;
    if (n === 0) lines.push('- no conflicting claims, heat or live sessions on the target');
    for (const other of r.conflicts.claims) lines.push(`- conflicting claim ${claimLine(other)}`);
    for (const s of r.conflicts.sessions) lines.push(`- live on the target: ${sessionLine(s, ctx.dev)}`);
    for (const h of r.conflicts.heat.slice(0, 20)) lines.push(`- ${heatLine(h, ctx.dev)}`);
    if (r.conflicts.heat.length > 20) lines.push(`- (+${plural(r.conflicts.heat.length - 20, 'more heat entry')} in json)`);
    return toolResult(lines.join('\n'), r);
  },
});
