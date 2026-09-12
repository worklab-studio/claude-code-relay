import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listOutbox, loadFold, readBreaker, readSnapshot, recordSuccess, sessionDir, type ContractEvent, type EventsRequest, type RetractEvent } from '@relay/core';
import { T0, iso, makeRepo, makeRuntime, makeSnapshot, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { runPostEdit } from './post-edit.js';

const SID = 'sess-post-edit';
const BILLING = 'packages/contracts/src/billing.ts';

describe('post-edit', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'));
  });
  afterEach(() => cleanup());

  it('a contract edit posts edit + contract events with hunk, hash, blobId and dependents; the journal records both', async () => {
    seedMeta(home, SID, repo, { branch: 'main' });
    writeFileSync(join(repo, BILLING), 'export interface Invoice {\n  id: string\n  amountDue: number\n  currency: string\n}\nexport function createInvoice(input: Invoice, currency: string) {\n  return input\n}\n');
    const snap = makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID } });
    const { rt, ff } = makeRuntime(home, 'post-edit', { now: () => now, handle: () => ({ status: 200, body: { snapshot: snap, inbox: [] } }) });
    const out = await runPostEdit(rt, stdin.postEdit(SID, repo, join(repo, BILLING)));
    expect(out).toBeNull();
    expect(ff.calls).toHaveLength(1);
    const body = ff.calls[0]?.body as EventsRequest;
    expect(body.session.id).toBe(SID);
    expect(body.events.map((e) => e.type)).toEqual(['edit', 'contract']);
    expect(body.events[0]).toMatchObject({ type: 'edit', path: BILLING, tool: 'Edit', toolUseId: 'toolu_01' });
    const c = body.events[1] as ContractEvent;
    expect(c.symbols).toEqual(expect.arrayContaining(['Invoice', 'createInvoice']));
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(c.blobId).toMatch(/^[0-9a-f]{40}$/);
    expect(c.hunk).toContain('+  amountDue: number');
    expect(c.hunk).toContain('-  total: number');
    expect(c.dependents).toEqual(expect.arrayContaining(['apps/app/src/service.ts', 'apps/dashboard/src/invoices.tsx']));
    expect(c.branch).toBe('main');
    const fold = loadFold(sessionDir(home, SID));
    expect(fold.edits[BILLING]?.count).toBe(1);
    expect(fold.contracts[BILLING]?.hash).toBe(c.hash);
    expect(listOutbox(home).entries).toHaveLength(0); // deleted on 2xx
    expect(readSnapshot(home, 'x')).toBeNull();

    // the same content again: edit only, no duplicate contract
    const { rt: rt2, ff: ff2 } = makeRuntime(home, 'post-edit', { now: () => now + 1000, handle: () => ({ status: 200, body: { snapshot: snap, inbox: [] } }) });
    await runPostEdit(rt2, stdin.postEdit(SID, repo, join(repo, BILLING)));
    expect((ff2.calls[0]?.body as EventsRequest).events.map((e) => e.type)).toEqual(['edit']);
  });

  it('reverting an open contract record emits a retract by hash', async () => {
    seedMeta(home, SID, repo, { branch: 'main' });
    const original = 'export interface Invoice {\n  id: string\n  total: number\n}\nexport function createInvoice(input: Invoice) {\n  return input\n}\n';
    writeFileSync(join(repo, BILLING), original.replace('total', 'amountDue'));
    const a = makeRuntime(home, 'post-edit', { now: () => now });
    await runPostEdit(a.rt, stdin.postEdit(SID, repo, join(repo, BILLING)));
    const hash = (a.ff.calls[0]?.body as EventsRequest).events.find((e) => e.type === 'contract')?.id ? loadFold(sessionDir(home, SID)).contracts[BILLING]?.hash : null;
    expect(hash).toBeTruthy();
    writeFileSync(join(repo, BILLING), original);
    const b = makeRuntime(home, 'post-edit', { now: () => now + 1000 });
    await runPostEdit(b.rt, stdin.postEdit(SID, repo, join(repo, BILLING)));
    const events = (b.ff.calls[0]?.body as EventsRequest).events;
    expect(events.map((e) => e.type)).toEqual(['edit', 'retract']);
    expect(events[1] as RetractEvent).toMatchObject({ type: 'retract', path: BILLING, impactId: null, hash });
    expect(loadFold(sessionDir(home, SID)).contracts[BILLING]?.retracted).toBe(true);
  });

  it('non-contract edits post only the edit event; untracked contract files are treated as added', async () => {
    seedMeta(home, SID, repo, { branch: 'main' });
    writeFileSync(join(repo, 'README.md'), '# demo\nmore\n');
    const a = makeRuntime(home, 'post-edit', { now: () => now });
    await runPostEdit(a.rt, stdin.postEdit(SID, repo, join(repo, 'README.md'), 'Write'));
    expect((a.ff.calls[0]?.body as EventsRequest).events.map((e) => e.type)).toEqual(['edit']);
    writeFileSync(join(repo, 'packages/contracts/src/orders.ts'), 'export interface OrderFilter {\n  status: string\n}\n');
    const b = makeRuntime(home, 'post-edit', { now: () => now });
    await runPostEdit(b.rt, stdin.postEdit(SID, repo, join(repo, 'packages/contracts/src/orders.ts'), 'Write'));
    const c = (b.ff.calls[0]?.body as EventsRequest).events.find((e) => e.type === 'contract') as ContractEvent;
    expect(c.symbols).toContain('OrderFilter');
    expect(c.hunk).toContain('+export interface OrderFilter');
  });

  it('hub down: the WAL entry survives, a worker-role failure counts toward the breaker, inbox context on success', async () => {
    // real clock here: core's HubClient stamps the breaker files with Date.now()
    seedMeta(home, SID, repo, { branch: 'main' });
    writeFileSync(join(repo, 'README.md'), '# demo\nmore\n');
    const a = makeRuntime(home, 'post-edit', { handle: () => 'network-error' });
    expect(await runPostEdit(a.rt, stdin.postEdit(SID, repo, join(repo, 'README.md')))).toBeNull();
    expect(listOutbox(home).entries).toHaveLength(1);
    expect(readBreaker(home).count).toBe(1);
    expect(readBreaker(home).open).toBe(false);
    const b = makeRuntime(home, 'post-edit', { handle: () => 'network-error' });
    await runPostEdit(b.rt, stdin.postEdit(SID, repo, join(repo, 'README.md')));
    expect(readBreaker(home).open).toBe(true); // two consecutive worker failures
    // breaker open: no fetch, entry still written for the drain
    const c = makeRuntime(home, 'post-edit');
    await runPostEdit(c.rt, stdin.postEdit(SID, repo, join(repo, 'README.md')));
    expect(c.ff.calls).toHaveLength(0);
    expect(listOutbox(home).entries).toHaveLength(3);

    recordSuccess(home); // the breaker's 60 s elapsed (a worker's 2xx also closes it)
    const t = Date.now();
    const snap = makeSnapshot(t, { me: { dev: 'deepak', sessionId: SID } });
    const d = makeRuntime(home, 'post-edit', {
      handle: () => ({ status: 200, body: { snapshot: snap, inbox: [{ id: 'ntf_9', kind: 'note', from: 'priya', body: 'ping', ref: null, at: iso(t - 1000) }] } }),
    });
    const out = await runPostEdit(d.rt, stdin.postEdit(SID, repo, join(repo, 'README.md')));
    expect((out?.hookSpecificOutput as Record<string, string>)['hookEventName']).toBe('PostToolUse');
    expect((out?.hookSpecificOutput as Record<string, string>)['additionalContext']).toContain('NOTE from priya');
    expect(readBreaker(home).open).toBe(false);
    expect(listOutbox(home).entries).toHaveLength(3); // the three failed bodies wait for a worker drain
  });

  it('privacy.send_diffs = none omits the hunk', async () => {
    seedMeta(home, SID, repo, { branch: 'main' });
    writeFileSync(join(repo, '.relay.json'), JSON.stringify({ privacy: { send_diffs: 'none' } }));
    writeFileSync(join(repo, BILLING), 'export interface Invoice {\n  id: string\n  amountDue: number\n}\n');
    const { rt, ff } = makeRuntime(home, 'post-edit', { now: () => now });
    await runPostEdit(rt, stdin.postEdit(SID, repo, join(repo, BILLING)));
    const c = (ff.calls[0]?.body as EventsRequest).events.find((e) => e.type === 'contract') as ContractEvent;
    expect(c.hunk).toBeUndefined();
    expect(c.symbols).toContain('Invoice');
  });
});
