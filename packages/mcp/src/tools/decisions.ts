/**
 * `decisions {topic?, area?, since?}` (§9.2): decision records — explicit
 * (`decide`), handoff-extracted, auto — with author, date and source. The
 * snapshot carries no decisions, so the offline fallback is the "Decisions"
 * section of the cached SessionStart digest (§9.3), clearly labelled.
 */
import { humanAge, shortTime, type DecisionsResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { hubFailureLine, plural, toolResult } from '../format.js';
import { digestSection, hubGet } from '../hub.js';
import { decisionLine } from '../render.js';
import { READ, defineTool } from './define.js';

export const decisionsTool = defineTool({
  name: 'decisions',
  description:
    'Architectural decision records for this project: explicit ones recorded with decide(), ones extracted from handoffs, and low-confidence auto-detected ones — each with author, time, source and superseded links. topic is a full-text filter on topic and text; area and since (ISO or "7d") narrow further. Offline, only the Decisions section of the cached session digest is available.',
  schema: {
    topic: z.string().max(200).optional().describe('full-text filter on topic/text'),
    area: z.string().max(200).optional(),
    since: z.string().max(40).optional().describe('ISO time or "7d"'),
  },
  annotations: READ,
  handler: async (ctx: CallContext, args) => {
    const result = await hubGet<DecisionsResponse>(ctx, '/v1/query/decisions', { topic: args.topic, area: args.area, since: args.since });
    if (result?.ok) {
      const r = result.data;
      const lines = [`Relay decisions at ${shortTime(r.at)} (live): ${plural(r.items.length, 'record')}${args.topic ? ` matching "${args.topic}"` : ''}${args.area ? ` in ${args.area}` : ''}`];
      for (const d of r.items.slice(0, 50)) lines.push(`- ${decisionLine(d)}`);
      return toolResult(lines.join('\n'), r);
    }
    const section = digestSection(ctx, 'Decisions');
    const note = hubFailureLine(result, ctx.snapshot, ctx.now);
    const filter = (l: string): boolean => !args.topic || l.toLowerCase().includes(args.topic.toLowerCase());
    const cachedLines = (section?.lines ?? []).filter(filter);
    const lines = section
      ? [`Relay decisions (cached digest, ${humanAge(section.ageMs)} old): ${plural(cachedLines.length, 'line')} from the last session digest`, ...cachedLines.map((l) => `- ${l}`)]
      : ['Relay decisions: unavailable offline (no cached digest holds a Decisions section).'];
    lines.push(note);
    const response: DecisionsResponse & { cachedDigestLines?: string[]; freshness: { source: 'cache'; at: string } } = {
      at: new Date(ctx.now).toISOString(),
      items: [],
      ...(section ? { cachedDigestLines: cachedLines } : {}),
      freshness: { source: 'cache', at: new Date(ctx.now - (section?.ageMs ?? 0)).toISOString() },
    };
    return toolResult(lines.join('\n'), response);
  },
});
