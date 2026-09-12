/**
 * `recent_changes {area?, since?, kind?}` (§9.2): chronological teammate
 * changes — contract impacts with symbols and hunks, commits, edits, handoff
 * one-liners. Never transcripts. Cache fallback derives contract items from
 * the snapshot's change sets and commit/edit items from its heat (§9.1).
 */
import { areaOfPath, parseIso, readBreaker, shortTime, type RecentChangeItem, type RecentChangesResponse } from '@relay/core';
import { z } from 'zod';
import { areasOf, type CallContext } from '../context.js';
import { cacheFreshness, cachedLabel, hubFailureLine, plural, toolResult } from '../format.js';
import { hubGet } from '../hub.js';
import { recentChangeLine } from '../render.js';
import { READ, defineTool } from './define.js';

const TEXT_CAP = 40;

/** `since`: ISO time, or `<n>d` / `<n>h` / `<n>m`; default 7 days (the hub knows my last session, the cache does not). */
export function parseSince(since: string | undefined, now: number, defaultMs = 7 * 86_400_000): number {
  if (!since) return now - defaultMs;
  const rel = /^(\d+)\s*([dhm])$/i.exec(since.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? 'd').toLowerCase();
    const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    return now - n * ms;
  }
  const t = parseIso(since);
  return t ?? now - defaultMs;
}

function render(r: RecentChangesResponse, label: string): string {
  const lines = [`Relay recent_changes since ${shortTime(r.since)} at ${shortTime(r.at)} ${label}: ${plural(r.items.length, 'item')}`];
  for (const item of r.items.slice(0, TEXT_CAP)) lines.push(`- ${recentChangeLine(item)}`);
  if (r.items.length > TEXT_CAP) lines.push(`- (+${r.items.length - TEXT_CAP} more in json)`);
  return lines.join('\n');
}

export const recentChangesTool = defineTool({
  name: 'recent_changes',
  description:
    'Chronological teammate changes in this project: contract-file changes with symbols, summaries and diff hunks (json), commits with SHAs and files, edit heat, and handoff one-liners. Filter by area, by since (ISO time or "1d"/"7d") and by kind ("contracts", "commits", "edits", "all"). Default = my areas and the contracts I depend on since my last session. Never returns transcripts. Cache-served (change sets + heat only) when the hub is unreachable.',
  schema: {
    area: z.string().max(200).optional().describe('an area name from .relay.json'),
    since: z.string().max(40).optional().describe('ISO time or a relative window such as "1d", "12h", "7d"'),
    kind: z.enum(['contracts', 'commits', 'edits', 'all']).optional().describe('default "all"'),
  },
  annotations: READ,
  handler: async (ctx: CallContext, args) => {
    const kind = args.kind ?? 'all';
    const result = await hubGet<RecentChangesResponse>(ctx, '/v1/query/recent_changes', { area: args.area, since: args.since, kind });
    if (result?.ok) return toolResult(render(result.data, '(live)'), result.data);

    const snap = ctx.snapshot;
    const areas = areasOf(ctx);
    const sinceMs = parseSince(args.since, ctx.now);
    const items: RecentChangeItem[] = [];
    if (snap && (kind === 'contracts' || kind === 'all')) {
      for (const cs of snap.changeSets) {
        for (const i of cs.impacts) {
          const at = parseIso(cs.at) ?? 0;
          if (at < sinceMs) continue;
          if (args.area && areaOfPath(i.path, areas) !== args.area && !cs.dependents.some((d) => d.area === args.area)) continue;
          items.push({ kind: 'contract', at: cs.at, dev: cs.by, repo: cs.repo ?? snap.repo.slug, branch: cs.branch, changeSetId: cs.id, impactId: i.id, rev: i.rev, path: i.path, symbols: i.symbols, summary: i.summary, hunk: i.hunk, status: i.status, priority: cs.priority, commitSha: i.commitSha });
        }
      }
    }
    if (snap && kind !== 'contracts') {
      const byCommit = new Map<string, Extract<RecentChangeItem, { kind: 'commit' }>>();
      for (const h of snap.heat) {
        if (h.mine || h.dev === ctx.dev) continue;
        if ((parseIso(h.at) ?? 0) < sinceMs) continue;
        if (args.area && areaOfPath(h.path, areas) !== args.area) continue;
        if (h.kind === 'commit' && (kind === 'commits' || kind === 'all')) {
          const sha = h.headSha ?? 'unknown';
          const e = byCommit.get(sha) ?? { kind: 'commit', at: h.at, dev: h.dev, repo: snap.repo.slug, branch: h.branch, sha, subject: '', pushed: h.pushed, files: [] };
          e.files.push(h.path);
          byCommit.set(sha, e);
        } else if (h.kind === 'edit' && (kind === 'edits' || kind === 'all')) {
          items.push({ kind: 'edit', at: h.at, dev: h.dev, repo: snap.repo.slug, branch: h.branch, path: h.path, count: h.count ?? 1 });
        }
      }
      items.push(...byCommit.values());
    }
    items.sort((a, b) => a.at.localeCompare(b.at));
    const breaker = readBreaker(ctx.home, ctx.now);
    const response: RecentChangesResponse = {
      at: snap?.serverTime ?? new Date(ctx.now).toISOString(),
      since: new Date(sinceMs).toISOString(),
      items,
      freshness: cacheFreshness(snap, breaker.open, ctx.now),
    };
    const note = hubFailureLine(result, snap, ctx.now);
    const text = snap
      ? `${render(response, cachedLabel(snap))}\n${note}\nThe cache holds change sets targeting you and 24 h heat; handoff lines and older history need the hub.`
      : `Relay recent_changes: no cached snapshot and the hub is unavailable.\n${note}`;
    return toolResult(text, response);
  },
});
