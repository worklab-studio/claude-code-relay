/**
 * Per-machine mutes, `~/.relay/mute/<repoKey>.json` (§5.4, §9.2 /relay:mute).
 * Kind inference: `@dev` -> dev, wildcard -> glob, a configured area name ->
 * area, else path.
 */
import { join } from 'node:path';
import { isGlobPattern } from './glob.js';
import { LOCAL_PATHS, isRecord, type MuteFile, type MuteTarget, type RelayArea, type RepoKey } from './protocol.js';
import { nowIso, readJson, writeJsonAtomic } from './util.js';

export function mutePath(home: string, key: RepoKey): string {
  return join(home, LOCAL_PATHS.muteDir, `${key}.json`);
}

export function isMuteFile(x: unknown): x is MuteFile {
  return isRecord(x) && x['v'] === 1 && Array.isArray(x['targets']);
}

export function readMutes(home: string, key: RepoKey): MuteTarget[] {
  const v = readJson(mutePath(home, key));
  if (!isMuteFile(v)) return [];
  return v.targets.filter((t): t is MuteTarget => isRecord(t) && typeof t['target'] === 'string' && typeof t['kind'] === 'string');
}

/** Classify a `/relay:mute` argument. */
export function muteKind(target: string, areas: Record<string, RelayArea> = {}): MuteTarget['kind'] {
  if (target.startsWith('@')) return 'dev';
  if (areas[target]) return 'area';
  if (isGlobPattern(target)) return 'glob';
  return 'path';
}

export function addMute(home: string, key: RepoKey, target: string, areas: Record<string, RelayArea> = {}, now: number = Date.now()): MuteTarget[] {
  const t = target.trim();
  const current = readMutes(home, key).filter((m) => m.target !== t);
  const next = [...current, { target: t, kind: muteKind(t, areas), at: nowIso(now) }];
  writeJsonAtomic(mutePath(home, key), { v: 1, targets: next } satisfies MuteFile, true);
  return next;
}

export function removeMute(home: string, key: RepoKey, target: string): MuteTarget[] {
  const t = target.trim();
  const next = readMutes(home, key).filter((m) => m.target !== t);
  writeJsonAtomic(mutePath(home, key), { v: 1, targets: next } satisfies MuteFile, true);
  return next;
}
