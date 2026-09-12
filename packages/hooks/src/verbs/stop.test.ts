import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJournal, loadFold, readDraft, readMeta, sessionDir, type ContractEvent, type EventsRequest, type TurnEndEvent } from '@relay/core';
import { T0, git, iso, makeRepo, makeRuntime, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { runStop } from './stop.js';

const SID = 'sess-stop';
const BILLING = 'packages/contracts/src/billing.ts';

const MESSAGE = `I've renamed Invoice.total to amountDue and updated the service.

\`\`\`ts
export interface Invoice { amountDue: number }
\`\`\`

We decided to store amounts as integer minor units instead of floats. Waiting on FX-rate credentials from the client.

## Next
- Update the dashboard invoice table
- Backfill legacy invoices
`;

describe('stop', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'), { email: 'deepak@acme.dev', name: 'Deepak' });
  });
  afterEach(() => cleanup());

  it('journals the prose turn, reconciles dirty contract paths and own commits, writes the draft and posts turn_end', async () => {
    const head0 = git(repo, 'rev-parse', 'HEAD');
    seedMeta(home, SID, repo, { branch: 'main', startSha: head0, gitEmails: ['deepak@acme.dev'] });
    const dir = sessionDir(home, SID);
    appendJournal(dir, { t: 'prompt', at: iso(now - 90_000), promptId: 'p0', len: 30, sha1: 'x' });
    appendJournal(dir, { t: 'objective', at: iso(now - 90_000), objective: 'Add currency support to invoices', source: 'prompt' });
    appendJournal(dir, { t: 'edit', at: iso(now - 60_000), path: 'apps/app/src/service.ts', tool: 'Edit', toolUseId: null });
    // a contract file edited outside Claude (dirty, never seen by post-edit) and a hand-made own commit
    writeFileSync(join(repo, BILLING), 'export interface Invoice {\n  id: string\n  amountDue: number\n}\n');
    writeFileSync(join(repo, 'README.md'), '# demo\nby hand\n');
    git(repo, 'commit', '-qm', 'docs: by hand', '--', 'README.md'); // billing.ts stays dirty
    const head1 = git(repo, 'rev-parse', 'HEAD');

    const { rt, ff } = makeRuntime(home, 'stop', { now: () => now });
    const out = await runStop(rt, stdin.stop(SID, repo, MESSAGE));
    expect(out).toBeNull();
    const body = ff.calls[0]?.body as EventsRequest;
    const types = body.events.map((e) => e.type);
    expect(types).toContain('commit');
    expect(types).toContain('contract');
    expect(types[types.length - 1]).toBe('turn_end');
    const turn = body.events.find((e) => e.type === 'turn_end') as TurnEndEvent;
    expect(turn.promptId).toBe('p1');
    expect(turn.text).not.toContain('```');
    expect(turn.text).toContain("I've renamed Invoice.total to amountDue");
    const contract = body.events.find((e) => e.type === 'contract') as ContractEvent;
    expect(contract.path).toBe(BILLING);
    expect(contract.symbols).toContain('Invoice');
    const commit = body.events.find((e) => e.type === 'commit');
    expect(commit).toMatchObject({ sha: head1, subject: 'docs: by hand' });

    const draft = turn.draft!;
    expect(draft.quality).toBe('heuristic');
    expect(draft.objective).toBe('Add currency support to invoices');
    expect(draft.changed.map((c) => c.path)).toEqual(expect.arrayContaining(['apps/app/src/service.ts', BILLING, 'README.md']));
    expect(draft.changed.find((c) => c.path === BILLING)?.edits).toBe(0); // changed outside Claude
    expect(draft.done[0]).toMatch(/^I've renamed Invoice\.total/);
    expect(draft.decisions[0]).toMatch(/integer minor units/);
    expect(draft.blockers[0]).toMatch(/Waiting on FX-rate credentials/);
    expect(draft.next).toEqual(['Update the dashboard invoice table', 'Backfill legacy invoices']);
    expect(draft.commits).toEqual([{ sha: head1, subject: 'docs: by hand', pushed: false }]);
    expect(draft.interfaces_changed[0]).toMatchObject({ path: BILLING, status: 'uncommitted' });
    expect(readDraft(dir)).toEqual(draft);

    const meta = readMeta(dir)!;
    expect(meta.lastStopSha).toBe(head1);
    expect(meta.lastStopAt).toBe(iso(now));
    expect(loadFold(dir).turns).toHaveLength(1);
    expect(loadFold(dir).lastTurnWasQuestion).toBe(false);
  });

  it('a trivial session sends turn_end with a null draft and nothing else; send_turns=false drops the text', async () => {
    seedMeta(home, SID, repo, { branch: 'main', startSha: git(repo, 'rev-parse', 'HEAD') });
    writeFileSync(join(repo, '.relay.json'), JSON.stringify({ privacy: { send_turns: false } }));
    const { rt, ff } = makeRuntime(home, 'stop', { now: () => now });
    await runStop(rt, stdin.stop(SID, repo, 'Sure, which file do you mean?'));
    const body = ff.calls[0]?.body as EventsRequest;
    expect(body.events).toEqual([expect.objectContaining({ type: 'turn_end', promptId: 'p1', text: null, draft: null })]);
    expect(readDraft(sessionDir(home, SID))).toBeNull();
    expect(loadFold(sessionDir(home, SID)).lastTurnWasQuestion).toBe(false); // empty text when send_turns is off
  });

  it('never prints anything and survives a hub outage (WAL kept)', async () => {
    seedMeta(home, SID, repo, { branch: 'main', startSha: git(repo, 'rev-parse', 'HEAD') });
    const { rt } = makeRuntime(home, 'stop', { now: () => now, handle: () => 'network-error' });
    expect(await runStop(rt, stdin.stop(SID, repo, 'Done. Is that all?'))).toBeNull();
    const { listOutbox } = await import('@relay/core');
    expect(listOutbox(home).entries).toHaveLength(1);
    expect(loadFold(sessionDir(home, SID)).lastTurnWasQuestion).toBe(true);
  });
});
