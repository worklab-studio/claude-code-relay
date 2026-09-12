/**
 * `who_is_on {target}` (§9.2): live sessions and recent editors (24 h) of an
 * area, path or glob, dirty files reported at the last prompt, and claims on
 * the target. Cache fallback filters the snapshot the same way (§9.1).
 */
import { areasOfPath, isGlobPattern, matchGlob, readBreaker, shortTime, type HeatEntry, type PresenceRecord, type WhoIsOnResponse } from '@relay/core';
import { z } from 'zod';
import { areasOf, type CallContext } from '../context.js';
import { cacheFreshness, cachedLabel, hubFailureLine, plural, toolResult } from '../format.js';
import { hubGet } from '../hub.js';
import { claimLine, heatLine, sessionLine } from '../render.js';
import { READ, defineTool } from './define.js';

function render(r: WhoIsOnResponse, meDev: string, label: string): string {
  const lines = [
    `Relay who_is_on ${r.target} (${r.targetKind}) at ${shortTime(r.at)} ${label}: ${plural(r.live.length, 'live session')}, ${plural(r.recentEditors.length, 'recent edit/commit entry')} (24 h), ${plural(r.dirty.length, 'uncommitted file')}, ${plural(r.claims.length, 'claim')}`,
  ];
  for (const s of r.live) lines.push(`- live: ${sessionLine(s, meDev)}`);
  for (const h of r.recentEditors.slice(0, 30)) lines.push(`- ${heatLine(h, meDev)}`);
  if (r.recentEditors.length > 30) lines.push(`- (+${r.recentEditors.length - 30} more entries in json)`);
  for (const h of r.dirty.slice(0, 20)) lines.push(`- ${heatLine(h, meDev)}`);
  for (const c of r.claims) lines.push(`- claim ${claimLine(c)}`);
  return lines.join('\n');
}

export const whoIsOnTool = defineTool({
  name: 'who_is_on',
  description:
    'Who is working on an area, a path or a glob right now and who touched it in the last 24 hours: live sessions (dev, state, branch, objective, recent files), edit/commit heat, files reported uncommitted at a developer\'s last prompt (human/IDE edits included), and explicit claims covering the target. Cache-served with a "cached HH:MMZ" label when the hub is unreachable.',
  schema: { target: z.string().min(1).max(500).describe('an area name from .relay.json, a repo-relative path, or a glob such as apps/dashboard/**') },
  annotations: READ,
  handler: async (ctx: CallContext, args) => {
    const target = args.target.trim().replace(/^\.\//, '');
    const result = await hubGet<WhoIsOnResponse>(ctx, '/v1/query/who_is_on', { target });
    if (result?.ok) return toolResult(render(result.data, ctx.dev, '(live)'), result.data);

    const snap = ctx.snapshot;
    const areas = areasOf(ctx);
    const targetKind: WhoIsOnResponse['targetKind'] = areas[target] ? 'area' : isGlobPattern(target) ? 'glob' : 'path';
    const covers = (path: string): boolean => (targetKind === 'area' ? areasOfPath(path, areas).includes(target) : matchGlob(target, path));
    const areaNames = targetKind === 'area' ? [target] : Object.keys(areas).filter((a) => (areas[a]?.paths ?? []).some((g) => matchGlob(g, target) || matchGlob(target, g)));
    const heat = (snap?.heat ?? []).filter((h) => covers(h.path));
    const heatSessions = new Set(heat.map((h) => h.sessionId));
    const live: PresenceRecord[] = (snap?.sessions ?? [])
      .filter((s) => s.state !== 'gone' && (heatSessions.has(s.id) || (s.area !== null && areaNames.includes(s.area))))
      .map((s) => ({
        dev: s.dev,
        sessionId: s.id,
        client: s.client,
        host: s.host,
        repo: s.repo ?? snap?.repo.slug ?? '',
        project: snap?.repo.project ?? '',
        branch: s.branch,
        worktree: s.worktree,
        area: s.area,
        objective: s.objective,
        objectiveSource: null,
        state: s.state,
        startedAt: s.lastSeenAt,
        lastSeenAt: s.lastSeenAt,
        lastEditAt: s.lastEditAt,
        inTurnSince: s.inTurnSince,
        editCount: 0,
        recentFiles: heat.filter((h) => h.sessionId === s.id).map((h) => h.path).slice(0, 5),
      }));
    const recentEditors: HeatEntry[] = heat.filter((h) => h.kind !== 'dirty');
    const dirty: HeatEntry[] = heat.filter((h) => h.kind === 'dirty');
    const breaker = readBreaker(ctx.home, ctx.now);
    const response: WhoIsOnResponse = {
      at: snap?.serverTime ?? new Date(ctx.now).toISOString(),
      target,
      targetKind,
      live,
      recentEditors,
      dirty,
      claims: (snap?.claims ?? [])
        .filter((c) => c.target === target || matchGlob(c.target, target) || matchGlob(target, c.target) || areaNames.includes(c.target))
        .map((c) => ({ id: c.id, repo: snap?.repo.slug ?? '', dev: c.dev, sessionId: null, target: c.target, note: c.note, hard: c.hard, keep: false, createdAt: c.expiresAt, expiresAt: c.expiresAt, releasedAt: null })),
      freshness: cacheFreshness(snap, breaker.open, ctx.now),
    };
    const note = hubFailureLine(result, snap, ctx.now);
    const text = snap ? `${render(response, ctx.dev, cachedLabel(snap))}\n${note}` : `Relay who_is_on ${target}: no cached snapshot and the hub is unavailable.\n${note}`;
    return toolResult(text, response);
  },
});
