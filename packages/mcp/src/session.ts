/**
 * Live session resolution, per tool call (§9.1 v1.1): a stdio MCP server sees
 * CLAUDE_CODE_SESSION_ID frozen at spawn, which is wrong after `/clear`, so
 * every call re-reads `$RELAY_HOME/current/<process.ppid>.json` (Claude Code
 * is the parent because mcp.sh `exec`s node; every hook rewrites that file),
 * then the newest `current/*.json` whose cwd matches the server's cwd, then
 * the env var.
 */
import { isPidAlive, listCurrentFiles, readCurrentFile, realpathBestEffort, type CurrentFile, type WhoamiResult } from '@relay/core';

export type SessionSource = WhoamiResult['sessionSource'];

export interface LiveSession {
  sessionId: string | null;
  source: SessionSource;
  /** the current/<pid>.json that resolved the session, when one did */
  current: CurrentFile | null;
}

export interface ResolveSessionInput {
  home: string;
  /** process.ppid in production; injectable for tests */
  ppid: number;
  cwd: string;
  /** CLAUDE_CODE_SESSION_ID as seen at spawn */
  envSessionId: string | null;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => realpathBestEffort(p).replace(/[\\/]+$/, '');
  return norm(a) === norm(b);
}

function under(child: string, parent: string): boolean {
  const c = realpathBestEffort(child).replace(/[\\/]+$/, '');
  const p = realpathBestEffort(parent).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + '/');
}

export function resolveLiveSession(input: ResolveSessionInput): LiveSession {
  const own = readCurrentFile(input.home, input.ppid);
  if (own) return { sessionId: own.sessionId, source: 'current-file', current: own };

  // newest first (listCurrentFiles sorts by `at`); dead pids are skipped so a
  // crashed session's file does not shadow the live one until the sweep runs
  const files = listCurrentFiles(input.home).filter((f) => isPidAlive(f.pid));
  const exact = files.find((f) => samePath(f.cwd, input.cwd));
  if (exact) return { sessionId: exact.sessionId, source: 'cwd-match', current: exact };
  // a session that `/cd`-ed into a subdirectory of the project, or the server
  // spawned in a subdirectory of the session's cwd
  const nested = files.find((f) => under(f.cwd, input.cwd) || under(input.cwd, f.cwd));
  if (nested) return { sessionId: nested.sessionId, source: 'cwd-match', current: nested };

  if (input.envSessionId) return { sessionId: input.envSessionId, source: 'env', current: null };
  return { sessionId: null, source: 'none', current: null };
}
