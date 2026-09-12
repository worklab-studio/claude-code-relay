import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, type SessionStartResponse } from '@relay/core';
import { assemble } from './digest.js';

import { CONTRACT_PATH, commitEvent, contractEvent, editEvent, makeHub, postEvents, promptEvent, startBody, startSession, type TestHub } from '../test/helpers.js';

let t: TestHub;
afterEach(async () => {
  await t?.close();
});

describe('digest rendering (§9.3)', () => {
  it('assemble() truncates from the bottom to the cap and keeps the envelope', () => {
    const header = '<relay-digest at="x">';
    const footer = '</relay-digest>';
    const sections = [
      ['## A', ...Array.from({ length: 50 }, (_, i) => `- line ${i} ${'x'.repeat(80)}`)],
      ['## B', ...Array.from({ length: 50 }, (_, i) => `- b ${i} ${'y'.repeat(80)}`)],
    ];
    const text = assemble(header, sections, footer, 2000);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith(header)).toBe(true);
    expect(text.endsWith(footer)).toBe(true);
    expect(text).toContain('## A');
    expect(text).not.toContain('## B');
  });

  it('stays within 6,000 chars in full mode and 2,000 in delta mode under load', async () => {
    t = await makeHub();
    await startSession(t, 'arjun', 'a0');
    await t.request('/v1/session/end', { dev: 'arjun', json: { sessionId: 'a0', reason: 'other', files: [], commits: [], draft: null } });
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    await postEvents(t, 'priya', 'p1', [promptEvent(t, { objective: 'Refactor every contract in the repo one file at a time' })], { objective: 'Refactor every contract', area: 'contracts' });
    // 12 change sets over time, committed so they route immediately, each with a long hunk
    for (let i = 0; i < 12; i++) {
      t.clock.advance(31 * 60_000); // beyond the 30-min change-set merge window
      const path = `packages/contracts/src/mod${i}.ts`;
      await postEvents(t, 'priya', 'p1', [
        contractEvent(t, path, { hash: `h${i}`, blobId: String(i).padStart(40, '0'), symbols: [`Type${i}`, `fn${i}`], hunk: `-export type Type${i} = A\n+export type Type${i} = B\n`.repeat(20), dependents: ['apps/dashboard/src/hooks/useOrders.ts'] }),
        commitEvent(t, String(i).padStart(40, 'a'), 'priya@demo', { files: [path], contracts: [{ path, symbols: [`Type${i}`], hash: `h${i}`, blobId: String(i).padStart(40, '0') }] }),
      ]);
    }
    for (let i = 0; i < 15; i++) {
      await t.request('/v1/notify', { dev: 'priya', session: 'p1', json: { dev: 'arjun', message: `note ${i}: ${'lorem ipsum '.repeat(20)}` } });
    }
    for (let i = 0; i < 8; i++) {
      await t.request('/v1/decide', { dev: 'priya', session: 'p1', json: { text: `decision ${i}: integers everywhere ${'x'.repeat(60)}` } });
    }
    const full = await startSession(t, 'arjun', 'a1');
    expect(full.digest.length).toBeLessThanOrEqual(LIMITS.digestChars);
    expect(full.digest).toContain('## Contract changes affecting you');
    expect(full.digest).toContain('```diff');
    expect(full.digest).toContain('## Messages for you');
    // messages shown in the digest count as delivered (§9.3): a second start shows none
    const again = await t.request<SessionStartResponse>('/v1/session/start', { dev: 'arjun', json: startBody('a1', { session: { ...startBody('a1').session, source: 'resume' }, mode: 'delta', since: t.clock.now().toISOString() }) });
    expect(again.status).toBe(200);
    expect(again.body.digest.length).toBeLessThanOrEqual(LIMITS.deltaDigestChars);
    expect(again.body.digest).toContain('mode="delta"');
    expect(again.body.digest).not.toContain('## Handoffs');
  });

  it('states the identity fact for placeholder handles and lists teammates with absolute timestamps', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1');
    await postEvents(t, 'priya', 'p1', [promptEvent(t, { objective: 'Add currency to invoices' })], { objective: 'Add currency to invoices', area: 'app' });
    await postEvents(t, 'priya', 'p1', [editEvent(t, 'apps/app/src/billing/service.ts')]);
    const unknown = await startSession(t, 'unknown-ab12cd', 'u1', { gitEmail: 'someone@else.dev' });
    expect(unknown.digest).toContain('Relay identity for this session is unknown (git email someone@else.dev is not in the team list)');
    expect(unknown.digest).toMatch(/- priya · app · main · "Add currency to invoices" · working, last event \d\d:\d\d:\d\dZ · files: apps\/app\/src\/billing\/service\.ts/);

    // iam merges the placeholder's session into the real handle
    const iam = await t.request<{ merged: boolean; sessions: number }>('/v1/iam', { dev: 'arjun', json: { placeholder: 'unknown-ab12cd' } });
    expect(iam.body).toEqual({ merged: true, sessions: 1 });
    const status = await t.request<{ projects: Array<{ devs: Array<{ dev: string; sessions: unknown[] }> }> }>('/v1/query/status?repo=demo/app', { dev: 'arjun' });
    const devs = status.body.projects[0]?.devs.map((d) => d.dev) ?? [];
    expect(devs).toContain('arjun');
    expect(devs).not.toContain('unknown-ab12cd');
    // requests under the placeholder now resolve to arjun
    const snap = await t.request<{ me: { dev: string } }>('/v1/snapshot?repo=demo/app', { dev: 'unknown-ab12cd' });
    expect(snap.body.me.dev).toBe('arjun');
  });

  it('shows the FYI line for low-priority change sets and the routed change set with mixed status', async () => {
    t = await makeHub();
    await startSession(t, 'priya', 'p1', { gitEmail: 'priya@demo' });
    // same-area churn 31 min earlier: its own change set, low priority, no target -> one FYI line
    await postEvents(t, 'priya', 'p1', [contractEvent(t, 'apps/app/src/components/Button.tsx', { symbols: ['Button'], hash: 'h-button', dependents: ['apps/app/src/pages/Home.tsx'] })]);
    t.clock.advance(31 * 60_000);
    // a committed contract change plus a second file still in progress, in one change set
    await postEvents(t, 'priya', 'p1', [contractEvent(t, CONTRACT_PATH), commitEvent(t, '9'.repeat(40), 'priya@demo')]);
    await postEvents(t, 'priya', 'p1', [contractEvent(t, 'packages/contracts/src/customers.ts', { symbols: ['Customer'], hash: 'h-cust', dependents: ['apps/dashboard/src/Customers.tsx'] })]);
    const arjun = await startSession(t, 'arjun', 'a1');
    expect(arjun.digest).toContain('## Contract changes affecting you (1 change set)');
    expect(arjun.digest).toMatch(/cs_[0-9A-Z]+: priya changed 2 contract files at \d\d:\d\d:\d\dZ \(main, committed 9999999, 1 file still in progress\): orders\.ts \(OrderFilter\); customers\.ts \(Customer\)/);
    expect(arjun.digest).toContain('Your dependents: apps/dashboard/src/hooks/useOrders.ts, apps/dashboard/src/Customers.tsx');
    expect(arjun.digest).toContain('FYI: 1 other contract change set');
    expect(arjun.snapshot.changeSets).toHaveLength(1);
    expect(arjun.snapshot.changeSets[0]?.dependents.map((d) => d.path)).toContain('apps/dashboard/src/hooks/useOrders.ts');
  });
});
