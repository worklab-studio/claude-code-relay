import { describe, expect, it } from 'vitest';
import { candidateFromPrompt, cleanPromptLine, deriveObjective, humanizeBranch, nextPromptObjective, nonAlphaRatio, objectiveFromBranch } from './objective.js';
import { emptyFold } from './journal.js';

describe('objective from prompts', () => {
  it('cleans the first line', () => {
    expect(cleanPromptLine('```ts\ncode\n```\nAdd currency support to invoices in /Users/x/app/src/billing.ts @src/foo.ts see https://x.y/z')).toBe('Add currency support to invoices in see');
    expect(cleanPromptLine('  at foo (x.js:1:2)\nFix the failing invoice test please')).toBe('Fix the failing invoice test please');
  });

  it('rejects short, stoplisted, slash, private, pasted and answer prompts', () => {
    expect(candidateFromPrompt('yes')).toBeNull();
    expect(candidateFromPrompt('ok go ahead and do that thing now please')).toBeNull();
    expect(candidateFromPrompt('/relay:status')).toBeNull();
    expect(candidateFromPrompt('[private] add currency support to invoices')).toBeNull();
    expect(candidateFromPrompt('{"a": 1, "b": [1,2,3], "c": {"d": 5}} 12345 67890')).toBeNull();
    expect(candidateFromPrompt('Add currency support to invoices', { lastTurnWasQuestion: true })).toBeNull();
    expect(candidateFromPrompt('Add currency support to invoices and validate the ISO-4217 code on create', { lastTurnWasQuestion: true })).not.toBeNull();
    expect(candidateFromPrompt('Add currency support to invoices')).toBe('Add currency support to invoices');
  });

  it('truncates at 140 chars on a word boundary', () => {
    const long = 'Refactor ' + 'the billing service '.repeat(20);
    const c = candidateFromPrompt(long);
    expect(c!.length).toBeLessThanOrEqual(140);
    expect(c!.endsWith('…')).toBe(true);
  });

  it('measures non-alpha ratio', () => {
    expect(nonAlphaRatio('abcd')).toBe(0);
    expect(nonAlphaRatio('1234')).toBe(1);
  });

  it('applies the replacement rules', () => {
    const now = Date.parse('2026-09-12T10:00:00Z');
    const cur = { text: 'Investigate slow invoice queries', source: 'prompt' as const, at: new Date(now - 60_000).toISOString(), toolCallsSince: 2 };
    expect(nextPromptObjective({ text: null, source: null, at: null, toolCallsSince: 0 }, 'Add currency support to invoices', now)).toBe('Add currency support to invoices');
    expect(nextPromptObjective(cur, 'Add currency support to invoices', now)).toBe('Add currency support to invoices'); // imperative verb
    expect(nextPromptObjective(cur, 'Let us look at the dashboard instead of the queries', now)).toContain('instead'); // pivot word
    expect(nextPromptObjective(cur, 'What about the caching layer for these invoice queries', now)).toBeNull();
    expect(nextPromptObjective({ ...cur, at: new Date(now - 11 * 60_000).toISOString() }, 'What about the caching layer for these invoice queries', now)).not.toBeNull();
    expect(nextPromptObjective({ ...cur, toolCallsSince: 15 }, 'What about the caching layer for these invoice queries', now)).not.toBeNull();
    expect(nextPromptObjective(cur, cur.text, now)).toBeNull();
    expect(nextPromptObjective({ ...cur, source: 'branch' }, 'What about the caching layer for these invoice queries', now)).not.toBeNull();
  });
});

describe('objective from branch and fold', () => {
  it('humanizes branch names', () => {
    expect(humanizeBranch('feat/dashboard-filters')).toBe('dashboard filters');
    expect(humanizeBranch('deepak/fix/invoice_total')).toBe('invoice total');
    expect(humanizeBranch('main')).toBeNull();
    expect(humanizeBranch('detached@abc1234')).toBeNull();
    expect(objectiveFromBranch('main', 'github.com/acme/app')).toBe('working in app');
  });

  it('prefers open tasks, then prompt trail, then branch', () => {
    const fold = emptyFold();
    const ctx = { branch: 'feat/currency', repoSlug: 'github.com/acme/app' };
    expect(deriveObjective(fold, ctx)).toEqual({ text: 'currency', source: 'branch' });
    fold.objective = { text: 'Add currency to invoices', source: 'prompt', at: '2026-09-12T10:00:00Z', toolCallsSince: 0, trail: [] };
    expect(deriveObjective(fold, ctx)).toEqual({ text: 'Add currency to invoices', source: 'prompt' });
    expect(deriveObjective(fold, { ...ctx, objectiveFromPrompts: false })).toEqual({ text: 'currency', source: 'branch' });
    fold.tasks.open.push({ id: '1', subject: 'Wire the FX provider', at: '2026-09-12T10:01:00Z' });
    expect(deriveObjective(fold, ctx)).toEqual({ text: 'Wire the FX provider', source: 'task' });
  });
});
