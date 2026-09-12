/**
 * Circuit breaker and refresh markers under $RELAY_HOME (§4.0 rule 5, §10.3):
 *   down-count   consecutive worker failures
 *   down-until   epoch ms; every verb skips the network while it is in the future
 *   config-error.json {status, message, at} for 401 / 426 / 413 (10-min breaker)
 *   refresh-wanted   touched by a sync-path timeout or a stale pre-edit read
 * Only background workers open the breaker; a sync-path timeout never does.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { BREAKER, LOCAL_PATHS, isRecord, type ConfigErrorFile, type IsoTime } from './protocol.js';
import { ensureDir, mtimeMs, nowIso, readJson, readText, removeFile, writeAtomic, writeJsonAtomic } from './util.js';

export interface BreakerState {
  open: boolean;
  /** epoch ms when the breaker closes again; null when closed */
  untilMs: number | null;
  until: IsoTime | null;
  /** epoch ms when the breaker was opened (down-until mtime) */
  sinceMs: number | null;
  count: number;
  configError: ConfigErrorFile | null;
}

function downUntilPath(home: string): string {
  return join(home, LOCAL_PATHS.downUntil);
}
function downCountPath(home: string): string {
  return join(home, LOCAL_PATHS.downCount);
}
function configErrorPath(home: string): string {
  return join(home, LOCAL_PATHS.configError);
}

export function isConfigErrorFile(x: unknown): x is ConfigErrorFile {
  return isRecord(x) && typeof x['status'] === 'number' && typeof x['message'] === 'string' && typeof x['at'] === 'string';
}

/** Read the breaker files (1–2 ms). */
export function readBreaker(home: string, now: number = Date.now()): BreakerState {
  const untilText = readText(downUntilPath(home));
  const untilMs = untilText && /^\d+$/.test(untilText.trim()) ? Number(untilText.trim()) : null;
  const countText = readText(downCountPath(home));
  const count = countText && /^\d+$/.test(countText.trim()) ? Number(countText.trim()) : 0;
  const cfg = readJson(configErrorPath(home));
  const configError = isConfigErrorFile(cfg) ? cfg : null;
  const open = untilMs !== null && untilMs > now;
  return {
    open,
    untilMs: open ? untilMs : null,
    until: open ? nowIso(untilMs as number) : null,
    sinceMs: open ? mtimeMs(downUntilPath(home)) : null,
    count,
    configError,
  };
}

export function breakerOpen(home: string, now: number = Date.now()): boolean {
  return readBreaker(home, now).open;
}

/** A worker POST failed: two consecutive failures open the breaker for 60 s (§4.0 rule 5). Returns the new state. */
export function recordWorkerFailure(home: string, now: number = Date.now()): BreakerState {
  ensureDir(home);
  const count = readBreaker(home, now).count + 1;
  writeAtomic(downCountPath(home), String(count));
  if (count >= BREAKER.failuresToOpen) writeAtomic(downUntilPath(home), String(now + BREAKER.openMs));
  return readBreaker(home, now);
}

/** Any successful hub call resets the count and closes the breaker (config errors included: the fix landed). */
export function recordSuccess(home: string): void {
  removeFile(downCountPath(home));
  removeFile(downUntilPath(home));
  removeFile(configErrorPath(home));
}

/** 401 / 426 / 413: configuration error, 10-min breaker, body not enqueued (§4.0 rule 5). */
export function recordConfigError(home: string, status: number, message: string, now: number = Date.now()): BreakerState {
  ensureDir(home);
  writeAtomic(downUntilPath(home), String(now + BREAKER.configErrorMs));
  writeJsonAtomic(configErrorPath(home), { status, message: message.slice(0, 500), at: nowIso(now) } satisfies ConfigErrorFile);
  return readBreaker(home, now);
}

/** Touch refresh-wanted (sync-path timeout, stale pre-edit read; §4.2 step 2, §4.3 step 2). */
export function writeRefreshWanted(home: string): boolean {
  try {
    ensureDir(home);
    writeFileSync(join(home, LOCAL_PATHS.refreshWanted), String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** Age of refresh-wanted in ms; null when absent. */
export function refreshWantedAgeMs(home: string, now: number = Date.now()): number | null {
  const m = mtimeMs(join(home, LOCAL_PATHS.refreshWanted));
  return m === null ? null : Math.max(0, now - m);
}

export function clearRefreshWanted(home: string): void {
  removeFile(join(home, LOCAL_PATHS.refreshWanted));
}

/** Does pre-edit spawn `bg refresh`? Cache older than 120 s, breaker closed, no refresh-wanted younger than 10 s (§4.3 step 2). */
export function shouldSpawnRefresh(home: string, cacheAgeMs: number | null, now: number = Date.now()): boolean {
  if (cacheAgeMs !== null && cacheAgeMs < BREAKER.preEditRefreshMs) return false;
  if (breakerOpen(home, now)) return false;
  const wanted = refreshWantedAgeMs(home, now);
  return wanted === null || wanted >= BREAKER.refreshWantedDebounceMs;
}
