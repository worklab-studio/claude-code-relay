/**
 * Area derivation (§5.2): recency-weighted vote over the last 20 edited paths,
 * `shared` areas never win alone, then branch token / owner / cwd tie-breakers.
 * Pure functions over the fold and the resolved config.
 */
import { matchAny } from './glob.js';
import type { DevHandle, RelayArea } from './protocol.js';
import { inferAreaFromPath } from './repo.js';
import { parseIso } from './util.js';

export interface AreaVoteInput {
  /** newest first, at most 20 are used (§5.2) */
  recentEdits: ReadonlyArray<{ path: string; at: string }>;
  areas: Record<string, RelayArea>;
  now?: number;
  branch?: string | null;
  dev?: DevHandle | null;
  /** cwd relative to the repo root (POSIX), for the last tie-breaker */
  cwdRel?: string | null;
}

export interface AreaVote {
  /** primary area name (`unknown` when nothing applies) */
  area: string;
  /** `app (+contracts)` when shared areas also received votes */
  display: string;
  /** shared areas that received votes, by weight */
  shared: string[];
  scores: Record<string, number>;
  source: 'edits' | 'branch' | 'owner' | 'cwd' | 'unknown';
}

/** All configured areas whose globs match the path (a path may belong to several); inferred `apps/x` area when no areas are configured. */
export function areasOfPath(path: string, areas: Record<string, RelayArea>): string[] {
  const names = Object.keys(areas);
  if (names.length === 0) return [inferAreaFromPath(path)];
  const out: string[] = [];
  for (const name of names) {
    const area = areas[name];
    if (area && matchAny(area.paths, path)) out.push(name);
  }
  return out;
}

/** The single best area for a path: first non-shared match, else first match, else null. */
export function areaOfPath(path: string, areas: Record<string, RelayArea>): string | null {
  const all = areasOfPath(path, areas);
  const nonShared = all.find((n) => !areas[n]?.shared);
  return nonShared ?? all[0] ?? null;
}

/** Recency weight: `3 / (1 + minutesAgo / 10)` (§5.2). */
export function recencyWeight(atMs: number, now: number): number {
  const minutes = Math.max(0, now - atMs) / 60_000;
  return 3 / (1 + minutes / 10);
}

/** First area whose name appears as a token in the branch (`feat/dashboard-legend` -> `dashboard`). */
export function areaFromBranch(branch: string | null | undefined, areaNames: readonly string[]): string | null {
  if (!branch) return null;
  const tokens = new Set(branch.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const name of areaNames) if (tokens.has(name.toLowerCase())) return name;
  return null;
}

export function voteArea(input: AreaVoteInput): AreaVote {
  const now = input.now ?? Date.now();
  const areas = input.areas;
  const names = Object.keys(areas);
  const scores: Record<string, number> = {};
  for (const edit of input.recentEdits.slice(0, 20)) {
    const at = parseIso(edit.at) ?? now;
    const w = recencyWeight(at, now);
    for (const name of areasOfPath(edit.path, areas)) scores[name] = (scores[name] ?? 0) + w;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shared = ranked.filter(([n]) => areas[n]?.shared).map(([n]) => n);
  const primaryRanked = ranked.filter(([n]) => !areas[n]?.shared);
  const top = primaryRanked[0];
  const second = primaryRanked[1];
  const tie = top && second && Math.abs(top[1] - second[1]) < 1e-9;

  const finish = (area: string, source: AreaVote['source']): AreaVote => ({
    area,
    display: shared.length && !shared.includes(area) ? `${area} (+${shared.join(', +')})` : area,
    shared,
    scores,
    source,
  });

  if (top && !tie) return finish(top[0], 'edits');

  // ties or no (non-shared) edits: branch token -> owner -> cwd segment -> unknown (§5.2)
  const candidates = tie ? primaryRanked.filter(([, s]) => Math.abs(s - top[1]) < 1e-9).map(([n]) => n) : names;
  const byBranch = areaFromBranch(input.branch, candidates);
  if (byBranch) return finish(byBranch, 'branch');
  if (input.dev) {
    const owned = candidates.find((n) => areas[n]?.owners?.includes(input.dev as string));
    if (owned) return finish(owned, 'owner');
  }
  if (tie && top) return finish(top[0], 'edits');
  if (input.cwdRel && input.cwdRel !== '.' && input.cwdRel !== '') {
    const seg = input.cwdRel.split('/').filter(Boolean);
    const first = seg[0] ?? '';
    // configured area covering the cwd wins; else the first path segment (`apps/app` -> `app`)
    const covering = areaOfPath(`${input.cwdRel}/.`, areas);
    if (covering && names.length) return finish(covering, 'cwd');
    const guess = seg.length >= 2 && /^(apps|packages|libs|services|modules)$/.test(first) ? (seg[1] ?? first) : first;
    if (guess) return finish(guess, 'cwd');
  }
  // only shared areas were edited: better than "unknown (+contracts)"
  if (shared.length) return { area: shared[0] as string, display: shared[0] as string, shared, scores, source: 'edits' };
  return finish('unknown', 'unknown');
}
