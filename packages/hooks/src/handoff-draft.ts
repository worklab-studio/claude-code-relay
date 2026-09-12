/**
 * Tier-1 heuristic handoff draft (§8.2), built from the fold at every Stop
 * (§4.8 step 3), ≤ 8 KB, written to draft.json and carried by `turn_end` and
 * session end so a crash still leaves a teammate-visible handoff.
 */
import { basename } from 'node:path';
import {
  LIMITS,
  areaOfPath,
  deriveObjective,
  nowIso,
  openContracts,
  truncateWords,
  type HandoffChangedFile,
  type HandoffDraft,
  type HandoffInterfaceChanged,
  type JournalFold,
  type RelayArea,
} from '@relay/core';

const DONE_RE = /^(Done|I've|I have|Added|Updated|Fixed|Implemented|Removed|Renamed|Migrated)\b/;
const DECISION_RE = /\b(decided|decision|we'll go with|going with|chose|settled on|instead of)\b/i;
const BLOCKER_RE = /\b(blocked|blocker|waiting on|can't proceed|cannot|need [^.]* from)\b/i;
const NEXT_HEADING_RE = /^\s*(?:#+\s*|\*\*)?(next(?: steps)?|todo|remaining)\b/i;
const HEADING_RE = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*:?\s*$)/;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;

const DONE_MAX = 6;
const NEXT_MAX = 5;
const LINE_MAX = 140;

/** Sentences of a turn's prose (kept simple: split on sentence end or line break). */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length > 3);
}

/** Bullets under a `Next` / `TODO` / `Remaining` heading in the last turn (≤ 5). */
export function nextBullets(text: string, max: number = NEXT_MAX): string[] {
  const out: string[] = [];
  let inNext = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (NEXT_HEADING_RE.test(line) && (HEADING_RE.test(line) || /:\s*$/.test(line) || /^\s*\*\*/.test(line))) {
      inNext = true;
      continue;
    }
    if (!inNext) continue;
    if (HEADING_RE.test(line)) break;
    const b = BULLET_RE.exec(line);
    if (b?.[1]) {
      out.push(truncateWords(b[1].trim(), LINE_MAX));
      if (out.length >= max) break;
    } else if (line.trim() === '' && out.length) break;
  }
  return out;
}

/** A session with 0 edits, 0 commits and < 3 prompts gets no handoff (§8.1). */
export function isTrivialSession(fold: JournalFold): boolean {
  return Object.keys(fold.edits).length === 0 && fold.commits.length === 0 && fold.prompts.count < 3;
}

export interface DraftInput {
  fold: JournalFold;
  areas: Record<string, RelayArea>;
  branch: string | null;
  repoSlug: string;
  objectiveFromPrompts?: boolean;
  /** files changed outside Claude this session (dirty ∪ own-commit files − fold edits), §4.8 step 2 */
  outsideFiles?: readonly string[];
  now?: number;
}

export function buildHandoffDraft(input: DraftInput): HandoffDraft {
  const { fold, areas } = input;
  const now = input.now ?? Date.now();
  const objective = deriveObjective(fold, { branch: input.branch, repoSlug: input.repoSlug, objectiveFromPrompts: input.objectiveFromPrompts });
  const changed: HandoffChangedFile[] = Object.entries(fold.edits)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([path, e]) => ({ path, area: areaOfPath(path, areas), edits: e.count }));
  for (const path of input.outsideFiles ?? []) if (!fold.edits[path]) changed.push({ path, area: areaOfPath(path, areas), edits: 0 });
  const areaSet = new Set<string>();
  for (const c of changed) if (c.area) areaSet.add(c.area);

  const commitByPath = new Map<string, { sha: string; pushed: boolean }>();
  for (const c of fold.commits) for (const p of c.contracts) if (!commitByPath.has(p)) commitByPath.set(p, { sha: c.sha, pushed: c.pushed === true });
  const interfaces: HandoffInterfaceChanged[] = Object.values(openContracts(fold)).map((c) => {
    const commit = commitByPath.get(c.path);
    return {
      changeSetId: null,
      impactId: null,
      path: c.path,
      symbols: c.symbols,
      summary: `${basename(c.path)}: ${c.symbols.length ? c.symbols.join(', ') : 'edited'}`,
      status: commit ? (commit.pushed ? 'pushed' : 'committed') : 'uncommitted',
      commitSha: commit?.sha ?? null,
    };
  });

  const lastTurns = fold.turns.slice(-2).map((t) => t.text);
  const done: string[] = fold.tasks.done.map((t) => truncateWords(t.subject, LINE_MAX));
  const decisions: string[] = [];
  const blockers: string[] = [];
  for (const text of lastTurns) {
    for (const s of sentencesOf(text)) {
      if (done.length < DONE_MAX && DONE_RE.test(s)) done.push(truncateWords(s, LINE_MAX));
      if (DECISION_RE.test(s) && decisions.length < 5) decisions.push(truncateWords(s, LINE_MAX));
      if (BLOCKER_RE.test(s) && blockers.length < 5) blockers.push(truncateWords(s, LINE_MAX));
    }
  }
  const last = lastTurns[lastTurns.length - 1] ?? '';
  const draft: HandoffDraft = {
    at: nowIso(now),
    quality: 'heuristic',
    objective: objective.text,
    areas: [...areaSet],
    done: unique(done).slice(0, DONE_MAX + fold.tasks.done.length),
    changed: changed.slice(0, 60),
    interfaces_changed: interfaces,
    decisions: unique(decisions),
    blockers: unique(blockers),
    next: nextBullets(last),
    commits: fold.commits.map((c) => ({ sha: c.sha, subject: c.subject, pushed: c.pushed === true })),
    notes_to: [],
    objectiveTrail: fold.objective.trail.map((o) => o.objective).slice(0, 5),
  };
  return shrinkDraft(draft);
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** Keep the JSON under 8 KB by trimming the longest lists first. */
export function shrinkDraft(draft: HandoffDraft): HandoffDraft {
  let d = draft;
  const size = (): number => Buffer.byteLength(JSON.stringify(d));
  if (size() <= LIMITS.draftBytes) return d;
  d = { ...d, changed: d.changed.slice(0, 30), commits: d.commits.slice(-20) };
  if (size() <= LIMITS.draftBytes) return d;
  d = { ...d, interfaces_changed: d.interfaces_changed.slice(0, 10), done: d.done.slice(0, 6), decisions: d.decisions.slice(0, 3), blockers: d.blockers.slice(0, 3) };
  if (size() <= LIMITS.draftBytes) return d;
  return { ...d, changed: d.changed.slice(0, 10), commits: d.commits.slice(-5), objectiveTrail: [] };
}
