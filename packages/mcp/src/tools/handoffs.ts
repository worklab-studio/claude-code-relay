/**
 * `handoffs {dev?, n?, repo?, full?}` (§9.2): latest structured handoffs as
 * markdown (`full` keeps per-file lists). Offline fallback: the "Handoffs"
 * section of the cached SessionStart digest (§9.3), labelled as such.
 */
import { humanAge, shortTime, type HandoffsResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { hubFailureLine, plural, toolResult } from '../format.js';
import { digestSection, hubGet } from '../hub.js';
import { handoffLine } from '../render.js';
import { READ, defineTool } from './define.js';

const MARKDOWN_CAP = 4000;

export const handoffsTool = defineTool({
  name: 'handoffs',
  description:
    'Latest session handoffs of the project as structured markdown: objective, done, changed files (by area), interfaces changed, decisions, blockers, next steps, commits and notes addressed to teammates. dev="me" or a handle filters by author; n (default 3) limits; repo restricts to one repo slug; full=true keeps complete per-file lists. Offline, only the Handoffs section of the cached session digest is available.',
  schema: {
    dev: z.string().max(100).optional().describe('"me" or a teammate handle; default everyone'),
    n: z.number().int().min(1).max(20).optional().describe('how many, default 3'),
    repo: z.string().max(200).optional().describe('repo slug to restrict to; default the whole project'),
    full: z.boolean().optional().describe('true = full per-file lists'),
  },
  annotations: READ,
  handler: async (ctx: CallContext, args) => {
    const result = await hubGet<HandoffsResponse>(ctx, '/v1/query/handoffs', {
      dev: args.dev,
      n: args.n !== undefined ? String(args.n) : undefined,
      full: args.full ? 'true' : undefined,
      ...(args.repo ? { repo: args.repo } : {}),
    });
    if (result?.ok) {
      const r = result.data;
      const lines = [`Relay handoffs at ${shortTime(r.at)} (live): ${plural(r.items.length, 'handoff')}${args.dev ? ` by ${args.dev}` : ''}`];
      for (const h of r.items) {
        lines.push(`- ${handoffLine(h)}`);
        const md = h.markdown.trim();
        if (md) lines.push(md.length > MARKDOWN_CAP && !args.full ? md.slice(0, MARKDOWN_CAP) + '\n…' : md, '');
      }
      return toolResult(lines.join('\n'), r);
    }
    const section = digestSection(ctx, 'Handoffs');
    const note = hubFailureLine(result, ctx.snapshot, ctx.now);
    const filter = (l: string): boolean => !args.dev || args.dev === 'me' ? true : l.startsWith(`${args.dev} ·`);
    const cachedLines = (section?.lines ?? []).filter(filter);
    const lines = section
      ? [`Relay handoffs (cached digest, ${humanAge(section.ageMs)} old): ${plural(cachedLines.length, 'line')} from the last session digest`, ...cachedLines.map((l) => `- ${l}`)]
      : ['Relay handoffs: unavailable offline (no cached digest holds a Handoffs section).'];
    lines.push(note);
    const response: HandoffsResponse & { cachedDigestLines?: string[] } = {
      at: new Date(ctx.now).toISOString(),
      items: [],
      ...(section ? { cachedDigestLines: cachedLines } : {}),
      freshness: { source: 'cache', at: new Date(ctx.now - (section?.ageMs ?? 0)).toISOString(), ...(section ? { ageMs: section.ageMs } : {}) },
    };
    return toolResult(lines.join('\n'), response);
  },
});
