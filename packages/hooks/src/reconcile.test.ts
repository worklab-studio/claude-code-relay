import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyFold, foldEntries, loadFold, sessionDir, type JournalContract } from '@relay/core';
import { T0, makeRuntime, seedMeta, tmpDir } from '../test/helpers.js';
import { capOutput, parseHookInput } from './io.js';
import { contractCandidatePaths, exportScanEligible, splitDiffByFile, workingTreeContract } from './reconcile.js';
import { parseFlags } from './runtime.js';
import type { SessionContext } from './session.js';

const TWO_FILES = `diff --git a/packages/contracts/src/billing.ts b/packages/contracts/src/billing.ts
index 1111111..2222222 100644
--- a/packages/contracts/src/billing.ts
+++ b/packages/contracts/src/billing.ts
@@ -3,1 +3,2 @@ export interface Invoice {
-  total: number
+  amountDue: number
+  currency: string
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # demo
+more
`;

describe('reconcile helpers', () => {
  it('splitDiffByFile keys hunks by the new path', () => {
    const parts = splitDiffByFile(TWO_FILES);
    expect(Object.keys(parts)).toEqual(['packages/contracts/src/billing.ts', 'README.md']);
    expect(parts['packages/contracts/src/billing.ts']).toContain('+  amountDue: number');
    expect(parts['packages/contracts/src/billing.ts']).not.toContain('+more');
    expect(parts['README.md']).toContain('+more');
    expect(splitDiffByFile(null)).toEqual({});
    expect(splitDiffByFile('--- a/x\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b')).toEqual({ 'x.ts': '+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b' });
  });

  it('contractCandidatePaths keeps contract globs and export-scan-eligible files only', () => {
    const ctx = { config: { resolved: { contracts: { globs: ['**/contracts/**'], export_scan: true }, areas: {} } } } as unknown as SessionContext;
    expect(contractCandidatePaths(ctx, ['packages/contracts/src/a.ts', 'apps/app/x.tsx', 'README.md', 'a.png', 'svc.go', 'm.py'])).toEqual(['packages/contracts/src/a.ts', 'apps/app/x.tsx', 'svc.go', 'm.py']);
    const off = { config: { resolved: { contracts: { globs: ['**/contracts/**'], export_scan: false }, areas: {} } } } as unknown as SessionContext;
    expect(contractCandidatePaths(off, ['packages/contracts/src/a.ts', 'apps/app/x.tsx'])).toEqual(['packages/contracts/src/a.ts']);
    expect(exportScanEligible('x.mjs')).toBe(true);
    expect(exportScanEligible('x.md')).toBe(false);
  });
});

