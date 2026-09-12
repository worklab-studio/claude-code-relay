/**
 * Snapshot cache and liveness files (§4.0 rules 8, 11, 16; §4.11; §4.12; §10.3):
 *   cache/<repoKey>/snapshot.json   wire snapshot + client `fetchedAt`, serverTime-guarded atomic write
 *   cache/<repoKey>/digest.md, statusline.txt, ancestry.json, state.json
 *   current/<pid>.json              live-session lookup for MCP and the status line
 *   sessions/<sid>/pending          change-set ids with undelivered dependents (§4.4)
 * Ages are same-clock differences: (serverTime - item.serverAt) + (now - fetchedAt).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readBreaker, type BreakerState } from './breaker.js';
import { hasMark, sessionDir, writePending } from './journal.js';
import { renderStatusline } from './notes.js';
import {
  CACHE_FILES,
  LOCAL_PATHS,
  STALENESS,
  isCachedSnapshot,
  isCurrentFile,
  isRecord,
  type AncestryFile,
  type CachedSnapshot,
  type CurrentFile,
  type IsoTime,
  type RepoKey,
  type RepoStateFile,
  type Snapshot,
  type SnapshotChangeSet,
  type StalenessTier,
} from './protocol.js';
import { ensureDir, hhmm, humanAge, mtimeMs, nowIso, parseIso, readJson, readText, removeFile, writeAtomic, writeJsonAtomic } from './util.js';

export function cacheDir(home: string, key: RepoKey): string {
  return join(home, LOCAL_PATHS.cacheDir, key);
}

export function snapshotPath(home: string, key: RepoKey): string {
  return join(cacheDir(home, key), CACHE_FILES.snapshot);
}

export function statuslinePath(home: string, key: RepoKey): string {
  return join(cacheDir(home, key), CACHE_FILES.statusline);
}

export function readSnapshot(home: string, key: RepoKey): CachedSnapshot | null {
  const v = readJson(snapshotPath(home, key));
  return isCachedSnapshot(v) ? v : null;
}

export interface WriteSnapshotResult {
  written: boolean;
  /** the incoming serverTime was older than the cached one (slow response) */
  stale: boolean;
}

/**
 * Atomic write, only when the incoming `serverTime` >= the cached one (§4.0
 * rule 8). Also renders statusline.txt. Returns what happened.
 */
export function writeSnapshot(home: string, key: RepoKey, snapshot: Snapshot, opts: { now?: number; myDev?: string } = {}): WriteSnapshotResult {
  const now = opts.now ?? Date.now();
  const cached = readSnapshot(home, key);
  const incoming = parseIso(snapshot.serverTime);
  const current = cached ? parseIso(cached.serverTime) : null;
  if (incoming === null) return { written: false, stale: false };
  if (current !== null && incoming < current) return { written: false, stale: true };
  const doc: CachedSnapshot = { ...snapshot, fetchedAt: nowIso(now) };
  ensureDir(cacheDir(home, key));
  const written = writeJsonAtomic(snapshotPath(home, key), doc);
  if (written) writeAtomic(statuslinePath(home, key), renderStatusline(doc, { now, myDev: opts.myDev ?? doc.me.dev }) + '\n');
  return { written, stale: false };
}

/** Age of the cache by the client clock: now - fetchedAt. */
export function snapshotAgeMs(snapshot: Pick<CachedSnapshot, 'fetchedAt'> | null, now: number = Date.now()): number | null {
  if (!snapshot) return null;
  const f = parseIso(snapshot.fetchedAt);
  return f === null ? null : Math.max(0, now - f);
}

/** Age of a hub-stamped item (rule 16): (serverTime - serverAt) + (now - fetchedAt); null when unparseable. */
export function itemAgeMs(snapshot: Pick<CachedSnapshot, 'serverTime' | 'fetchedAt'>, serverAt: IsoTime | null | undefined, now: number = Date.now()): number | null {
  const st = parseIso(snapshot.serverTime);
  const at = parseIso(serverAt);
  const f = parseIso(snapshot.fetchedAt);
  if (st === null || at === null || f === null) return null;
  return Math.max(0, st - at) + Math.max(0, now - f);
}

