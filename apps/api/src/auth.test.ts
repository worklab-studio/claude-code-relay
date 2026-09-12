import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, RELAY_HEADERS, type HealthResponse } from '@relay/core';
import { createHub, teamTokenFromEnv } from './hub.js';
import { makeHub, makeClock, PREV_TOKEN, TOKEN, startSession, type TestHub } from '../test/helpers.js';

let t: TestHub | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('auth (§10.4, §3.3 dual-token rotation)', () => {
  it('serves /health without a token', async () => {
    t = await makeHub();
    const res = await t.request<HealthResponse>('/health', { token: null });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe('pglite');
  });

  it('rejects a missing or wrong token with 401 and requires X-Relay-Dev', async () => {
    t = await makeHub();
    expect((await t.request('/v1/snapshot', { token: null, dev: 'priya' })).status).toBe(401);
    expect((await t.request('/v1/snapshot', { token: 'nope', dev: 'priya' })).status).toBe(401);
    const noDev = await t.request<{ error: string }>('/v1/snapshot');
    expect(noDev.status).toBe(400);
    expect(noDev.body.error).toBe('missing_dev');
  });

  it('accepts the previous token during the 14-day grace and flags it', async () => {
    const clock = makeClock();
    t = await makeHub({ clock, rotatedAt: clock.now() });
    await startSession(t, 'priya', 's1');
    const ok = await t.request('/v1/snapshot?repo=demo/app', { dev: 'priya', token: PREV_TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.headers.get(RELAY_HEADERS.warn)).toBe('token-rotated');
    expect((ok.body as { warn?: string[] }).warn).toEqual(['token-rotated']);

    clock.advance(LIMITS.tokenGraceMs + 1);
    const expired = await t.request('/v1/snapshot?repo=demo/app', { dev: 'priya', token: PREV_TOKEN });
    expect(expired.status).toBe(401);
    const current = await t.request('/v1/snapshot?repo=demo/app', { dev: 'priya' });
    expect(current.status).toBe(200);
    expect(current.headers.get(RELAY_HEADERS.warn)).toBeNull();
  });

  it('answers 426 for a protocol below the minimum', async () => {
    t = await makeHub();
    const res = await t.request<{ error: string; minClient: number }>('/v1/snapshot', { dev: 'priya', proto: '0' });
    expect(res.status).toBe(426);
    expect(res.body.minClient).toBe(1);
  });

  it('rejects oversized payloads with 413', async () => {
    t = await makeHub();
    const res = await t.request('/v1/events', { dev: 'priya', method: 'POST', body: 'x'.repeat(LIMITS.payloadMaxBytes + 1), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(413);
  });

  it('protects admin routes with the admin token', async () => {
    t = await makeHub();
    expect((await t.request('/admin/export?project=acme-portal', { dev: 'priya' })).status).toBe(401);
    const res = await t.request<{ ok: boolean; graceUntil: string }>('/admin/token/rotate', { token: 'admin-token', json: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('a rotation is persisted: a hub booting with the old env token picks up the new pair (review)', async () => {
    t = await makeHub();
    const res = await t.request<{ ok: boolean }>('/admin/token/rotate', { token: 'admin-token', json: { current: 'rt_new' } });
    expect(res.status).toBe(200);
    expect((await t.request('/v1/snapshot?repo=demo/app', { token: 'rt_new', dev: 'priya' })).status).not.toBe(401);
    // another instance boots from the same database with the env one rotation behind
    const again = await createHub({ db: t.hub.db, dbKind: t.hub.dbKind, teamSlug: 'exampleteam', tokens: { current: TOKEN, previous: PREV_TOKEN }, now: t.clock.now });
    expect(again.tokens.current).toBe('rt_new');
    expect(again.tokens.previous).toBe(TOKEN);
    // an env naming an unrelated token is a deliberate override and wins
    const override = await createHub({ db: t.hub.db, dbKind: t.hub.dbKind, teamSlug: 'exampleteam', tokens: { current: 'rt_manual', previous: null }, now: t.clock.now });
    expect(override.tokens.current).toBe('rt_manual');
  });

  it('a hosted hub refuses to boot without RELAY_TEAM_TOKEN; the demo token needs an explicit opt-in (review)', () => {
    expect(() => teamTokenFromEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/RELAY_TEAM_TOKEN/);
    expect(() => teamTokenFromEnv({})).toThrow(/RELAY_TEAM_TOKEN/);
    expect(teamTokenFromEnv({ RELAY_ALLOW_DEMO_TOKEN: '1' })).toBe('demo');
    expect(() => teamTokenFromEnv({ DATABASE_URL: 'postgres://x', RELAY_ALLOW_DEMO_TOKEN: '1' })).toThrow(/RELAY_TEAM_TOKEN/);
    expect(teamTokenFromEnv({ DATABASE_URL: 'postgres://x', RELAY_TEAM_TOKEN: 'rt_x' })).toBe('rt_x');
  });
});