describe('workingTreeContract with injected git', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
  });
  afterEach(() => cleanup());

  function ctxFor(sessionId: string): SessionContext {
    const meta = seedMeta(home, sessionId, repo);
    return { input: null, sessionId, cwd: repo, dir: sessionDir(home, sessionId), meta, healed: false, config: { raw: null, resolved: { ...JSON.parse(JSON.stringify(require_defaults())), project: 'p', repo: meta.repo, areas: {}, depends: {} }, hash: null, path: '', invalid: false }, key: meta.repoKey, interactive: true, inSubagent: false };
  }
  function require_defaults() {
    return { contracts: { globs: ['**/contracts/**'], packages: [], export_scan: true, consumers: {} }, impacts: { debounce_minutes: 3 }, collision: { hot: 'ask', claimed: 'ask', warm: 'context', same_dev: 'note' }, privacy: { send_prompts: false, send_turns: 'prose', send_diffs: 'contracts', objective_from_prompts: true }, handoff: { llm: true, idle_minutes: 20 } };
  }

  it('dependents: null when the grep times out; git failure yields nothing; unchanged hash is skipped', async () => {
    const ctx = ctxFor('s-wt');
    const { rt } = makeRuntime(home, 'post-edit', { now: () => T0, git: { gitHashObject: async () => 'b'.repeat(40), findDependents: async () => null } });
    const diff = splitDiffByFile(TWO_FILES)['packages/contracts/src/billing.ts'] ?? null;
    const r = await workingTreeContract(rt, ctx, 'packages/contracts/src/billing.ts', diff, emptyFold());
    expect(r.event).toMatchObject({ type: 'contract', path: 'packages/contracts/src/billing.ts', dependents: null, blobId: 'b'.repeat(40) });
    expect(r.event?.symbols).toContain('Invoice');
    expect((await workingTreeContract(rt, ctx, 'x.ts', null, emptyFold())).event).toBeNull();
    const fold = loadFold(ctx.dir);
    expect(fold.contracts['packages/contracts/src/billing.ts']?.hash).toBe(r.event?.hash);
    const again = await workingTreeContract(rt, ctx, 'packages/contracts/src/billing.ts', diff, fold);
    expect(again).toEqual({ event: null, retract: null });
    // README is not a contract candidate: no event, and an empty diff without an open record is nothing
    expect(await workingTreeContract(rt, ctx, 'README.md', splitDiffByFile(TWO_FILES)['README.md'] ?? null, fold)).toEqual({ event: null, retract: null });
    expect(await workingTreeContract(rt, ctx, 'README.md', '', fold)).toEqual({ event: null, retract: null });
  });

  it('no retract once an own commit carried the record; a later record can still be retracted', async () => {
    const ctx = ctxFor('s-rc');
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    const rel = 'packages/contracts/src/a.ts';
    const fold = foldEntries(
      [
        { t: 'contract', at: at(0), path: rel, hash: 'h1', blobId: null, symbols: ['A'], kinds: ['export'], eventId: 'e1' },
        { t: 'commit', at: at(1000), sha: 'c'.repeat(40), subject: 'x', files: [rel], contracts: [rel] },
      ],
      emptyFold(),
    );
    const { rt } = makeRuntime(home, 'stop', { now: () => T0 + 2000 });
    expect(await workingTreeContract(rt, ctx, rel, '', fold)).toEqual({ event: null, retract: null });
    const later = foldEntries([{ t: 'contract', at: at(3000), path: rel, hash: 'h2', blobId: null, symbols: ['A'], kinds: ['export'], eventId: 'e2' }], fold);
    const r = await workingTreeContract(rt, ctx, rel, '', later);
    expect(r.retract?.hash).toBe('h2');
  });

  it('retract carries the open record hash and marks the journal record retracted', async () => {
    const ctx = ctxFor('s-rt');
    const open: JournalContract = { t: 'contract', at: new Date(T0).toISOString(), path: 'packages/contracts/src/a.ts', hash: 'h'.repeat(40), blobId: null, symbols: ['A'], kinds: ['export'], eventId: 'e1' };
    const fold = foldEntries([open], emptyFold());
    const { rt } = makeRuntime(home, 'stop', { now: () => T0 });
    const r = await workingTreeContract(rt, ctx, 'packages/contracts/src/a.ts', '', fold);
    expect(r.retract).toMatchObject({ type: 'retract', path: 'packages/contracts/src/a.ts', impactId: null, hash: 'h'.repeat(40) });
    expect(loadFold(ctx.dir).contracts['packages/contracts/src/a.ts']?.retracted).toBe(true);
  });
});

describe('io + runtime helpers', () => {
  it('parseHookInput rejects garbage and accepts the minimal hook object', () => {
    expect(parseHookInput('')).toBeNull();
    expect(parseHookInput('not json')).toBeNull();
    expect(parseHookInput('[1]')).toBeNull();
    expect(parseHookInput('{"session_id":"s"}')).toBeNull();
    expect(parseHookInput('{"session_id":"s","hook_event_name":"Stop","cwd":"/x"}')).toMatchObject({ session_id: 's' });
  });

  it('capOutput trims context to keep the object under the stdout cap', () => {
    const out = { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, additionalContext: 'x'.repeat(20_000), permissionDecision: 'ask' as const, permissionDecisionReason: 'r' } };
    const capped = capOutput(out, 9000);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(9000);
    expect((capped.hookSpecificOutput as Record<string, string>)['permissionDecision']).toBe('ask');
    expect(capOutput({ hookSpecificOutput: { hookEventName: 'Stop' as never } })).toEqual({ hookSpecificOutput: { hookEventName: 'Stop' } });
  });

  it('parseFlags reads --key value and --key=value pairs', () => {
    expect(parseFlags(['--session', 's1', '--cwd=/a b', '--flag', '--entry', 'e'])).toEqual({ session: 's1', cwd: '/a b', flag: '1', entry: 'e' });
  });
});