/** Hub-clock "now" as seen from the cache: serverTime + (now - fetchedAt). Used to test `expiresAt` without trusting the local clock. */
export function hubNowMs(snapshot: Pick<CachedSnapshot, 'serverTime' | 'fetchedAt'>, now: number = Date.now()): number | null {
  const st = parseIso(snapshot.serverTime);
  const f = parseIso(snapshot.fetchedAt);
  if (st === null || f === null) return null;
  return st + Math.max(0, now - f);
}

/** Staleness ladder tier (§6.5). */
export function stalenessTier(ageMs: number | null, breakerOpen: boolean): StalenessTier {
  if (breakerOpen) return 'offline';
  if (ageMs === null) return 'stale';
  if (ageMs <= STALENESS.fullPolicyMs) return 'fresh';
  if (ageMs <= STALENESS.degradedMs) return 'degraded';
  return 'stale';
}

/** Label per §6.5; null when fresh. */
export function stalenessLabel(tier: StalenessTier, snapshot: Pick<CachedSnapshot, 'serverTime'> | null, breakerSinceMs: number | null): string | null {
  const asOf = snapshot ? hhmm(snapshot.serverTime) : '??:??Z';
  switch (tier) {
    case 'fresh':
      return null;
    case 'degraded':
      return `(presence as of ${asOf})`;
    case 'stale':
      return `(presence as of ${asOf}; not refreshed)`;
    case 'offline':
      return `(Relay hub unreachable since ${breakerSinceMs !== null ? hhmm(breakerSinceMs) : asOf})`;
  }
}

export interface CacheFreshness {
  tier: StalenessTier;
  label: string | null;
  ageMs: number | null;
  breaker: BreakerState;
}

/** Tier + label + breaker in one call for the sync hooks. */
export function freshnessOf(home: string, snapshot: CachedSnapshot | null, now: number = Date.now()): CacheFreshness {
  const breaker = readBreaker(home, now);
  const ageMs = snapshotAgeMs(snapshot, now);
  const tier = stalenessTier(ageMs, breaker.open);
  return { tier, label: stalenessLabel(tier, snapshot, breaker.sinceMs), ageMs, breaker };
}

// ---------------------------------------------------------------------------
// digest.md, ancestry.json, state.json
// ---------------------------------------------------------------------------

export function writeDigest(home: string, key: RepoKey, digest: string): boolean {
  return writeAtomic(join(cacheDir(home, key), CACHE_FILES.digest), digest);
}

/** Cached digest and its age (for the fail-open SessionStart path, §4.1). */
export function readDigest(home: string, key: RepoKey, now: number = Date.now()): { digest: string; ageMs: number; ageLabel: string } | null {
  const path = join(cacheDir(home, key), CACHE_FILES.digest);
  const digest = readText(path);
  if (digest === null) return null;
  const ageMs = Math.max(0, now - (mtimeMs(path) ?? now));
  return { digest, ageMs, ageLabel: humanAge(ageMs) };
}

export function isAncestryFile(x: unknown): x is AncestryFile {
  return isRecord(x) && typeof x['headSha'] === 'string' && isRecord(x['contains']) && isRecord(x['merged']);
}

export function readAncestry(home: string, key: RepoKey): AncestryFile | null {
  const v = readJson(join(cacheDir(home, key), CACHE_FILES.ancestry));
  return isAncestryFile(v) ? v : null;
}

export function writeAncestry(home: string, key: RepoKey, file: AncestryFile): boolean {
  return writeJsonAtomic(join(cacheDir(home, key), CACHE_FILES.ancestry), file);
}

export function isRepoStateFile(x: unknown): x is RepoStateFile {
  return isRecord(x) && x['v'] === 1 && isRecord(x['lastReportedSha']);
}

