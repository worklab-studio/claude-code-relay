/**
 * PreToolUse Edit|Write|MultiEdit|NotebookEdit → verb `pre-edit` (§4.3, §6.4,
 * §6.5). Local cache only: no git (rule 10 heals meta with rev-parse once),
 * no network (a stale cache spawns `bg refresh`). Severity → deny/ask/context
 * through the staleness ladder; `asked` marks are created before an ask; JIT
 * change-set notes for dependents of the path (top 2, ≤ 4,000 chars).
 */
import {
  LIMITS,
  areasOfPath,
  assessCollision,
  createMark,
  editToolPath,
  freshnessOf,
  hasMark,
  isGlobPattern,
  matchGlob,
  markAgeMs,
  markKey,
  readAncestry,
  readMutes,
  readSnapshot,
  renderAskReason,
  renderChangeSetNote,
  renderCollisionContext,
  renderDenyReason,
  shouldSpawnRefresh,
  snoozeUntil,
  toRepoRelative,
  writeRefreshWanted,
  type AskedMark,
  type CachedSnapshot,
  type HookOutput,
  type PreToolUseInput,
  type SnapshotChangeSet,
} from '@relay/core';
import type { HookRuntime } from '../runtime.js';
import { output, prepareSession, type SessionContext } from '../session.js';

/** Change sets whose dependents include the path or one of its enclosing areas, top 2 by priority then recency (§4.3 step 4). */
export function jitCandidates(snapshot: CachedSnapshot, dir: string, rel: string, areas: Record<string, { paths: string[] }>): SnapshotChangeSet[] {
  const pathAreas = new Set(areasOfPath(rel, areas as Record<string, { paths: string[]; owners?: string[]; shared?: boolean }>));
  const rank = { high: 0, normal: 1, low: 2 } as const;
  // `jit` marks alone gate the just-in-time note (§4.3 step 4): a change set shown in the digest still earns its note at edit time.
  return snapshot.changeSets
    .filter((cs) => cs.dependents.length > 0 && !hasMark(dir, 'jit', cs.id))
    .filter((cs) =>
      cs.dependents.some(
        (d) =>
          d.path === rel ||
          (d.area !== null && pathAreas.has(d.area)) ||
          // a `depends`-derived dependent carries the area's first glob as its path (hub note)
          ((d.via === 'depends' || isGlobPattern(d.path)) && matchGlob(d.path, rel)),
      ),
    )
    .sort((a, b) => rank[a.priority] - rank[b.priority] || (b.at < a.at ? -1 : b.at > a.at ? 1 : 0))
    .slice(0, LIMITS.jitChangeSetsPerHook);
}

/** JIT notes with `wx` marks created before printing; the merged flag comes from ancestry.json. */
export function renderJitNotes(rt: HookRuntime, ctx: Pick<SessionContext, 'dir' | 'key'>, candidates: SnapshotChangeSet[], budget: number): string[] {
  const merged = readAncestry(rt.home, ctx.key)?.merged ?? {};
  const notes: string[] = [];
  let used = 0;
  for (const cs of candidates) {
    if (used >= budget) break;
    if (createMark(ctx.dir, 'jit', cs.id) !== 'created') continue;
    const note = renderChangeSetNote(cs, { withHunk: true, merged: merged[cs.id], now: rt.now(), maxChars: Math.max(200, budget - used) });
    notes.push(note);
    used += note.length + 2;
  }
  return notes;
}

export async function runPreEdit(rt: HookRuntime, input: PreToolUseInput): Promise<HookOutput | null> {
  const filePath = editToolPath(input.tool_input);
  if (!filePath) return null;
  const ctx = await prepareSession(rt, input);
  const rel = toRepoRelative(filePath, ctx.meta.repoRoot, ctx.cwd);
  if (!rel) return null; // outside the repo
  const mutes = readMutes(rt.home, ctx.key);
  const areas = ctx.config.resolved.areas;
  const snap = readSnapshot(rt.home, ctx.key);
  const fresh = freshnessOf(rt.home, snap, rt.now());
  if (shouldSpawnRefresh(rt.home, fresh.ageMs, rt.now())) {
    writeRefreshWanted(rt.home);
    rt.spawnBg('refresh', ['--session', ctx.sessionId, '--cwd', ctx.cwd]);
  }

  const now = rt.now();
  const verdict = assessCollision({
    path: rel,
    me: { dev: ctx.meta.dev, sessionId: ctx.sessionId, branch: ctx.meta.branch, worktree: ctx.meta.worktree },
    snapshot: snap,
    ancestry: readAncestry(rt.home, ctx.key),
    policy: ctx.config.resolved.collision,
    areas,
    breaker: fresh.breaker,
    interactive: ctx.interactive && !ctx.inSubagent,
    mutes,
    now,
    marks: (other) => {
      const k = markKey(rel, other);
      return { askedAgeMs: markAgeMs(ctx.dir, 'asked', k, now), snoozeUntilMs: snoozeUntil(ctx.dir, k, now), noted: hasMark(ctx.dir, 'noted', k) };
    },
  });
  if (verdict.downgrades.length) rt.log(`${rel}: ${verdict.severity} -> ${verdict.decision} (${verdict.downgrades.join(', ')})`);

  const pieces: string[] = [];
  let decision: 'ask' | 'deny' | null = null;
  let reason: string | undefined;
  const otherDev = verdict.other?.dev ?? null;
  if (verdict.decision === 'deny') {
    decision = 'deny';
    reason = renderDenyReason(verdict, now);
    pieces.push(renderCollisionContext(verdict, now));
  } else if (verdict.decision === 'ask' && otherDev) {
    const key = markKey(rel, otherDev);
    const mark: AskedMark = { toolUseId: input.tool_use_id ?? null, at: new Date(now).toISOString(), path: rel, dev: otherDev };
    // §4.3 step 5: the `asked` mark must exist before the prompt; EEXIST means a parallel hook already asked.
    if (verdict.createAsked && createMark(ctx.dir, 'asked', key, JSON.stringify(mark)) === 'created') {
      decision = 'ask';
      reason = renderAskReason(verdict);
    }
    pieces.push(renderCollisionContext(verdict, now));
  } else if ((verdict.decision === 'context' || verdict.decision === 'note') && otherDev) {
    const key = markKey(rel, otherDev);
    if (!verdict.createNoted || createMark(ctx.dir, 'noted', key) === 'created') pieces.push(renderCollisionContext(verdict, now));
  }

  // JIT impact notes for dependents of this path (§4.3 step 4)
  if (snap) {
    const budget = LIMITS.preToolUseContextChars - pieces.join('\n\n').length - 4;
    if (budget > 200) pieces.push(...renderJitNotes(rt, ctx, jitCandidates(snap, ctx.dir, rel, areas), budget));
  }
  const context = pieces.filter(Boolean).join('\n\n').slice(0, LIMITS.preToolUseContextChars);
  if (!decision && !context) return null;
  return output({
    hookEventName: 'PreToolUse',
    ...(decision ? { permissionDecision: decision, permissionDecisionReason: reason } : {}),
    ...(context ? { additionalContext: context } : {}),
  });
}
