import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJournal, hasMark, readCurrentFile, readDigest, readMeta, readSnapshot, recordConfigError, recordWorkerFailure, sessionDir, writeDigest, writeSnapshot, type SessionStartRequest } from '@relay/core';
import { T0, iso, makeChangeSet, makeRepo, makeRuntime, makeSession, makeSnapshot, seedMeta, stdin, tmpDir } from '../../test/helpers.js';
import { clientDigestLines, insertDigestLines, runSessionStart } from './session-start.js';

const SID = 'sess-start';

describe('session-start', () => {
  let home: string;
  let repo: string;
  let cleanup: () => void;
  const now = T0;

  beforeEach(() => {
    const t = tmpDir();
    home = t.dir;
    cleanup = t.cleanup;
    repo = makeRepo(join(home, 'repo'), { origin: 'git@github.com:acme/app.git', relayJson: { project: 'acme-portal', areas: { app: { paths: ['apps/app/**'] }, contracts: { paths: ['packages/contracts/**'], shared: true } } } });
  });
  afterEach(() => cleanup());

  it('startup: builds meta from git, posts session/start, injects the digest, writes cache + env exports, spawns the worker', async () => {
    const digest = '<relay-digest team="t" project="acme-portal" repo="github.com/acme/app" dev="deepak" at="2026-09-12T09:41:07Z" freshness="live" mode="full">\n## Team now\n- priya · app · main · working, last event 09:40:27Z\n## Contract changes affecting you (1 change set)\n- cs_01J9XABCDEFGHJKMNPQRSTVWXY: priya changed billing.ts\n</relay-digest>';
    const snap = makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID }, sessions: [makeSession('priya')] });
    const envFile = join(home, 'env.sh');
    writeFileSync(envFile, '');
    const { rt, ff, spawned } = makeRuntime(home, 'session-start', {
      now: () => now,
      env: { CLAUDE_ENV_FILE: envFile, CLAUDE_CODE_ENTRYPOINT: 'cli' },
      handle: () => ({ status: 200, body: { digest, snapshot: snap, minClient: 1 } }),
    });
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo, 'startup', { model: 'claude-opus-5' }));
    const hso = out?.hookSpecificOutput as Record<string, string>;
    expect(hso['hookEventName']).toBe('SessionStart');
    expect(hso['additionalContext']).toBe(digest);
    expect(hso['sessionTitle']).toBeUndefined(); // no objective known yet

    expect(ff.calls).toHaveLength(1);
    const call = ff.calls[0]!;
    expect(call.path).toBe('/v1/session/start');
    expect(call.headers['x-relay-client']).toBe('cli');
    expect(call.headers['x-relay-session']).toBe(SID);
    const body = call.body as SessionStartRequest;
    expect(body.v).toBe(1);
    expect(body.mode).toBe('full');
    expect(body.session).toMatchObject({ id: SID, source: 'startup', client: 'cli', branch: 'main', worktree: null, model: 'claude-opus-5' });
    expect(body.session.repo).toMatchObject({ slug: 'github.com/acme/app', root: repo, project: 'acme-portal' });
    expect(body.session.repo.config).toMatchObject({ project: 'acme-portal' });
    expect(body.session.repo.configHash).toMatch(/^[0-9a-f]{40}$/);
    expect(body.session.startSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.recentShas).toEqual([body.session.startSha]);
    expect(body.identityHint).toEqual({ gitEmail: 'priya@acme.dev', source: 'env' });

    const meta = readMeta(sessionDir(home, SID));
    expect(meta).toMatchObject({ dev: 'deepak', repo: 'github.com/acme/app', project: 'acme-portal', branch: 'main', repoRoot: repo, client: 'cli', pid: 4242 });
    expect(hasMark(sessionDir(home, SID), 'seen', 'cs_01J9XABCDEFGHJKMNPQRSTVWXY')).toBe(true); // shown in the digest: the prompt will not repeat it
    expect(meta?.gitEmails).toEqual(['priya@acme.dev']);
    expect(readSnapshot(home, meta!.repoKey)?.serverTime).toBe(iso(now));
    expect(readDigest(home, meta!.repoKey)?.digest).toBe(digest);
    expect(readCurrentFile(home, 4242)).toMatchObject({ sessionId: SID, dev: 'deepak', cwd: repo });
    expect(readFileSync(envFile, 'utf8')).toBe("export RELAY_DEV='deepak'\nexport RELAY_PROJECT='acme-portal'\n");
    expect(spawned).toEqual([{ job: 'session-start', args: ['--session', SID, '--cwd', repo] }]);
  });

  it('hub unreachable: cached digest with a freshness label, else the offline line; never throws', async () => {
    const { rt } = makeRuntime(home, 'session-start', { now: () => now, handle: () => 'network-error' });
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo));
    const ctx = (out?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    expect(ctx).toMatch(/^<relay-digest offline="true" at="[^"]+">Relay hub unreachable at \d\d:\d\d:\d\dZ;/);

    const meta = readMeta(sessionDir(home, SID))!;
    writeDigest(home, meta.repoKey, '<relay-digest freshness="live" at="x">\n## Team now\n</relay-digest>');
    const { rt: rt2 } = makeRuntime(home, 'session-start', { handle: () => ({ status: 503, body: { error: 'down' } }) });
    const out2 = await runSessionStart(rt2, stdin.sessionStart(SID, repo, 'resume'));
    expect((out2?.hookSpecificOutput as Record<string, string>)['additionalContext']).toMatch(/^<relay-digest freshness="cached \d+s" at="x">/);
  });

  it('a 3 s hub stall stays under the 3.5 s deadline and falls back to the offline line', async () => {
    const { rt } = makeRuntime(home, 'session-start', { handle: () => ({ status: 200, body: {}, delayMs: 10_000 }) });
    const started = Date.now();
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo));
    expect(Date.now() - started).toBeLessThan(3500);
    expect((out?.hookSpecificOutput as Record<string, string>)['additionalContext']).toContain('offline="true"');
  });

  it('401 is a configuration error: the digest carries the update line and the breaker skips the next start', async () => {
    const { rt } = makeRuntime(home, 'session-start', { now: () => now, handle: () => ({ status: 401, body: { error: 'bad_token', message: 'token rejected' } }) });
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo));
    const ctx = (out?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    expect(ctx).toContain('Relay plugin needs an update (hub answered 401)');
    const { rt: rt2, ff } = makeRuntime(home, 'session-start', { now: () => now + 1000 });
    await runSessionStart(rt2, stdin.sessionStart(SID, repo));
    expect(ff.calls).toHaveLength(0);
  });

  it('resume within 12 h of the last stop requests a delta digest and keeps startSha; sessionTitle when an objective is known', async () => {
    const prior = seedMeta(home, SID, repo, { branch: 'main', startSha: 'b'.repeat(40), lastStopAt: iso(now - 3_600_000), slug: 'github.com/acme/app' });
    appendJournal(sessionDir(home, SID), { t: 'edit', at: iso(now - 60_000), path: 'apps/app/src/service.ts', tool: 'Edit', toolUseId: null });
    appendJournal(sessionDir(home, SID), { t: 'objective', at: iso(now - 60_000), objective: 'Add currency support to invoices', source: 'prompt' });
    const { rt, ff } = makeRuntime(home, 'session-start', { now: () => now, handle: () => ({ status: 200, body: { digest: '<relay-digest mode="delta">d</relay-digest>', snapshot: makeSnapshot(now), minClient: 1 } }) });
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo, 'resume'));
    const body = ff.calls[0]?.body as SessionStartRequest;
    expect(body.mode).toBe('delta');
    expect(body.since).toBe(prior.lastStopAt);
    expect(body.session.startSha).toBe('b'.repeat(40));
    expect((out?.hookSpecificOutput as Record<string, string>)['sessionTitle']).toBe('app: Add currency support to invoices');
  });

  it('placeholder identity from a previous run is sent as identityHint.placeholder once resolved', async () => {
    seedMeta(home, SID, repo, { dev: 'unknown-abc123', slug: 'github.com/acme/app', branch: 'main' });
    const { rt, ff } = makeRuntime(home, 'session-start', { now: () => now, handle: () => ({ status: 200, body: { digest: '<relay-digest>x</relay-digest>', snapshot: makeSnapshot(now), minClient: 1 } }) });
    await runSessionStart(rt, stdin.sessionStart(SID, repo, 'resume'));
    const body = ff.calls[0]?.body as SessionStartRequest;
    expect(body.identityHint.placeholder).toBe('unknown-abc123');
    expect(ff.calls[0]?.headers['x-relay-dev']).toBe('deepak');
  });

  it('compact: no network, ≤ 1,500-char re-injection from the cache', async () => {
    const meta = seedMeta(home, SID, repo, { slug: 'github.com/acme/app', branch: 'main' });
    writeSnapshot(home, meta.repoKey, makeSnapshot(now, { me: { dev: 'deepak', sessionId: SID }, sessions: [makeSession('priya')], changeSets: [makeChangeSet('cs_1', ['apps/dashboard/src/invoices.tsx'])] }), { now });
    appendJournal(sessionDir(home, SID), { t: 'objective', at: iso(now), objective: 'Wire familyId into the dashboard store', source: 'prompt' });
    const { rt, ff, spawned } = makeRuntime(home, 'session-start', { now: () => now + 5000 });
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo, 'compact'));
    const ctx = (out?.hookSpecificOutput as Record<string, string>)['additionalContext'] ?? '';
    expect(ff.calls).toHaveLength(0);
    expect(spawned).toHaveLength(0);
    expect(ctx.startsWith('<relay-digest mode="compact"')).toBe(true);
    expect(ctx).toContain('- priya · app · feat/currency');
    expect(ctx).toContain('IMPACT cs_1');
    expect(ctx).toContain('Objective: Wire familyId into the dashboard store');
    expect(ctx.length).toBeLessThanOrEqual(1500);
    expect((out?.hookSpecificOutput as Record<string, string>)['sessionTitle']).toBeUndefined();
  });

  it('no team.json and no RELAY_HUB: offline line, no fetch, still a journal and current file', async () => {
    const { rt, ff } = makeRuntime(home, 'session-start', { env: { RELAY_HUB: '', RELAY_TOKEN: '' } });
    const out = await runSessionStart(rt, stdin.sessionStart(SID, repo));
    expect(ff.calls).toHaveLength(0);
    expect((out?.hookSpecificOutput as Record<string, string>)['additionalContext']).toContain('offline="true"');
    expect(readMeta(sessionDir(home, SID))?.repo).toBe('github.com/acme/app');
  });

  it('insertDigestLines / clientDigestLines add the identity, config-error and plugin-behind facts', () => {
    expect(insertDigestLines('<relay-digest a="1">\n## x\n</relay-digest>', ['L1', 'L2'])).toBe('<relay-digest a="1">\nL1\nL2\n## x\n</relay-digest>');
    expect(insertDigestLines('<relay-digest offline="true">text</relay-digest>', ['L1'])).toBe('<relay-digest offline="true">\nL1\ntext</relay-digest>');
    expect(insertDigestLines('plain', ['L1'])).toBe('L1\nplain');
    recordWorkerFailure(home, now);
    recordConfigError(home, 426, 'client too old', now);
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, 'plugin-remote.json'), JSON.stringify({ sha: 'f'.repeat(40), checkedAt: iso(now) }));
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'relay@relay': [{ gitCommitSha: 'e'.repeat(40) }] } }));
    const { rt } = makeRuntime(home, 'session-start', { now: () => now + 1 });
    const lines = clientDigestLines(rt, { meta: { dev: 'unknown-1a2b3c', gitEmail: 'x@y' } as never }, { offline: true });
    expect(lines[0]).toMatch(/^Relay identity for this session is unknown \(git email x@y is not in the team list\)/);
    expect(lines[1]).toContain('426');
    expect(lines[2]).toMatch(/^Relay plugin is behind the marketplace \(local eeeeeee, marketplace fffffff\)/);
  });
});
