/**
 * Debug log and per-event hook counters (§4.0 rule 4, §4.3 step 6, §9.2 whoami):
 *   log/relay.log    appended only with RELAY_DEBUG=1
 *   log/stats.jsonl  one line per hook run, read by /relay:doctor and whoami
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_PATHS, isRecord, type StatsLine } from './protocol.js';
import { ensureDir, nowIso, parseIso } from './util.js';

/** Append a debug line (never throws; no-op unless enabled). Also mirrors to stderr when `stderr` is true (hooks' stderr goes to Claude Code's debug log on exit 0). */
export function debugLog(home: string, enabled: boolean, verb: string, message: string, opts: { stderr?: boolean; now?: number } = {}): void {
  if (!enabled) return;
  const line = `${nowIso(opts.now ?? Date.now())} [${process.pid}] ${verb}: ${message}\n`;
  try {
    ensureDir(join(home, LOCAL_PATHS.logDir));
    appendFileSync(join(home, LOCAL_PATHS.log), line);
  } catch {
    /* ignore */
  }
  if (opts.stderr) {
    try {
      process.stderr.write(line);
    } catch {
      /* ignore */
    }
  }
}

/** Append one stats line (O_APPEND; never throws). */
export function appendStats(home: string, line: StatsLine): boolean {
  try {
    ensureDir(join(home, LOCAL_PATHS.logDir));
    appendFileSync(join(home, LOCAL_PATHS.stats), JSON.stringify(line) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function isStatsLine(x: unknown): x is StatsLine {
  return isRecord(x) && typeof x['at'] === 'string' && typeof x['event'] === 'string' && typeof x['verb'] === 'string' && typeof x['ms'] === 'number';
}

/** Read the tail of stats.jsonl (last `maxBytes`), newest last. */
export function readStats(home: string, maxBytes = 256 * 1024): StatsLine[] {
  let text: string;
  try {
    const buf = readFileSync(join(home, LOCAL_PATHS.stats));
    text = buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch {
    return [];
  }
  const out: StatsLine[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]?.trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (isStatsLine(v)) out.push(v);
    } catch {
      /* a cut first line or a partial write */
    }
  }
  return out;
}

/** `whoami.hookCounts`: per event since `sinceMs` (default 24 h), optionally for one session. */
export function hookCounts(home: string, opts: { sinceMs?: number; sessionId?: string | null; now?: number } = {}): Record<string, number> {
  const now = opts.now ?? Date.now();
  const since = now - (opts.sinceMs ?? 86_400_000);
  const counts: Record<string, number> = {};
  for (const s of readStats(home)) {
    const at = parseIso(s.at) ?? 0;
    if (at < since) continue;
    if (opts.sessionId && s.sessionId !== opts.sessionId) continue;
    counts[s.event] = (counts[s.event] ?? 0) + 1;
  }
  return counts;
}
