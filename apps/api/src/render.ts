/**
 * One-line renderings shared by the digest (§9.3), impact notifications and the
 * recent_changes tool. Every line is a factual statement with an absolute
 * timestamp (§4.0 rule 15/16); nothing here is an imperative.
 */
import { LIMITS, inlineText, neutralizeRelayTags } from '@relay/core';
import type { ChangeSetBundle } from './db/queries.js';
import type { DevRow, HandoffRow, RepoRow, SessionRow } from './db/schema.js';
import { deriveState, inLongTurn } from './presence.js';
import { ageMs, dateMinute, hhmm, hhmmss, shortDuration } from './util/time.js';

export interface ChangeSetLineOptions {
  withDependents?: boolean;
  /** "not in your branch" suffix knowledge is client-side; the hub only states the status */
}

/** Status from the open impacts: a committed part is named even while a sibling file is still in progress. */
export function statusLabel(b: ChangeSetBundle): string {
  const cs = b.changeSet;
  if (cs.status === 'withdrawn') return 'withdrawn';
  if (cs.status === 'merged') return 'merged';
  const open = b.impacts.filter((i) => i.status !== 'withdrawn' && i.supersededBy === null);
  const committed = open.filter((i) => i.commitSha);
  const inProgress = open.filter((i) => i.status === 'uncommitted').length;
  if (committed.length === 0) return 'uncommitted, in progress';
  const pushed = committed.every((i) => i.status === 'pushed' || i.status === 'merged');
  const sha = committed[committed.length - 1]?.commitSha ?? '';
  const head = `${pushed ? 'pushed' : 'committed'} ${sha.slice(0, 7)}`;
  return inProgress > 0 ? `${head}, ${inProgress} file${inProgress === 1 ? '' : 's'} still in progress` : head;
}

/** `cs_…: priya changed 2 contract files at 09:01Z (feat/currency, committed a1b2c3d): billing.ts (Invoice, createInvoice); schema.prisma (Invoice). Your dependents: …` */
export function changeSetLine(b: ChangeSetBundle, viewerRepo: RepoRow | null, opts: ChangeSetLineOptions = {}): string {
  const cs = b.changeSet;
  const open = b.impacts.filter((i) => i.status !== 'withdrawn' && i.supersededBy === null);
  const files = open.map((i) => i.summary).join('; ');
  const n = open.length;
  const what = n === 1 ? `changed ${open[0]?.path ?? 'a contract file'}` : `changed ${n} contract files`;
  const crossRepo = viewerRepo && viewerRepo.id !== b.sourceRepo.id ? ` in ${b.sourceRepo.slug}` : '';
  let line = `${cs.id}: ${b.author.handle} ${what}${crossRepo} at ${hhmmss(cs.lastAt)} (${cs.branch}, ${statusLabel(b)})`;
  if (n > 1 && files) line += `: ${files}`;
  else if (n === 1 && open[0] && open[0].symbols.length > 0) line += `: ${open[0].summary}`;
  if (opts.withDependents) {
    const targets = viewerRepo ? b.targets.filter((t) => t.repoId === viewerRepo.id) : b.targets;
    const deps = (b.target ? [b.target] : targets).flatMap((t) => t.dependents).filter((d) => d.via !== 'depends');
    const areas = (b.target ? [b.target] : targets).flatMap((t) => t.dependents).filter((d) => d.via === 'depends').map((d) => d.area ?? d.path);
    if (deps.length > 0) {
      const shown = deps.slice(0, 6).map((d) => d.path);
      line += `. Your dependents: ${shown.join(', ')}${deps.length > 6 ? ` (+${deps.length - 6} more)` : ''}`;
    } else if (areas.length > 0) {
      line += `. Depends: ${[...new Set(areas)].join(', ')}`;
    }
  }
  return inlineText(line, 2000); // summaries/symbols/branch come from the author's repo: one line, block-safe (§11)
}

/** Fenced diff block for the top change sets of a digest (hunk <= 1,500 chars, §9.3). */
export function changeSetDiff(b: ChangeSetBundle): string | null {
  const hunks = b.impacts
    .filter((i) => i.status !== 'withdrawn' && i.supersededBy === null && i.hunk)
    .map((i) => i.hunk as string);
  if (hunks.length === 0) return null;
  const text = neutralizeRelayTags(hunks.join('\n'));
  if (text.length > LIMITS.hunkChars) return null;
  return '  ```diff\n' + text.split('\n').map((l) => '  ' + l).join('\n') + '\n  ```';
}

export function handoffLine(h: HandoffRow, dev: DevRow): string {
  // handoff strings are teammate- or LLM-supplied: one line each, block-safe (§11)
  const parts = [`${inlineText(dev.handle, 64)} · ${inlineText(h.branch, 120)} · ${dateMinute(h.endedAt ?? h.generatedAt)}`];
  if (h.objective) parts.push(`objective: ${inlineText(h.objective, LIMITS.objectiveChars)}`);
  if (h.done.length > 0) parts.push(`done: ${h.done.slice(0, 2).map((d) => inlineText(d, 300)).join('; ')}`);
  if (h.interfacesChanged.length > 0) parts.push(`interfaces: ${h.interfacesChanged.map((i) => inlineText(`${basename(i.path)} (${i.symbols.join(', ')})`, 300)).join('; ')}`);
  if (h.next.length > 0) parts.push(`next: ${h.next.slice(0, 2).map((n) => inlineText(n, 300)).join('; ')}`);
  if (h.blockers.length > 0) parts.push(`blockers: ${h.blockers.slice(0, 2).map((b) => inlineText(b, 300)).join('; ')}`);
  parts.push(h.quality === 'heuristic' ? `${h.id} (auto-summary)` : h.id);
  return parts.join(' · ');
}

export function sessionLine(s: SessionRow, dev: DevRow, repo: RepoRow, now: Date, opts: { mine?: boolean; showRepo?: boolean } = {}): string {
  const state = deriveState(s, now);
  const who = opts.mine ? '(you) other session' : dev.handle;
  const area = inlineText(s.area ?? 'unknown', 80);
  const objective = s.objective ? ` · "${inlineText(s.objective, LIMITS.objectiveChars)}"` : '';
  let stateText: string;
  if (state === 'working') {
    stateText = inLongTurn(s, now)
      ? `in a long turn ${shortDuration(ageMs(now, s.inTurnSince))}, last event ${hhmmss(s.lastSeenAt)}`
      : `working, last event ${hhmmss(s.lastSeenAt)}`;
  } else if (state === 'idle') {
    stateText = `idle since ${hhmm(s.lastSeenAt)}`;
  } else {
    stateText = `${state} since ${hhmm(s.lastSeenAt)}`;
  }
  const files = s.recentFiles.length > 0 ? ` · files: ${s.recentFiles.slice(0, 3).join(', ')}` : '';
  const wt = s.worktree ? ` wt:${s.worktree}` : '';
  const repoText = opts.showRepo ? ` · ${repo.slug}` : '';
  return inlineText(`${who} · ${area} · ${s.branch}${wt}${objective} · ${stateText}${files}${repoText}`, 600);
}

function basename(p: string): string {
  return p.split('/').pop() ?? p;
}
