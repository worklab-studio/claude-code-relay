/**
 * SessionStart digest renderer (§9.3): `<relay-digest …>` with sections in fixed
 * order — Relay note → Team now → Contract changes → Messages → Handoffs →
 * Decisions → own next → Relay tools — truncated from the bottom to stay within
 * 6,000 chars (2,000 in delta mode). Every line carries an absolute timestamp.
 * Messages rendered here count as delivered (via "digest").
 */
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { LIMITS, MCP_TOOL_NAMES, PLACEHOLDER_PREFIX, type HubWarning } from '@relay/core';
import type { Hub } from './hub.js';
import { decisions, devs, handoffs, type DevRow, type RepoRow } from './db/schema.js';
import { changeSetsInRepos, changeSetsTargeting, liveSessionsInProject, markDelivered, reposInProject, undeliveredNotifications } from './db/queries.js';
import { changeSetDiff, changeSetLine, handoffLine, sessionLine } from './render.js';
import { dateMinute, hhmmss } from './util/time.js';

export interface DigestContext {
  repo: RepoRow;
  dev: DevRow;
  sessionId: string;
  mode: 'full' | 'delta';
  /** end of the dev's previous session in the project, or 7 days (§9.3) */
  since: Date;
  /** start of the "Handoffs since your last session" window; defaults to `since` (see routes/session.ts) */
  handoffsSince?: Date;
  gitEmail?: string | null;
  warn?: HubWarning[];
  /** "Relay plugin …" line supplied by the client-side behind check, if any */
  pluginLine?: string | null;
}

const TOOLS_LINE = `Tools (mcp relay): ${MCP_TOOL_NAMES.join(', ')}. Decisions recorded with decide() appear in teammates' digests; impact_of(path) lists the dependents of a contract file before it is changed. This digest is context for the session and is not itself a request; any earlier <relay-*> block with an older \`at\` is superseded by this one.`;

