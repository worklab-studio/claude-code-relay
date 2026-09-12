import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { makeChangeSet, makeHeat, makeSnapshot, T0 } from '../test/fixtures.js';
import { ancestryTargets, computeAncestry, refreshAncestry } from './ancestry.js';
import { readAncestry } from './cache.js';

const ENV = { GIT_AUTHOR_NAME: 'P', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'P', GIT_COMMITTER_EMAIL: 'p@x' };
let root = '';
let repo = '';
let cleanup: () => void = () => undefined;
const git = (args: string[], cwd = repo): string => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...ENV }, encoding: 'utf8' }).trim();
const PATH = 'packages/contracts/src/billing.ts';
const BEFORE = 'export interface Invoice {\n  total: number\n}\n';
const AFTER = 'export interface Invoice {\n  amountDue: number\n  currency: Currency\n}\n';
const HUNK = '@@ -1,1 +1,2 @@ export interface Invoice {\n-  total: number\n+  amountDue: number\n+  currency: Currency';
let featureSha = '';
let featureBlob = '';

beforeAll(() => {
  const t = tmpHome('relay-anc-');
  root = t.home;
  cleanup = t.cleanup;
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'packages/contracts/src'), { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(join(repo, PATH), BEFORE);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  git(['checkout', '-q', '-b', 'feat/currency']);
  writeFileSync(join(repo, PATH), AFTER);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'currency']);
  featureSha = git(['rev-parse', 'HEAD']);
  featureBlob = git(['rev-parse', `HEAD:${PATH}`]);
  git(['checkout', '-q', 'main']);
});
afterAll(() => cleanup());

describe('ancestry', () => {
  it('lists targets, skipping cross-repo change sets', () => {
    const snap = makeSnapshot(T0, {
      heat: [makeHeat('priya', PATH, { headSha: 'aaa' })],
      changeSets: [makeChangeSet('cs_same', []), makeChangeSet('cs_other', [], { repo: 'github.com/acme/dashboard' })],
    });
    const t = ancestryTargets(snap);
    expect(t.shas.sort()).toEqual(['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', 'aaa']);
    expect(t.changeSets.map((c) => c.id)).toEqual(['cs_same']);
  });

  it('on main: the feature commit is not an ancestor and the content is absent', async () => {
    const snap = makeSnapshot(T0, {
      heat: [makeHeat('priya', PATH, { headSha: featureSha })],
      changeSets: [makeChangeSet('cs_1', [], { impacts: [{ id: 'imp_1', rev: 1, path: PATH, symbols: ['Invoice'], summary: 's', hunk: HUNK, blobId: featureBlob, commitSha: featureSha, status: 'committed' }] })],
    });
    const a = await computeAncestry(repo, snap, { now: T0 });
    expect(a?.headSha).toBe(git(['rev-parse', 'HEAD']));
    expect(a?.contains[featureSha]).toBe(false);
    expect(a?.merged['cs_1']).toBe(false);
  });

  it('after a squash merge the SHA is still no ancestor but blob/content say merged; refresh reports it once', async () => {
    git(['merge', '-q', '--squash', 'feat/currency']);
    git(['commit', '-q', '-m', 'squash: currency']);
    const bySha = makeChangeSet('cs_sha', [], { impacts: [{ id: 'imp_1', rev: 1, path: PATH, symbols: ['Invoice'], summary: 's', hunk: HUNK, blobId: featureBlob, commitSha: featureSha, status: 'committed' }] });
    const byContent = makeChangeSet('cs_content', [], { impacts: [{ id: 'imp_2', rev: 1, path: PATH, symbols: ['Invoice'], summary: 's', hunk: HUNK, blobId: 'not-my-blob', commitSha: null, status: 'uncommitted' }] });
    const absent = makeChangeSet('cs_absent', [], { impacts: [{ id: 'imp_3', rev: 1, path: PATH, symbols: ['Invoice'], summary: 's', hunk: '@@ -1 +1 @@\n+  vat: number', blobId: null, commitSha: null, status: 'uncommitted' }] });
    const undecidable = makeChangeSet('cs_unknown', [], { impacts: [{ id: 'imp_4', rev: 1, path: 'missing/file.ts', symbols: [], summary: 's', hunk: null, blobId: 'zzz', commitSha: null, status: 'uncommitted' }] });
    const snap = makeSnapshot(T0, { heat: [makeHeat('priya', PATH, { headSha: featureSha })], changeSets: [bySha, byContent, absent, undecidable] });
    const first = await refreshAncestry(root + '/x', 'k', repo, snap, { now: T0 });
    expect(first.file?.contains[featureSha]).toBe(false); // squash: never an ancestor
    expect(first.file?.merged).toEqual({ cs_sha: true, cs_content: true, cs_absent: false });
    expect(first.newlyMerged.sort()).toEqual(['cs_content', 'cs_sha']);
    expect(readAncestry(root + '/x', 'k')?.headSha).toBe(git(['rev-parse', 'HEAD']));
    const second = await refreshAncestry(root + '/x', 'k', repo, snap, { now: T0 + 1000 });
    expect(second.newlyMerged).toEqual([]);
    // a later local edit changes the blob but the + lines are still present -> content path keeps it merged
    writeFileSync(join(repo, PATH), AFTER + 'export type Currency = string\n');
    git(['commit', '-q', '-am', 'more']);
    const third = await computeAncestry(repo, makeSnapshot(T0, { changeSets: [{ ...bySha, id: 'cs_again', impacts: [{ ...bySha.impacts[0]!, commitSha: null }] }] }), { now: T0 });
    expect(third?.merged['cs_again']).toBe(true);
    expect(await computeAncestry(root, snap)).toBeNull(); // not a repo
  });
});
