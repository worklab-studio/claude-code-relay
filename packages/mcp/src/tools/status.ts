/**
 * `status {project?: "current"|"all"}` (§9.2): per dev → sessions, explicit
 * claims, my unacked change sets, unread inbox, freshness. Falls back to the
 * cached snapshot with a "(cached HH:MMZ)" label (§9.1).
 */
import { readBreaker, shortTime, type StatusResponse } from '@relay/core';
import { z } from 'zod';
import type { CallContext } from '../context.js';
import { cacheFreshness, cachedLabel, hubFailureLine, kv, toolResult } from '../format.js';
import { hubGet } from '../hub.js';
import { claimLine, sessionLine } from '../render.js';
import { READ, defineTool } from './define.js';

function renderStatus(r: StatusResponse, label: string): string {
  const lines: string[] = [];
  const projects = r.projects.map((p) => `${p.project} (${p.repos.join(', ') || 'no repos'})`).join('; ');
  lines.push(
    `Relay status at ${shortTime(r.at)} ${label}: ${kv([
      ['scope', r.scope],
      ['projects', projects || 'none'],
      ['me', `${r.me.dev}${r.me.sessionId ? ` session ${r.me.sessionId.slice(0, 8)}` : ''}`],
      ['unacked change sets', r.me.unackedChangeSets],
      ['unread inbox', r.me.unreadInbox],
    ])}`,
  );
  let any = false;
  for (const p of r.projects) {
    for (const d of p.devs) {
      any = true;
      if (d.sessions.length === 0) lines.push(`- ${d.dev}: no live session${d.lastSeenAt ? `, last seen ${shortTime(d.lastSeenAt)}` : ''}`);
      for (const s of d.sessions) lines.push(`- ${sessionLine(s, r.me.dev)}`);
      for (const c of d.claims) lines.push(`  claim ${claimLine(c)}`);
    }
  }
  if (!any) lines.push('- nobody is live in this project');
  return lines.join('\n');
}

export const statusTool = defineTool({
  name: 'status',
  description:
    'Team presence for this project: every developer with live Claude sessions (state, client, branch, worktree, area, objective, last seen), their explicit claims, the count of contract change sets waiting for you and unread notes, plus hub/cache freshness. project="all" is the cross-project manager view. Answers from the cached snapshot (labelled "cached HH:MMZ") when the hub is unreachable.',
  schema: { project: z.enum(['current', 'all']).optional().describe('"current" (default) = this project; "all" = every project on the hub') },
  annotations: READ,
  handler: async (ctx: CallContext, args) => {
    const scope = args.project ?? 'current';
    const result = await hubGet<StatusResponse>(ctx, '/v1/query/status', { project: scope });
    if (result?.ok) return toolResult(renderStatus(result.data, '(live)'), result.data);

    // cache fallback (§9.1): the snapshot has the project's live sessions, others' claims, my change sets and inbox
    const snap = ctx.snapshot;
    const breaker = readBreaker(ctx.home, ctx.now);
    const devs = new Map<string, StatusResponse['projects'][number]['devs'][number]>();
    for (const s of snap?.sessions ?? []) {
      const d = devs.get(s.dev) ?? { dev: s.dev, sessions: [], claims: [], lastSeenAt: null };
      d.sessions.push({
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
        recentFiles: [],
      });
      if (!d.lastSeenAt || s.lastSeenAt > d.lastSeenAt) d.lastSeenAt = s.lastSeenAt;
      devs.set(s.dev, d);
    }
    for (const c of snap?.claims ?? []) {
      const d = devs.get(c.dev) ?? { dev: c.dev, sessions: [], claims: [], lastSeenAt: null };
      d.claims.push({ id: c.id, repo: snap?.repo.slug ?? '', dev: c.dev, sessionId: null, target: c.target, note: c.note, hard: c.hard, keep: false, createdAt: c.expiresAt, expiresAt: c.expiresAt, releasedAt: null });
      devs.set(c.dev, d);
    }
    const response: StatusResponse = {
      at: snap?.serverTime ?? new Date(ctx.now).toISOString(),
      scope: 'current',
      projects: snap ? [{ project: snap.repo.project, repos: [snap.repo.slug], devs: [...devs.values()] }] : [],
      me: { dev: ctx.dev, sessionId: ctx.session.sessionId, unackedChangeSets: snap?.changeSets.length ?? 0, unreadInbox: snap?.inbox.length ?? 0 },
      freshness: cacheFreshness(snap, breaker.open, ctx.now),
    };
    const note = hubFailureLine(result, snap, ctx.now);
    const text = snap
      ? `${renderStatus(response, cachedLabel(snap))}\n${note}${scope === 'all' ? '\nThe cache covers this project only; the "all" view needs the hub.' : ''}`
      : `Relay status: no cached snapshot for ${ctx.repo ?? 'this repo'} and the hub is unavailable.\n${note}`;
    return toolResult(text, response);
  },
});
