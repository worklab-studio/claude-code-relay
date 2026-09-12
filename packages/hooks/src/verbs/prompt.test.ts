import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasMark, listOutbox, loadFold, readBreaker, readSnapshot, refreshWantedAgeMs, writeSnapshot, type EventsRequest, type Snapshot } from '@relay/core';
import { T0, iso, makeChangeSet, makeRuntime, makeSnapshot, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { runPrompt, systemMessageFor } from './prompt.js';

const SID = 'sess-prompt';

describe('prompt', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = join(home, 'repo');
    mkdirSync(repo, { recursive: true });
  });
  afterEach(() => cleanup());

  function inboxSnapshot(at: number): Snapshot {
    return makeSnapshot(at, {
      me: { dev: 'deepak', sessionId: SID },
      inbox: [{ id: 'ntf_1', kind: 'note', from: 'priya', body: 'keep `status` — dashboard already consumes it', ref: null, at: iso(at - 60_000), noteKind: 'fyi' }],
      changeSets: [makeChangeSet('cs_hi', ['apps/dashboard/src/invoices.tsx']), makeChangeSet('cs_lo', ['apps/dashboard/src/x.tsx'], { priority: 'normal' })],
    });
  }

  it('journals the prompt, derives the objective, delivers inbox + high change sets once, writes the WAL entry and spawns the worker', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, inboxSnapshot(now), { now });
    const { rt, spawned, ff } = makeRuntime(home, 'prompt', { now: () => now });
    const out = await runPrompt(rt, stdin.prompt(SID, repo, 'Add currency support to invoices across the dashboard'));
    expect(ff.calls).toHaveLength(0); // fresh cache: no network on the prompt path
    const hso = out?.hookSpecificOutput as Record<string, string>;
    expect(hso['hookEventName']).toBe('UserPromptSubmit');
    expect(hso['additionalContext']).toMatch(/^<relay-inbox at="2026-09-12T09:41:07\.000Z">\n- /);
    expect(hso['additionalContext']).toContain('NOTE from priya');
    expect(hso['additionalContext']).toContain('IMPACT cs_hi');
    expect(hso['additionalContext']).not.toContain('cs_lo');
    expect(hso['additionalContext']?.length ?? 0).toBeLessThanOrEqual(1500);
    expect(out?.systemMessage).toBe("Relay: 1 impact, 1 note (in Claude's context)");

    const fold = loadFold(join(home, 'sessions', SID));
    expect(fold.prompts.count).toBe(1);
    expect(fold.prompts.lastPromptId).toBe('p1');
    expect(fold.objective.text).toBe('Add currency support to invoices across the dashboard');
    expect(fold.objective.source).toBe('prompt');

    const { entries } = listOutbox(home);
    expect(entries).toHaveLength(1);
    const body = entries[0]?.body as EventsRequest;
    expect(body.session).toMatchObject({ id: SID, repo: 'github.com/acme/app', branch: 'feat/dashboard', objective: 'Add currency support to invoices across the dashboard', objectiveSource: 'prompt' });
    expect(body.events[0]).toMatchObject({ type: 'prompt', promptId: 'p1', dirty: [] });
    expect((body.events[0] as unknown as Record<string, unknown>)['text']).toBeUndefined(); // send_prompts default false
    expect(body.delivered).toEqual(['ntf_1', 'cs_hi']);
    expect(spawned).toEqual([{ job: 'prompt', args: ['--session', SID, '--cwd', repo, '--entry', entries[0]?.id] }]);
    expect(hasMark(join(home, 'sessions', SID), 'seen', 'ntf_1')).toBe(true);
    expect(hasMark(join(home, 'sessions', SID), 'jit', 'cs_hi')).toBe(true);

    // second prompt: nothing new to deliver, short answers do not replace the objective
    const { rt: rt2 } = makeRuntime(home, 'prompt', { now: () => now + 1000 });
    expect(await runPrompt(rt2, stdin.prompt(SID, repo, 'yes'))).toBeNull();
    expect(loadFold(join(home, 'sessions', SID)).objective.text).toBe('Add currency support to invoices across the dashboard');
  });

  it('marks and reports as delivered only the items that fit the 1,500-char block; the rest wait for the next prompt (review)', async () => {
    const meta = seedMeta(home, SID, repo);
    const notes = Array.from({ length: 6 }, (_, i) => ({ id: `ntf_${i}`, kind: 'note' as const, from: 'priya', body: `note ${i} ${'x'.repeat(340)}`, ref: null, at: iso(now - 60_000), noteKind: 'fyi' as const }));
    writeSnapshot(home, meta.repoKey, makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID }, inbox: notes, changeSets: [makeChangeSet('cs_hi', ['apps/dashboard/src/invoices.tsx'])] }), { now });
    const { rt } = makeRuntime(home, 'prompt', { now: () => now });
    const out = await runPrompt(rt, stdin.prompt(SID, repo, 'first prompt of the day'));
    const block = (out?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    expect(block.length).toBeLessThanOrEqual(1500);
    const shown = notes.filter((n) => block.includes(`note ${n.id.slice(4)} `)).map((n) => n.id);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(notes.length);
    const dir = join(home, 'sessions', SID);
    const body = listOutbox(home).entries[0]?.body as EventsRequest;
    expect(body.delivered).toEqual(shown);
    for (const n of notes) expect(hasMark(dir, 'seen', n.id)).toBe(shown.includes(n.id));
    expect(hasMark(dir, 'jit', 'cs_hi')).toBe(false); // did not fit: still due at edit time / next prompt
    // the next prompt delivers the remainder
    const { rt: rt2 } = makeRuntime(home, 'prompt', { now: () => now + 1000 });
    const out2 = await runPrompt(rt2, stdin.prompt(SID, repo, 'second prompt of the day'));
    const block2 = (out2?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    for (const id of shown) expect(block2).not.toContain(`note ${id.slice(4)} `);
    const shown2 = notes.filter((n) => block2.includes(`note ${n.id.slice(4)} `)).map((n) => n.id);
    expect(shown2.length).toBeGreaterThan(0);
    expect([...shown, ...shown2]).toHaveLength(new Set([...shown, ...shown2]).size);
  });

  it('refreshes the snapshot when the cache is older than the TTL, using the longer budget after a pause', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, makeSnapshot(now - 400_000, { me: { dev: 'deepak', sessionId: SID } }), { now: now - 400_000 });
    const fresh = inboxSnapshot(now);
    const { rt, ff } = makeRuntime(home, 'prompt', { now: () => now, handle: () => ({ status: 200, body: fresh }) });
    const out = await runPrompt(rt, stdin.prompt(SID, repo, 'continue'));
    expect(ff.calls).toEqual([expect.objectContaining({ method: 'GET', path: '/v1/snapshot?repo=github.com%2Facme%2Fapp' })]);
    expect(ff.calls[0]?.headers['x-relay-dev']).toBe('deepak');
    expect(ff.calls[0]?.headers['authorization']).toBe('Bearer rt_test');
    expect(readSnapshot(home, meta.repoKey)?.serverTime).toBe(iso(now));
    expect((out?.hookSpecificOutput as Record<string, string>)['additionalContext']).toContain('NOTE from priya');
  });

  it('a refresh timeout keeps the cache, writes refresh-wanted and never opens the breaker', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, inboxSnapshot(now - 120_000), { now: now - 120_000 });
    const { rt } = makeRuntime(home, 'prompt', { handle: () => ({ status: 200, body: {}, delayMs: 5000 }), env: { RELAY_SNAPSHOT_TTL_MS: '1000' } });
    const started = Date.now();
    const out = await runPrompt(rt, stdin.prompt(SID, repo, 'continue'));
    expect(Date.now() - started).toBeLessThan(1900);
    expect((out?.hookSpecificOutput as Record<string, string>)['additionalContext']).toContain('NOTE from priya'); // served from the cache
    expect(refreshWantedAgeMs(home)).not.toBeNull();
    expect(readBreaker(home).open).toBe(false);
    expect(readBreaker(home).count).toBe(0);
  });

  it('skips the network while the breaker is open and with RELAY_SNAPSHOT_TTL_MS honoured', async () => {
    const meta = seedMeta(home, SID, repo);
    writeSnapshot(home, meta.repoKey, makeSnapshot(now - 5000, { me: { dev: 'deepak', sessionId: SID } }), { now: now - 5000 });
    const { rt, ff } = makeRuntime(home, 'prompt', { now: () => now, env: { RELAY_SNAPSHOT_TTL_MS: '15000' } });
    await runPrompt(rt, stdin.prompt(SID, repo, 'continue'));
    expect(ff.calls).toHaveLength(0);
  });

  it('honours privacy.send_prompts and objective_from_prompts = false', async () => {
    const meta = seedMeta(home, SID, repo);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, '.relay.json'), JSON.stringify({ privacy: { send_prompts: true, objective_from_prompts: false } }));
    writeSnapshot(home, meta.repoKey, makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID } }), { now });
    const { rt } = makeRuntime(home, 'prompt', { now: () => now });
    await runPrompt(rt, stdin.prompt(SID, repo, 'Implement the thing with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 please'));
    const fold = loadFold(join(home, 'sessions', SID));
    expect(fold.objective.text).toBeNull();
    const body = listOutbox(home).entries[0]?.body as EventsRequest;
    const ev = body.events[0] as unknown as Record<string, unknown>;
    expect(ev['text']).toContain('[redacted]');
    expect(ev['text']).not.toContain('ghp_');
    expect(body.session.objectiveSource).toBe('branch');
  });

  it('systemMessageFor counts impacts and notes', () => {
    expect(systemMessageFor([])).toBeNull();
    expect(systemMessageFor(['IMPACT cs_1: x', 'NOTE from a: y', 'HANDOFF note from b: z'])).toBe("Relay: 1 impact, 2 notes (in Claude's context)");
  });
});
