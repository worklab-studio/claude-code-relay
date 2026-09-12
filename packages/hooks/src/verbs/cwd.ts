/**
 * CwdChanged → verb `cwd` (§4.7, §4.0 rule 10). When `new_cwd` leaves the
 * current repo root the meta is rebuilt (three rev-parse calls, ≤ 300 ms),
 * a `cwd` journal line and WAL event record the move, and the RELAY_*
 * exports are re-appended (CwdChanged clears earlier dynamic exports).
 */
import { relative } from 'node:path';
import { appendJournal, makeEvent, nowIso, readMeta, sessionDir, toPosix, writeOutbox, type CwdChangedInput, type CwdEvent, type HookOutput } from '@relay/core';
import type { HookRuntime } from '../runtime.js';
import { appendEnvExports, buildPresence, hubConfigured, prepareSession } from '../session.js';

export async function runCwd(rt: HookRuntime, input: CwdChangedInput): Promise<HookOutput | null> {
  const to = typeof input.new_cwd === 'string' && input.new_cwd ? input.new_cwd : input.cwd;
  const from = typeof input.old_cwd === 'string' ? input.old_cwd : input.cwd;
  const before = readMeta(sessionDir(rt.home, input.session_id));
  const ctx = await prepareSession(rt, input, { cwd: to });
  appendEnvExports(rt, ctx.meta);
  const now = rt.now();
  const movedRepo = !before || before.repoRoot !== ctx.meta.repoRoot || before.repo !== ctx.meta.repo;
  if (!movedRepo && !ctx.healed) {
    // Still inside the same repo: keep meta.cwd honest for the area tie-breaker without a lock-guarded rewrite storm.
    return null;
  }
  appendJournal(ctx.dir, { t: 'cwd', at: nowIso(now), from, to });
  if (!hubConfigured(rt)) return null;
  // on the wire both ends are repo-relative (the old root for `from`); absolute paths carry the OS user name (§11.1)
  const rel = (root: string, abs: string): string => {
    try {
      return toPosix(relative(root, abs));
    } catch {
      return '';
    }
  };
  const event = makeEvent<CwdEvent>({ type: 'cwd', from: rel(before?.repoRoot ?? ctx.meta.repoRoot, from), to: rel(ctx.meta.repoRoot, to), repo: ctx.meta.repo, branch: ctx.meta.branch }, now);
  writeOutbox(rt.home, {
    sessionId: ctx.sessionId,
    kind: 'events',
    endpoint: '/v1/events',
    body: { session: buildPresence(rt, ctx), events: [event] },
    now,
  });
  rt.log(`cwd moved ${from} -> ${to} (repo ${ctx.meta.repo})`);
  return null;
}
