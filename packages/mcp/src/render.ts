/**
 * Text renderers shared by the tools: one factual line per record, absolute
 * times only (§4.0 rule 15/16). The json block carries the full payload; the
 * text is the compact human/Claude-readable summary.
 */
import {
  changeSetStatus,
  dateTimeZ,
  shortTime,
  truncateWords,
  type ChangeSetView,
  type ClaimRecord,
  type DecisionRecord,
  type Dependent,
  type HandoffRecord,
  type HeatEntry,
  type PresenceRecord,
  type RecentChangeItem,
  type SnapshotChangeSet,
  type SnapshotClaim,
  type SnapshotSession,
} from '@relay/core';
import { plural, shortSha } from './format.js';

type AnySession = PresenceRecord | SnapshotSession;

function sessionIdOf(s: AnySession): string {
  return 'sessionId' in s ? s.sessionId : s.id;
}

/** `working, last event 09:40:27Z` / `working, in a turn since 09:39:00Z` / `idle since 09:29:00Z`. */
export function stateText(s: Pick<AnySession, 'state' | 'lastSeenAt' | 'inTurnSince'>): string {
  if (s.state === 'working') {
    return s.inTurnSince ? `working, in a turn since ${shortTime(s.inTurnSince)}, last event ${shortTime(s.lastSeenAt)}` : `working, last event ${shortTime(s.lastSeenAt)}`;
  }
  return `${s.state} since ${shortTime(s.lastSeenAt)}`;
}

/** One presence line: `priya · working, last event 09:40:27Z · cli · feat/currency (wt:x) · app · "objective" · files: a, b`. */
export function sessionLine(s: AnySession, meDev: string, opts: { files?: boolean } = {}): string {
  const who = s.dev === meDev ? `${s.dev} (you)` : s.dev;
  const branch = s.worktree ? `${s.branch} (wt:${s.worktree})` : s.branch;
  const bits = [who, stateText(s), s.client, branch, s.area ?? 'area unknown'];
  if ('repo' in s && s.repo) bits.push(s.repo);
  if (s.objective) bits.push(`"${truncateWords(s.objective, 80)}"`);
  if (opts.files !== false && 'recentFiles' in s && s.recentFiles.length) bits.push(`files: ${s.recentFiles.slice(0, 5).join(', ')}`);
  bits.push(`session ${sessionIdOf(s).slice(0, 8)}`);
  return bits.join(' · ');
}

/** `clm_…: priya claims apps/dashboard (hard) until 2026-09-12T13:41Z ("note")`. */
export function claimLine(c: ClaimRecord | SnapshotClaim): string {
  const hard = c.hard ? ' (hard)' : '';
  const keep = 'keep' in c && c.keep ? ', kept across sessions' : '';
  const note = c.note ? ` ("${truncateWords(c.note, 80)}")` : '';
  return `${c.id}: ${c.dev} claims ${c.target}${hard} until ${dateTimeZ(c.expiresAt)}${keep}${note}`;
}

/** `priya edited apps/x.ts at 09:40:00Z (6 edits, feat/currency)` / `arjun committed … (a1b2c3d, pushed)`. */
export function heatLine(h: HeatEntry, meDev: string): string {
  const who = h.dev === meDev ? `${h.dev} (you)` : h.dev;
  const at = shortTime(h.at);
  switch (h.kind) {
    case 'edit':
      return `${who} edited ${h.path} at ${at} (${plural(h.count ?? 1, 'edit')}, ${h.branch})`;
    case 'commit':
      return `${who} committed ${h.path} at ${at} (${shortSha(h.headSha) || 'sha unknown'}${h.pushed ? ', pushed' : ''}, ${h.branch})`;
    case 'dirty':
      return `${who} had ${h.path} uncommitted at ${at} (${h.branch})`;
  }
}

/** `apps/dashboard/src/x.tsx (dashboard, import, github.com/acme/app)`. */
export function dependentText(d: Dependent): string {
  const bits = [d.area, d.via, d.repo].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return bits.length ? `${d.path} (${bits.join(', ')})` : d.path;
}