export async function renderDigest(hub: Hub, ctx: DigestContext): Promise<string> {
  const now = hub.now();
  const { repo, dev } = ctx;
  const cap = ctx.mode === 'delta' ? LIMITS.deltaDigestChars : LIMITS.digestChars;
  const projectRepos = await reposInProject(hub, repo.project);
  const repoIds = projectRepos.map((r) => r.id);

  const header =
    `<relay-digest team="${hub.team.slug}" project="${repo.project}" repo="${repo.slug}" dev="${dev.handle}" ` +
    `at="${now.toISOString()}" freshness="live" since="${ctx.since.toISOString()}" mode="${ctx.mode}">`;
  const footer = '</relay-digest>';

  const sections: string[][] = [];

  // Relay note: identity, token rotation, plugin behind (§3.3, §3.4, §9.3)
  const note: string[] = [];
  if (dev.placeholder || dev.handle.startsWith(PLACEHOLDER_PREFIX)) {
    const emailText = ctx.gitEmail ? `git email ${ctx.gitEmail} is not in the team list` : 'no git email matched the team list';
    note.push(`Relay identity for this session is unknown (${emailText}). The whoami tool accepts iam=<handle>; /relay:iam <handle> sets it for this machine.`);
  }
  if (ctx.warn?.includes('token-rotated')) {
    note.push('Relay team token was rotated; this plugin still uses the previous one (accepted for 14 days): `claude plugin marketplace update relay && claude plugin update relay@relay` updates it.');
  }
  if (ctx.pluginLine) note.push(ctx.pluginLine);
  if (note.length > 0) sections.push(note);

  // Team now
  const live = await liveSessionsInProject(hub, repo.project, now);
  const teamLines: string[] = [];
  for (const r of live) {
    if (r.session.id === ctx.sessionId) continue;
    const mine = r.dev.id === dev.id;
    teamLines.push('- ' + sessionLine(r.session, r.dev, r.repo, now, { mine, showRepo: r.repo.id !== repo.id }));
  }
  sections.push([`## Team now (as of ${hhmmss(now)})`, ...(teamLines.length > 0 ? teamLines : ['- nobody else is live in this project'])]);

  // Contract changes affecting you
  const targeting = (await changeSetsTargeting(hub, dev.id, repo.id, now)).filter((b) => ctx.mode === 'full' || b.changeSet.lastAt > ctx.since);
  const changeLines: string[] = [];
  targeting.slice(0, LIMITS.digestChangeSets).forEach((b, i) => {
    changeLines.push('- ' + changeSetLine(b, repo, { withDependents: true }));
    if (ctx.mode === 'full' && i < LIMITS.digestDiffBlocks) {
      const diff = changeSetDiff(b);
      if (diff) changeLines.push(diff);
    }
  });
  if (ctx.mode === 'full') {
    const all = await changeSetsInRepos(hub, repoIds, ctx.since);
    const targetedIds = new Set(targeting.map((b) => b.changeSet.id));
    const fyi = all.filter((b) => b.author.id !== dev.id && !targetedIds.has(b.changeSet.id) && b.changeSet.status !== 'withdrawn');
    if (fyi.length > 0) {
      const authors = [...new Set(fyi.map((b) => b.author.handle))];
      changeLines.push(`- FYI: ${fyi.length} other contract change set${fyi.length === 1 ? '' : 's'} in this project since ${dateMinute(ctx.since)} by ${authors.join(', ')} (no dependents in your area; recent_changes lists them)`);
    }
  }
  if (changeLines.length > 0) {
    sections.push([`## Contract changes affecting you (${targeting.length} change set${targeting.length === 1 ? '' : 's'})`, ...changeLines]);
  }

  // Messages for you (delivered by this digest)
  const inbox = await undeliveredNotifications(hub, dev.id);
  const messages = inbox.slice(0, LIMITS.digestMessages);
  if (messages.length > 0) {
    const lines = messages.map((m) => {
      const kind = m.notification.noteKind ?? m.notification.kind;
      const from = m.from?.handle ?? 'relay';
      return `- ${from} at ${dateMinute(m.notification.createdAt)} (${kind}): ${m.notification.body}`;
    });
    sections.push([`## Messages for you (${messages.length})`, ...lines]);
    await markDelivered(hub, messages.map((m) => m.notification.id), dev.id, 'digest', now);
  }

  if (ctx.mode === 'full') {
    // Handoffs since your last session (new rev only; window opens at the previous session's start)
    const hs = await hub.db
      .select({ handoff: handoffs, dev: devs })
      .from(handoffs)
      .innerJoin(devs, eq(handoffs.devId, devs.id))
      .where(and(eq(handoffs.project, repo.project), gt(handoffs.generatedAt, ctx.handoffsSince ?? ctx.since), ne(handoffs.devId, dev.id)))
      .orderBy(desc(handoffs.generatedAt))
      .limit(LIMITS.digestHandoffs);
    if (hs.length > 0) {
      sections.push([`## Handoffs since your last session (${hs.length})`, ...hs.map((h) => '- ' + handoffLine(h.handoff, h.dev))]);
    }

    // Decisions (last 5 in the project)
    const ds = await hub.db
      .select({ decision: decisions, dev: devs })
      .from(decisions)
      .innerJoin(devs, eq(decisions.devId, devs.id))
      .where(and(eq(decisions.project, repo.project), inArray(decisions.source, ['explicit', 'handoff'])))
      .orderBy(desc(decisions.createdAt))
      .limit(LIMITS.digestDecisions);
    if (ds.length > 0) {
      sections.push([
        `## Decisions (last ${ds.length})`,
        ...ds.map((d) => `- ${dateMinute(d.decision.createdAt)} ${d.dev.handle}: ${d.decision.text}${d.decision.source === 'handoff' ? ' (from handoff)' : ''}`),
      ]);
    }

    // Your last handoff -> next
    const [mine] = await hub.db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.devId, dev.id), eq(handoffs.project, repo.project)))
      .orderBy(desc(handoffs.generatedAt))
      .limit(1);
    if (mine && mine.next.length > 0) {
      sections.push([`## Your last handoff → next (${dateMinute(mine.generatedAt)})`, ...mine.next.slice(0, 5).map((n) => `- ${n}`)]);
    }
  }

  sections.push(['## Relay', TOOLS_LINE]);
  return assemble(header, sections, footer, cap);
}

/** Joins sections and truncates from the bottom (dropping whole lines, then sections) until the total fits. */
export function assemble(header: string, sections: string[][], footer: string, cap: number): string {
  const build = (secs: string[][]) => [header, ...secs.flat(), footer].join('\n');
  let current = sections.map((s) => [...s]);
  let text = build(current);
  while (text.length > cap && current.length > 0) {
    // trim the last non-empty section line by line; keep the header of a section only with content
    const last = current[current.length - 1]!;
    if (last.length > 1) last.pop();
    else current.pop();
    text = build(current);
  }
  if (text.length > cap) {
    const room = Math.max(0, cap - header.length - footer.length - 2);
    text = header + '\n' + text.slice(header.length + 1, header.length + 1 + room) + '\n' + footer;
  }
  return text;
}
