import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMute, hasMark, listMarks, markKey, readAskedMark, recordWorkerFailure, snoozeUntil, writeSnapshot, type Snapshot } from '@relay/core';
import { T0, iso, makeChangeSet, makeHeat, makeRuntime, makeSession, makeSnapshot, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { runPreEdit } from './pre-edit.js';
import { runPostEdit } from './post-edit.js';

const SID = 'sess-pre-edit';
const FILE = 'packages/contracts/src/billing.ts';

function hotSnapshot(now: number, extra: Partial<Snapshot> = {}): Snapshot {
  return makeSnapshot(now, {
    me: { dev: 'deepak', sessionId: SID },
    sessions: [makeSession('priya', { lastSeenAt: iso(now - 20_000), lastEditAt: iso(now - 30_000) })],
    heat: [makeHeat('priya', FILE, { at: iso(now - 30_000), count: 6 })],
    ...extra,
  });
}

describe('pre-edit', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = join(home, 'repo');
    mkdirSync(join(repo, 'packages/contracts/src'), { recursive: true });
    writeFileSync(join(repo, FILE), 'export interface Invoice {}\n');
  });
  afterEach(() => cleanup());

  it('HOT with a live teammate: ask once, context on the next call, asked mark created first', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, hotSnapshot(now), { now });
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    const out = await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect(out?.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' });
    const hso = out?.hookSpecificOutput as Record<string, string>;
    expect(hso['permissionDecisionReason']).toMatch(/^Relay: priya is editing packages\/contracts\/src\/billing\.ts/);
    expect(hso['additionalContext']).toMatch(/^Relay at \d\d:\d\d:\d\dZ: priya \(feat\/currency\) has 6 edits/);
    expect(hso['additionalContext']).not.toMatch(/coordinate|please|must/i);
    const key = markKey(FILE, 'priya');
    expect(readAskedMark(join(home, 'sessions', SID), key)?.toolUseId).toBe('toolu_01');

    // second call within 2 min: context only (asked-recently)
    const { rt: rt2 } = makeRuntime(home, 'pre-edit', { now: () => now + 5_000 });
    const out2 = await runPreEdit(rt2, stdin.preEdit(SID, repo, join(repo, FILE)));
    const hso2 = out2?.hookSpecificOutput as Record<string, string>;
    expect(hso2['permissionDecision']).toBeUndefined();
    expect(hso2['additionalContext']).toContain('priya');
  });

  it('the landing edit promotes asked -> snooze, later edits get context only', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, hotSnapshot(now), { now });
    const dir = join(home, 'sessions', SID);
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect(listMarks(dir, 'asked')).toHaveLength(1);
    const post = makeRuntime(home, 'post-edit', {
      now: () => now + 1000,
      git: { gitDiffU0: async () => '', gitHashObject: async () => null, findDependents: async () => [] },
      handle: () => 'network-error',
    });
    await runPostEdit(post.rt, stdin.postEdit(SID, repo, join(repo, FILE)));
    expect(listMarks(dir, 'asked')).toHaveLength(0);
    expect(snoozeUntil(dir, markKey(FILE, 'priya'), now + 1000)).toBeGreaterThan(now + 1000);
    // 10 minutes later, still snoozed: no ask
    const { rt: rt3 } = makeRuntime(home, 'pre-edit', { now: () => now + 600_000 });
    const out3 = await runPreEdit(rt3, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect((out3?.hookSpecificOutput as Record<string, string>)['permissionDecision']).toBeUndefined();
  });

  it('never asks from a stale snapshot (staleness ladder) and labels the context', async () => {
    const meta = seedMeta(home, SID, repo);
    // fetched 10 minutes ago: degraded tier -> ask becomes context
    writeSnapshot(home, meta.repoKey, hotSnapshot(now - 600_000), { now: now - 600_000 });
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    const out = await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    const hso = out?.hookSpecificOutput as Record<string, string>;
    expect(hso['permissionDecision']).toBeUndefined();
    expect(hso['additionalContext']).toMatch(/\(presence as of \d\d:\d\dZ\)/);
  });

  it('breaker open: context only with the unreachable label', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, hotSnapshot(now), { now });
    recordWorkerFailure(home, now);
    recordWorkerFailure(home, now);
    const { rt, spawned } = makeRuntime(home, 'pre-edit', { now: () => now + 1000 });
    const out = await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    const hso = out?.hookSpecificOutput as Record<string, string>;
    expect(hso['permissionDecision']).toBeUndefined();
    expect(hso['additionalContext']).toMatch(/Relay hub unreachable since/);
    expect(spawned).toHaveLength(0); // no refresh while the breaker is open
  });

  it('hard claim -> deny with the claim facts; dontAsk downgrades ask but not deny', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(
      home,
      meta.repoKey,
      makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID }, claims: [{ id: 'clm_1', dev: 'priya', target: 'packages/contracts/**', note: 'migrating billing', hard: true, expiresAt: iso(now + 3_600_000) }] }),
      { now },
    );
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    const out = await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE), { permission_mode: 'dontAsk' }));
    const hso = out?.hookSpecificOutput as Record<string, string>;
    expect(hso['permissionDecision']).toBe('deny');
    expect(hso['permissionDecisionReason']).toContain("priya's hard claim");
    expect(hso['permissionDecisionReason']).toContain('clm_1');

    // HOT under dontAsk -> context only
    writeSnapshot(home, meta.repoKey, hotSnapshot(now + 1), { now: now + 1 });
    const { rt: rt2 } = makeRuntime(home, 'pre-edit', { now: () => now + 2 });
    const out2 = await runPreEdit(rt2, stdin.preEdit(SID, repo, join(repo, FILE), { permission_mode: 'dontAsk' }));
    expect((out2?.hookSpecificOutput as Record<string, string>)['permissionDecision']).toBeUndefined();
    expect((out2?.hookSpecificOutput as Record<string, string>)['additionalContext']).toContain('priya');
  });

  it('subagents and sdk-cli entrypoints get context only', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, hotSnapshot(now), { now });
    const a = makeRuntime(home, 'pre-edit', { now: () => now });
    const out = await runPreEdit(a.rt, stdin.preEdit(SID, repo, join(repo, FILE), { agent_id: 'a9f0', agent_type: 'general-purpose' }));
    expect((out?.hookSpecificOutput as Record<string, string>)['permissionDecision']).toBeUndefined();
    const b = makeRuntime(home, 'pre-edit', { now: () => now, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
    const out2 = await runPreEdit(b.rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect((out2?.hookSpecificOutput as Record<string, string>)['permissionDecision']).toBeUndefined();
    expect(listMarks(join(home, 'sessions', SID), 'asked')).toHaveLength(0);
  });

  it('paths outside the repo, muted targets and a missing snapshot print nothing', async () => {
    const meta = seedMeta(home, SID, repo);
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    expect(await runPreEdit(rt, stdin.preEdit(SID, repo, '/etc/hosts'))).toBeNull();
    expect(await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)))).toBeNull(); // no snapshot
    writeSnapshot(home, meta.repoKey, hotSnapshot(now), { now });
    addMute(home, meta.repoKey, '@priya', {}, now);
    expect(await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)))).toBeNull();
  });

  it('WARM/SEQUENTIAL/SAME_DEV notes are emitted once per path per session', async () => {
    const meta = seedMeta(home, SID, repo);
    const snap = makeSnapshot(now, {
      me: { dev: 'deepak', sessionId: SID },
      sessions: [makeSession('priya', { state: 'idle', lastSeenAt: iso(now - 3_600_000) })],
      heat: [makeHeat('priya', FILE, { at: iso(now - 3_600_000) })],
    });
    writeSnapshot(home, meta.repoKey, snap, { now });
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    const out = await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect((out?.hookSpecificOutput as Record<string, string>)['additionalContext']).toMatch(/not in this branch yet/);
    expect(await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)))).toBeNull();
    expect(hasMark(join(home, 'sessions', SID), 'noted', markKey(FILE, 'priya'))).toBe(true);
  });

  it('JIT change-set note for a dependent path, once, with the hunk and the jit mark', async () => {
    const meta = seedMeta(home, SID, repo);
    const dep = 'apps/dashboard/src/invoices.tsx';
    mkdirSync(join(repo, 'apps/dashboard/src'), { recursive: true });
    const snap = makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID }, changeSets: [makeChangeSet('cs_01J1', [dep]), makeChangeSet('cs_01J2', ['apps/app/src/other.ts'], { priority: 'normal' })] });
    writeSnapshot(home, meta.repoKey, snap, { now });
    const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
    const out = await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, dep)));
    const ctx = (out?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    expect(ctx).toContain('IMPACT cs_01J1');
    expect(ctx).toContain('```diff');
    expect(ctx).not.toContain('cs_01J2');
    expect(ctx.length).toBeLessThanOrEqual(4000);
    expect(hasMark(join(home, 'sessions', SID), 'jit', 'cs_01J1')).toBe(true);
    expect(await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, dep)))).toBeNull();
  });

  it('spawns bg refresh when the cache is older than 120 s and writes refresh-wanted', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, makeSnapshot(now - 300_000, { me: { dev: 'deepak', sessionId: SID } }), { now: now - 300_000 });
    const { rt, spawned } = makeRuntime(home, 'pre-edit', { now: () => now });
    await runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect(spawned).toEqual([{ job: 'refresh', args: ['--session', SID, '--cwd', repo] }]);
    // debounce: a second hook within 10 s does not spawn again
    const { rt: rt2, spawned: s2 } = makeRuntime(home, 'pre-edit', { now: () => now + 2000 });
    await runPreEdit(rt2, stdin.preEdit(SID, repo, join(repo, FILE)));
    expect(s2).toHaveLength(0);
  });

  it('eight parallel pre-edits on a HOT file produce exactly one ask', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, hotSnapshot(now), { now });
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => {
        const { rt } = makeRuntime(home, 'pre-edit', { now: () => now });
        return runPreEdit(rt, stdin.preEdit(SID, repo, join(repo, FILE)));
      }),
    );
    const asks = runs.filter((o) => (o?.hookSpecificOutput as Record<string, string>)['permissionDecision'] === 'ask');
    expect(asks).toHaveLength(1);
    expect(runs.every((o) => o !== null)).toBe(true);
  });
});
