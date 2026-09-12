import { describe, expect, it } from 'vitest';
import { LIMITS, emptyFold, foldEntries, type JournalEntry } from '@relay/core';
import { T0, iso } from '../test/helpers.js';
import { buildHandoffDraft, isTrivialSession, nextBullets, sentencesOf, shrinkDraft } from './handoff-draft.js';

function fold(entries: JournalEntry[]) {
  return foldEntries(entries, emptyFold());
}

describe('handoff draft (tier 1)', () => {
  it('sentencesOf splits on sentence ends and line breaks and strips bullets', () => {
    expect(sentencesOf('Done. I have added X!\n- Fixed Y\n1. Updated Z')).toEqual(['Done.', 'I have added X!', 'Fixed Y', 'Updated Z']);
  });

  it('nextBullets reads bullets under Next / TODO / Remaining headings only', () => {
    const text = 'Summary.\n\n## Next\n- one\n- two\n* three\n\n## Other\n- four';
    expect(nextBullets(text)).toEqual(['one', 'two', 'three']);
    expect(nextBullets('**Remaining:**\n1. a\n2) b')).toEqual(['a', 'b']);
    expect(nextBullets('TODO: nothing structured\n- not under a heading line')).toEqual([]);
    expect(nextBullets(Array.from({ length: 9 }, (_, i) => `- item ${i}`).join('\n').replace(/^/, '## Next\n'))).toHaveLength(5);
  });

  it('isTrivialSession: no edits, no commits, fewer than three prompts', () => {
    expect(isTrivialSession(emptyFold())).toBe(true);
    expect(isTrivialSession(fold([{ t: 'prompt', at: iso(T0), promptId: null, len: 1, sha1: 'a' }, { t: 'prompt', at: iso(T0), promptId: null, len: 1, sha1: 'b' }]))).toBe(true);
    expect(isTrivialSession(fold([{ t: 'edit', at: iso(T0), path: 'a.ts', tool: 'Edit', toolUseId: null }]))).toBe(false);
  });

  it('builds done/decisions/blockers/next/changed/interfaces/commits from the fold', () => {
    const f = fold([
      { t: 'objective', at: iso(T0 - 1000), objective: 'Add currency support to invoices', source: 'prompt' },
      { t: 'edit', at: iso(T0), path: 'packages/contracts/src/billing.ts', tool: 'Edit', toolUseId: null },
      { t: 'edit', at: iso(T0), path: 'packages/contracts/src/billing.ts', tool: 'Edit', toolUseId: null },
      { t: 'edit', at: iso(T0), path: 'apps/app/src/service.ts', tool: 'Edit', toolUseId: null },
      { t: 'contract', at: iso(T0), path: 'packages/contracts/src/billing.ts', hash: 'h1', blobId: 'b1', symbols: ['Invoice', 'createInvoice'], kinds: ['export'], eventId: 'e1' },
      { t: 'contract', at: iso(T0), path: 'apps/app/src/old.ts', hash: 'h2', blobId: null, symbols: ['Old'], kinds: ['export'], eventId: 'e2', retracted: true },
      { t: 'commit', at: iso(T0), sha: 'a'.repeat(40), subject: 'contracts: currency', files: ['packages/contracts/src/billing.ts'], contracts: ['packages/contracts/src/billing.ts'], pushed: true },
      { t: 'task', at: iso(T0), id: '1', subject: 'Migration 0042 adds invoices.currency', status: 'created' },
      { t: 'task', at: iso(T0), id: '1', subject: 'Migration 0042 adds invoices.currency', status: 'completed' },
      { t: 'turn', at: iso(T0), promptId: 'p1', text: 'Earlier turn. Added the migration. Committed as `a1b2c3d` on `main`.' },
      { t: 'turn', at: iso(T0), promptId: 'p2', text: "I've updated createInvoice to validate ISO-4217. We chose integer minor units instead of floats. Blocked on FX provider creds.\n\nNext steps:\n- Update dashboard invoice table\n- Backfill script" },
    ]);
    const areas = { app: { paths: ['apps/app/**'] }, contracts: { paths: ['packages/contracts/**'], shared: true } };
    const d = buildHandoffDraft({ fold: f, areas, branch: 'feat/currency', repoSlug: 'github.com/acme/app', outsideFiles: ['prisma/schema.prisma', 'apps/app/src/service.ts'], now: T0 });
    expect(d.quality).toBe('heuristic');
    expect(d.at).toBe(iso(T0));
    expect(d.objective).toBe('Add currency support to invoices');
    expect(d.areas.sort()).toEqual(['app', 'contracts']);
    expect(d.changed).toEqual([
      { path: 'packages/contracts/src/billing.ts', area: 'contracts', edits: 2 },
      { path: 'apps/app/src/service.ts', area: 'app', edits: 1 },
      { path: 'prisma/schema.prisma', area: null, edits: 0 },
    ]);
    expect(d.interfaces_changed).toEqual([
      { changeSetId: null, impactId: null, path: 'packages/contracts/src/billing.ts', symbols: ['Invoice', 'createInvoice'], summary: 'billing.ts: Invoice, createInvoice', status: 'pushed', commitSha: 'a'.repeat(40) },
    ]);
    expect(d.done).toEqual(['Migration 0042 adds invoices.currency', 'Added the migration.', 'Committed as `a1b2c3d` on `main`.', "I've updated createInvoice to validate ISO-4217."]);
    expect(d.decisions).toEqual(['We chose integer minor units instead of floats.']);
    expect(d.blockers).toEqual(['Blocked on FX provider creds.']);
    expect(d.next).toEqual(['Update dashboard invoice table', 'Backfill script']);
    expect(d.commits).toEqual([{ sha: 'a'.repeat(40), subject: 'contracts: currency', pushed: true }]);
    expect(d.objectiveTrail).toEqual(['Add currency support to invoices']);
    expect(d.notes_to).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(LIMITS.draftBytes);
  });

  it('falls back to the branch objective and shrinks oversized drafts under 8 KB', () => {
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 400; i++) entries.push({ t: 'edit', at: iso(T0), path: `apps/app/src/component-${i}/index.tsx`, tool: 'Edit', toolUseId: null });
    for (let i = 0; i < 100; i++) entries.push({ t: 'commit', at: iso(T0), sha: i.toString(16).padStart(40, '0'), subject: `commit ${i} with a fairly long subject line to inflate the draft size`, files: [], contracts: [] });
    const d = buildHandoffDraft({ fold: fold(entries), areas: {}, branch: 'feat/dashboard-filters', repoSlug: 'github.com/acme/app' });
    expect(d.objective).toBe('dashboard filters');
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(LIMITS.draftBytes);
    expect(shrinkDraft(d)).toEqual(d);
  });
});
