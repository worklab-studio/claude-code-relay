/**
 * Receiver-side ancestry (§4.12, §7.2 last row, §6.3): for every heat
 * `headSha`, change-set commit SHA and impact blob in the snapshot, decide
 * whether it is already in my branch — fast path `merge-base --is-ancestor`,
 * content path `HEAD:<path>` blob equality or every `+` line of the hunk
 * present in `HEAD:<path>` (squash merges and rebases never make the original
 * SHA an ancestor; content does). Worker-only: runs git.
 */
import { join } from 'node:path';
import { hunkContainedIn } from './contracts.js';
import { gitBlobAt, gitHead, gitIsAncestor, gitShowFile, type GitRunOptions } from './git.js';
import { readAncestry, writeAncestry } from './cache.js';
import type { AncestryFile, RepoKey, Snapshot } from './protocol.js';
import { nowIso } from './util.js';

export interface AncestryTargets {
  /** every commit SHA worth an --is-ancestor check */
  shas: string[];
  /** change sets with their impact blobs/hunks for the content path (same-repo only) */
  changeSets: Array<{ id: string; commitShas: string[]; impacts: Array<{ path: string; blobId: string | null; hunk: string | null }> }>;
}

/** Pure: what the worker must check for this snapshot. Cross-repo change sets have no local blob and are skipped (§7.5 step 10). */
export function ancestryTargets(snapshot: Pick<Snapshot, 'heat' | 'changeSets' | 'repo'>): AncestryTargets {
  const shas = new Set<string>();
  for (const h of snapshot.heat) if (h.headSha) shas.add(h.headSha);
  const changeSets: AncestryTargets['changeSets'] = [];
  for (const cs of snapshot.changeSets) {
    if (cs.repo && cs.repo !== snapshot.repo.slug) continue;
    const commitShas = cs.impacts.map((i) => i.commitSha).filter((s): s is string => typeof s === 'string' && s.length > 0);
    for (const s of commitShas) shas.add(s);
    changeSets.push({ id: cs.id, commitShas, impacts: cs.impacts.map((i) => ({ path: i.path, blobId: i.blobId, hunk: i.hunk })) });
  }
  return { shas: [...shas], changeSets };
}

export interface ComputeAncestryOptions extends GitRunOptions {
  /** reuse verdicts from the previous file when HEAD is unchanged */
  previous?: AncestryFile | null;
  /** upper bound on git calls per run (each <= 1 s) */
  maxChecks?: number;
  now?: number;
}

/**
 * Compute ancestry.json content. `merged[cs]` is true when every impact of the
 * change set is in my branch by SHA, blob or hunk content; false when any is
 * known to be absent; absent from the map when undecidable.
 */
export async function computeAncestry(cwd: string, snapshot: Pick<Snapshot, 'heat' | 'changeSets' | 'repo'>, opts: ComputeAncestryOptions = {}): Promise<AncestryFile | null> {
  const head = await gitHead(cwd, opts);
  if (!head) return null;
  const targets = ancestryTargets(snapshot);
  const prev = opts.previous && opts.previous.headSha === head ? opts.previous : null;
  const contains: Record<string, boolean> = { ...(prev?.contains ?? {}) };
  let budget = opts.maxChecks ?? 60;
  for (const sha of targets.shas) {
    if (sha in contains || budget <= 0) continue;
    budget -= 1;
    const r = await gitIsAncestor(cwd, sha, head, opts);
    if (r !== null) contains[sha] = r;
  }
  const merged: Record<string, boolean> = { ...(prev?.merged ?? {}) };
  const blobCache = new Map<string, string | null>();
  const fileCache = new Map<string, string | null>();
  for (const cs of targets.changeSets) {
    if (merged[cs.id] === true) continue; // once merged, stays merged for this HEAD
    if (cs.commitShas.length && cs.commitShas.every((s) => contains[s] === true)) {
      merged[cs.id] = true;
      continue;
    }
    let all = true;
    let undecidable = false;
    for (const imp of cs.impacts) {
      if (budget <= 0) {
        undecidable = true;
        break;
      }
      let inBranch: boolean | null = null;
      if (imp.blobId) {
        if (!blobCache.has(imp.path)) {
          budget -= 1;
          blobCache.set(imp.path, await gitBlobAt(cwd, head, imp.path, opts));
        }
        const mine = blobCache.get(imp.path) ?? null;
        if (mine && mine === imp.blobId) inBranch = true;
      }
      if (inBranch === null && imp.hunk) {
        if (!fileCache.has(imp.path)) {
          budget -= 1;
          fileCache.set(imp.path, await gitShowFile(cwd, head, imp.path, { ...opts, maxBytes: 512 * 1024 }));
        }
        const content = fileCache.get(imp.path) ?? null;
        if (content !== null) inBranch = hunkContainedIn(imp.hunk, content);
      }
      if (inBranch === null) {
        undecidable = true;
        break;
      }
      if (!inBranch) {
        all = false;
        break;
      }
    }
    if (!undecidable) merged[cs.id] = all;
  }
  return { headSha: head, at: nowIso(opts.now ?? Date.now()), contains, merged };
}

/** Compute and persist cache/<repoKey>/ancestry.json; returns the change-set ids that became merged this run (auto-ack candidates, §4.12). */
export async function refreshAncestry(home: string, key: RepoKey, cwd: string, snapshot: Pick<Snapshot, 'heat' | 'changeSets' | 'repo'>, opts: ComputeAncestryOptions = {}): Promise<{ file: AncestryFile | null; newlyMerged: string[] }> {
  const previous = opts.previous === undefined ? readAncestry(home, key) : opts.previous;
  const file = await computeAncestry(cwd, snapshot, { ...opts, previous });
  if (!file) return { file: null, newlyMerged: [] };
  const newlyMerged = Object.entries(file.merged)
    .filter(([id, v]) => v && previous?.merged[id] !== true)
    .map(([id]) => id);
  writeAncestry(home, key, file);
  return { file, newlyMerged };
}

/** Path of the ancestry file (for doctor output). */
export function ancestryPath(home: string, key: RepoKey): string {
  return join(home, 'cache', key, 'ancestry.json');
}