export function readRepoState(home: string, key: RepoKey): RepoStateFile {
  const v = readJson(join(cacheDir(home, key), CACHE_FILES.state));
  return isRepoStateFile(v) ? v : { v: 1, lastReportedSha: {}, depindexHead: null, depindexAt: null };
}

/** Rewritten only by a worker holding bg/<job>.<repoKey>.lock (§10.3). */
export function writeRepoState(home: string, key: RepoKey, state: RepoStateFile): boolean {
  return writeJsonAtomic(join(cacheDir(home, key), CACHE_FILES.state), state);
}

// ---------------------------------------------------------------------------
// pending (§4.4)
// ---------------------------------------------------------------------------

/** Change sets with dependents in this repo and no `jit` mark yet, for one session. */
export function pendingChangeSets(snapshot: Pick<Snapshot, 'changeSets'>, sessionDirPath: string): SnapshotChangeSet[] {
  return snapshot.changeSets.filter((cs) => cs.dependents.length > 0 && !hasMark(sessionDirPath, 'jit', cs.id) && !hasMark(sessionDirPath, 'seen', cs.id));
}

/** Rewrite sessions/<sid>/pending from the snapshot (deleted when empty). */
export function derivePending(home: string, sessionId: string, snapshot: Pick<Snapshot, 'changeSets'>): string[] {
  const dir = sessionDir(home, sessionId);
  const ids = pendingChangeSets(snapshot, dir).map((cs) => cs.id);
  writePending(dir, ids);
  return ids;
}

/** Snapshot write + statusline + pending in one call (what every snapshot-bearing response does, §4.0 rule 8). */
export function applySnapshot(
  home: string,
  key: RepoKey,
  snapshot: Snapshot,
  opts: { sessionId?: string | null; now?: number; myDev?: string } = {},
): WriteSnapshotResult & { pending: string[] } {
  const result = writeSnapshot(home, key, snapshot, opts);
  let pending: string[] = [];
  if (opts.sessionId) {
    const effective = result.written ? snapshot : (readSnapshot(home, key) ?? snapshot);
    pending = derivePending(home, opts.sessionId, effective);
  }
  return { ...result, pending };
}

// ---------------------------------------------------------------------------
// current/<pid>.json (§4.0 rule 11, §9.1)
// ---------------------------------------------------------------------------

export function currentDir(home: string): string {
  return join(home, LOCAL_PATHS.currentDir);
}

export function currentPath(home: string, pid: number): string {
  return join(currentDir(home), `${pid}.json`);
}

export function writeCurrentFile(home: string, file: CurrentFile): boolean {
  return writeJsonAtomic(currentPath(home, file.pid), file);
}

export function readCurrentFile(home: string, pid: number): CurrentFile | null {
  const v = readJson(currentPath(home, pid));
  return isCurrentFile(v) ? v : null;
}

/** Every current/*.json, newest `at` first. */
export function listCurrentFiles(home: string): CurrentFile[] {
  let names: string[];
  try {
    names = readdirSync(currentDir(home)).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: CurrentFile[] = [];
  for (const n of names) {
    const v = readJson(join(currentDir(home), n));
    if (isCurrentFile(v)) out.push(v);
  }
  return out.sort((a, b) => (parseIso(b.at) ?? 0) - (parseIso(a.at) ?? 0));
}

export function removeCurrentFile(home: string, pid: number): boolean {
  return removeFile(currentPath(home, pid));
}

/** `process.kill(pid, 0)` liveness probe; EPERM counts as alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Build the liveness file for this hook invocation. */
export function makeCurrentFile(input: { home: string; pid: number; sessionId: string; cwd: string; repoKey: RepoKey; dev: string; now?: number }): CurrentFile {
  return {
    v: 1,
    sessionId: input.sessionId,
    cwd: input.cwd,
    repoKey: input.repoKey,
    dev: input.dev,
    at: nowIso(input.now ?? Date.now()),
    statusline: statuslinePath(input.home, input.repoKey),
    pid: input.pid,
  };
}
