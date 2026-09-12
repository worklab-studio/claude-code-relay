/**
 * `impacts {mine?, ack?}` (§9.2): contract change sets affecting me with
 * per-file symbols, dependents and status; `ack` marks one handled through
 * POST /v1/ack (stops JIT reminders, notifies the author). Cache fallback
 * lists the snapshot's change sets with ancestry-derived "already in your
 * branch" flags (§4.12).
 */
import { readAncestry, readBreaker, shortTime, type AckResponse, type ChangeSetView, type ImpactsResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { cacheFreshness, cachedLabel, hubFailureLine, plural, toolResult, writeFailure } from '../format.js';
import { hubGet, hubPost } from '../hub.js';
import { changeSetLine } from '../render.js';
import { READ, defineTool } from './define.js';

function render(r: ImpactsResponse, ctx: CallContext, label: string, merged: Record<string, boolean>): string {
  const lines = [`Relay impacts at ${shortTime(r.at)} ${label}: ${plural(r.changeSets.length, 'change set')}`];
  for (const cs of r.changeSets.slice(0, 20)) {
    lines.push(`- ${changeSetLine(cs, { merged: merged[cs.id] ?? false, meDev: ctx.dev })}`);
    for (const i of cs.impacts) if (i.summary && cs.impacts.length > 1) lines.push(`    ${i.path}: ${i.summary}`);
  }
  if (r.changeSets.length > 20) lines.push(`- (+${r.changeSets.length - 20} more in json)`);
  return lines.join('\n');
}

export const impactsTool = defineTool({
  name: 'impacts',
  description:
    'Contract change sets that affect you (or, mine=false, every open change set in the project): per file the changed symbols, a factual summary, the diff hunk (json), status (uncommitted/committed/pushed/merged/withdrawn), priority, your dependent files and who acknowledged it. ack="<cs_… or imp_… id>" marks one as handled: reminders stop and the author is notified. Cache-served (with "already in your branch" from local ancestry) when the hub is unreachable; ack then fails honestly.',
  schema: {
    mine: z.boolean().optional().describe('true (default) = change sets routed to me; false = every open change set in the project'),
    ack: z.string().max(100).optional().describe('change-set (cs_…) or impact (imp_…) id to mark handled'),
  },
  annotations: { ...READ, readOnlyHint: false, idempotentHint: false },
  handler: async (ctx: CallContext, args) => {
    const mine = args.mine ?? true;
    let ackText = '';
    let ack: AckResponse | null = null;
    if (args.ack) {
      const ackResult = await hubPost<AckResponse>(ctx, '/v1/ack', { id: args.ack.trim() });
      if (!ackResult?.ok) {
        const failure = writeFailure('ack', ackResult);
        ackText = failure.content[0] && failure.content[0].type === 'text' ? failure.content[0].text.split('\n')[0] ?? '' : '';
      } else {
        ack = ackResult.data;
        ackText = `Relay ack ${ack.changeSetId} at ${shortTime(ack.ackedAt)}${ack.notifiedAuthor ? ' (author notified)' : ''}.`;
      }
    }
    const result = await hubGet<ImpactsResponse>(ctx, '/v1/query/impacts', { mine: mine ? 'true' : 'false' });
    const merged = (ctx.repoKey && readAncestry(ctx.home, ctx.repoKey)?.merged) || {};
    if (result?.ok) {
      const text = [ackText, render(result.data, ctx, '(live)', merged)].filter(Boolean).join('\n');
      return toolResult(text, { ...result.data, ...(ack ? { ack } : {}) });
    }
    const snap = ctx.snapshot;
    const breaker = readBreaker(ctx.home, ctx.now);
    const changeSets: ChangeSetView[] = (snap?.changeSets ?? []).map((cs) => ({ ...cs, sessionId: '', firstAt: cs.at, stableSince: null, acked: {}, targets: [] }));
    const response: ImpactsResponse = { at: snap?.serverTime ?? new Date(ctx.now).toISOString(), changeSets, freshness: cacheFreshness(snap, breaker.open, ctx.now) };
    const note = hubFailureLine(result, snap, ctx.now);
    const body = snap ? `${render(response, ctx, cachedLabel(snap), merged)}\n${note}${mine ? '' : '\nThe cache holds only the change sets routed to you.'}` : `Relay impacts: no cached snapshot and the hub is unavailable.\n${note}`;
    return toolResult([ackText, body].filter(Boolean).join('\n'), response, { isError: Boolean(args.ack) && !ack });
  },
});