/** `cs_…: priya changed 2 contract files at 09:01:00Z (feat/currency, committed a1b2c3d, high): billing.ts (Invoice, createInvoice); … · dependents: a, b · acked by: x`. */
export function changeSetLine(cs: SnapshotChangeSet | ChangeSetView, opts: { merged?: boolean; meDev?: string } = {}): string {
  const n = cs.impacts.length;
  const files = cs.impacts.map((i) => `${i.path.split('/').pop()} (${i.symbols.length ? i.symbols.join(', ') : i.summary || i.status})`);
  const what = n === 1 ? `changed ${cs.impacts[0]?.path ?? 'a contract file'}` : `changed ${plural(n, 'contract file')}`;
  const where = cs.repo ? ` in ${cs.repo}` : '';
  let line = `${cs.id}: ${cs.by} ${what}${where} at ${shortTime(cs.at)} (${cs.branch}, ${changeSetStatus(cs, opts.merged)}, ${cs.priority})`;
  if (n === 1 && cs.impacts[0]) line += `: ${cs.impacts[0].summary || cs.impacts[0].symbols.join(', ')}`;
  else if (files.length) line += `: ${files.join('; ')}`;
  const deps = cs.dependents.filter((d) => d.via !== 'depends').map((d) => d.path);
  if (deps.length) line += ` · dependents: ${deps.slice(0, 6).join(', ')}${deps.length > 6 ? ` (+${deps.length - 6} more)` : ''}`;
  if ('acked' in cs) {
    const acked = Object.entries(cs.acked);
    if (acked.length) line += ` · acked by ${acked.map(([d, at]) => `${d} at ${shortTime(at)}`).join(', ')}`;
    if (opts.meDev && cs.acked[opts.meDev]) line += ' (handled)';
  }
  return line;
}

/** One `recent_changes` item. */
export function recentChangeLine(item: RecentChangeItem): string {
  const at = shortTime(item.at);
  switch (item.kind) {
    case 'contract':
      return `${at} ${item.dev} · contract ${item.path} (${item.symbols.length ? item.symbols.join(', ') : item.summary}) · ${item.branch} · ${item.status}${item.commitSha ? ` ${shortSha(item.commitSha)}` : ''} · ${item.priority} · ${item.changeSetId}/${item.impactId} rev ${item.rev}${item.summary && item.symbols.length ? ` · ${item.summary}` : ''}`;
    case 'commit':
      return `${at} ${item.dev} · commit ${shortSha(item.sha)}${item.pushed ? ' (pushed)' : ''} · ${item.branch}${item.subject ? ` · ${item.subject}` : ''} · ${plural(item.files.length, 'file')}: ${item.files.slice(0, 5).join(', ')}${item.files.length > 5 ? ', …' : ''}`;
    case 'edit':
      return `${at} ${item.dev} · edit ${item.path} (${plural(item.count, 'edit')}) · ${item.branch}`;
    case 'handoff':
      return `${at} ${item.dev} · handoff · ${item.line}`;
  }
}

/** `2026-09-11T12:40Z priya (explicit, topic: money, area: billing) dec_…: text`. */
export function decisionLine(d: DecisionRecord): string {
  const tags = [d.source, d.topic ? `topic: ${d.topic}` : null, d.area ? `area: ${d.area}` : null, d.supersedes ? `supersedes ${d.supersedes}` : null].filter(Boolean).join(', ');
  return `${dateTimeZ(d.createdAt)} ${d.dev} (${tags}) ${d.id}: ${d.text}`;
}

/** Digest-style handoff one-liner (§8.4). */
export function handoffLine(h: HandoffRecord): string {
  const parts = [`${h.dev} · ${h.branch} · ${dateTimeZ(h.endedAt ?? h.generatedAt)} · ${h.quality}`];
  if (h.objective) parts.push(`objective: ${h.objective}`);
  if (h.done.length) parts.push(`done: ${h.done.slice(0, 2).join('; ')}`);
  if (h.interfaces_changed.length) parts.push(`interfaces: ${h.interfaces_changed.map((i) => `${i.path.split('/').pop()} (${i.symbols.join(', ')})`).join('; ')}`);
  if (h.next.length) parts.push(`next: ${h.next.slice(0, 2).join('; ')}`);
  if (h.blockers.length) parts.push(`blockers: ${h.blockers.slice(0, 2).join('; ')}`);
  parts.push(`${h.id} rev ${h.rev}`);
  return parts.join(' · ');
}
