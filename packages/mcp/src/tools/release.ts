/**
 * `release {target?}` (§9.2): release this developer's claims in this repo —
 * one target, or all of them.
 */
import type { ReleaseResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { plural, toolResult, writeFailure } from '../format.js';
import { hubPost } from '../hub.js';
import { WRITE, defineTool } from './define.js';

export const releaseTool = defineTool({
  name: 'release',
  description: 'Release your explicit claims in this repo: one target (exactly as claimed) or "all" (default). Returns the released claim ids. Fails honestly when the hub is unreachable.',
  schema: { target: z.string().max(500).optional().describe('the claimed target, or "all" (default)') },
  annotations: WRITE,
  handler: async (ctx: CallContext, args) => {
    const target = args.target?.trim() ? args.target.trim().replace(/^\.\//, '') : 'all';
    const result = await hubPost<ReleaseResponse>(ctx, '/v1/release', { target });
    if (!result?.ok) return writeFailure('release', result);
    const r = result.data;
    const text = r.released.length ? `Relay released ${plural(r.released.length, 'claim')} (${target}): ${r.released.join(', ')}` : `Relay release: no active claim of ${ctx.dev} matched ${target} in ${ctx.repo ?? 'this repo'}`;
    return toolResult(text, r);
  },
});
