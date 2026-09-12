import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { readBreaker, recordConfigError } from './breaker.js';
import { HubClient, makeEvent, postWithWal, walSender } from './http.js';
import { drainOutbox, listOutbox, outboxPath } from './outbox.js';
import { makeSnapshot } from '../test/fixtures.js';
import { LIMITS, RELAY_HEADERS, type EditEvent, type EventsRequest, type Snapshot } from './protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
function home(): string {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t.home;
}

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const body: EventsRequest = {
  session: { id: 's1', repo: 'r', branch: 'main', worktree: null, area: null, objective: null, objectiveSource: null },
  events: [makeEvent<EditEvent>({ type: 'edit', path: 'a.ts', tool: 'Edit', toolUseId: null })],
};

describe('HubClient', () => {
  it('sends the §10.4 headers and surfaces snapshot + warn', async () => {
    const snap: Snapshot = makeSnapshot(Date.now());
    const seen: Snapshot[] = [];
    const ff = fakeFetch(() => json({ snapshot: snap, inbox: [] }, 200, { [RELAY_HEADERS.warn]: 'token-rotated' }));
    const c = new HubClient({ hub: 'http://hub/', token: 'rt_t', dev: 'deepak', client: 'cli', sessionId: 's1', pluginSha: 'abc', fetch: ff.fetch, onSnapshot: (s) => seen.push(s) });
    const r = await c.post<{ inbox: unknown[] }>('/v1/events', body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warn).toEqual(['token-rotated']);
    expect(r.snapshot).toEqual(snap);
    expect(seen).toHaveLength(1);
    const h = ff.calls[0]!.init.headers as Record<string, string>;
    expect(ff.calls[0]!.url).toBe('http://hub/v1/events');
    expect(h['authorization']).toBe('Bearer rt_t');
    expect(h[RELAY_HEADERS.dev]).toBe('deepak');
    expect(h[RELAY_HEADERS.session]).toBe('s1');
    expect(h[RELAY_HEADERS.plugin]).toBe('abc');
    expect(h[RELAY_HEADERS.proto]).toBe('1');
    // GET with query and a bare snapshot body
    const ff2 = fakeFetch(() => json(snap));
    const c2 = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'mcp', fetch: ff2.fetch });
    const g = await c2.get<Snapshot>('/v1/snapshot', { repo: 'github.com/acme/app' });
    expect(g.ok && g.snapshot?.repo.slug).toBe('github.com/acme/app');
    expect(ff2.calls[0]!.url).toBe('http://hub/v1/snapshot?repo=github.com%2Facme%2Fapp');
  });

  it('times out within the budget without throwing; sync role writes refresh-wanted, worker role counts failures', async () => {
    const h = home();
    const slow = fakeFetch((_u, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))));
    const sync = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: slow.fetch, home: h, role: 'sync' });
    const started = Date.now();
    const r = await sync.get('/v1/snapshot', {}, { budgetMs: 60 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('timeout');
    expect(readBreaker(h).count).toBe(0); // sync path never opens the breaker (§4.0 rule 5)
    expect(existsSync(`${h}/refresh-wanted`)).toBe(true);
    const worker = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: slow.fetch, home: h, role: 'worker' });
    await worker.post('/v1/events', body, { budgetMs: 30 });
    expect(readBreaker(h).count).toBe(1);
    await worker.post('/v1/events', body, { budgetMs: 30 });
    expect(readBreaker(h).open).toBe(true);
    const blocked = await worker.post('/v1/events', body);
    expect(!blocked.ok && blocked.kind).toBe('breaker');
    const okFetch = fakeFetch(() => json({ ok: true }));
    const w2 = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: okFetch.fetch, home: h, role: 'worker' });
    const forced = await w2.post('/v1/events', body, { ignoreBreaker: true });
    expect(forced.ok).toBe(true);
    expect(readBreaker(h).open).toBe(false); // success resets
  });

  it('413 is a permanent rejection of one body, never a breaker; oversized bodies are refused before the wire (review)', async () => {
    const h = home();
    const ff = fakeFetch(() => json({ error: 'payload_too_large' }, 413));
    const c = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: ff.fetch, home: h, role: 'worker' });
    const r = await c.post('/v1/events', body);
    expect(!r.ok && r.kind).toBe('http');
    expect(!r.ok && r.status).toBe(413);
    expect(!r.ok && r.retryable).toBe(false);
    expect(readBreaker(h).open).toBe(false);
    expect(readBreaker(h).configError).toBeNull();
    // a body over the client cap never reaches fetch
    const huge = { ...body, events: [{ ...body.events[0]!, hunk: 'x'.repeat(LIMITS.payloadClientMaxBytes) }] };
    const r2 = await c.post('/v1/events', huge);
    expect(!r2.ok && r2.status).toBe(413);
    expect(ff.calls).toHaveLength(1);
    const w = await postWithWal(c, h, { sessionId: 's1', kind: 'events', endpoint: '/v1/events', body: huge });
    expect(w.entry).toBeNull();
    expect(w.durable).toBe(false);
    expect(listOutbox(h).entries).toHaveLength(0);
  });

  it('treats 401/426 as configuration errors (10-min breaker) and 5xx/429 as outages', async () => {
    const h = home();
    const ff = fakeFetch(() => json({ error: 'client_too_old', message: 'update', minClient: 2 }, 426));
    const c = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: ff.fetch, home: h, role: 'worker' });
    const r = await c.post('/v1/events', body);
    expect(!r.ok && r.kind).toBe('config');
    expect(!r.ok && r.retryable).toBe(false);
    const b = readBreaker(h);
    expect(b.open).toBe(true);
    expect(b.configError?.status).toBe(426);
    const h2 = home();
    const c2 = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: fakeFetch(() => json({ error: 'boom' }, 503)).fetch, home: h2, role: 'worker' });
    const r2 = await c2.post('/v1/events', body);
    expect(!r2.ok && r2.kind).toBe('http');
    expect(!r2.ok && r2.retryable).toBe(true);
    expect(readBreaker(h2).count).toBe(1);
    const c3 = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: fakeFetch(() => json({ error: 'bad' }, 400)).fetch, home: h2, role: 'worker' });
    const r3 = await c3.post('/v1/events', body);
    expect(!r3.ok && r3.retryable).toBe(false);
    expect(readBreaker(h2).count).toBe(1); // permanent 4xx is not an outage
    const c4 = new HubClient({ hub: '', token: '', dev: 'd', client: 'cli' });
    expect(!(await c4.post('/x', {})).ok).toBe(true);
    const c5 = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: fakeFetch(() => { throw new Error('ECONNREFUSED'); }).fetch });
    const r5 = await c5.post('/x', {});
    expect(!r5.ok && r5.kind).toBe('network');
  });
});

describe('postWithWal', () => {
  it('writes the WAL first, deletes it on 2xx, keeps it on transient failure, drops it on config error', async () => {
    const h = home();
    let mode: 'ok' | 'down' | 'config' = 'down';
    const ff = fakeFetch(() => (mode === 'ok' ? json({ snapshot: makeSnapshot(Date.now()), inbox: [] }) : mode === 'config' ? json({ error: 'bad token' }, 401) : json({ error: 'x' }, 502)));
    const c = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: ff.fetch, home: h, role: 'worker' });
    const input = { sessionId: 's1', kind: 'events' as const, endpoint: '/v1/events', body };
    const r1 = await postWithWal(c, h, input);
    expect(r1.result.ok).toBe(false);
    expect(r1.entry && existsSync(outboxPath(h, r1.entry.id))).toBe(true);
    mode = 'ok';
    const r2 = await postWithWal(c, h, input);
    expect(r2.result.ok).toBe(true);
    expect(r2.entry && existsSync(outboxPath(h, r2.entry.id))).toBe(false);
    expect(listOutbox(h).entries).toHaveLength(1); // r1 still queued for the drain
    mode = 'config';
    const r3 = await postWithWal(c, h, input);
    expect(!r3.result.ok && r3.result.kind).toBe('config');
    expect(r3.entry && existsSync(outboxPath(h, r3.entry.id))).toBe(false); // never enqueued (§4.0 rule 5)
    // while the config breaker is open nothing is written at all
    const r4 = await postWithWal(c, h, input);
    expect(r4.entry).toBeNull();
    expect(!r4.result.ok && r4.result.kind).toBe('config');
    expect(listOutbox(h).entries).toHaveLength(1);
  });

  it('onDurable fires once when the body is accepted or kept in the WAL, never for a config error or behind its breaker (review)', async () => {
    const h = home();
    let mode: 'ok' | 'down' | 'config' = 'ok';
    const ff = fakeFetch(() => (mode === 'ok' ? json({ snapshot: makeSnapshot(Date.now()), inbox: [] }) : mode === 'config' ? json({ error: 'bad token' }, 401) : json({ error: 'x' }, 502)));
    const c = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: ff.fetch, home: h, role: 'worker' });
    const input = { sessionId: 's1', kind: 'events' as const, endpoint: '/v1/events', body };
    const seen: Array<string | null> = [];
    const r = await postWithWal(c, h, input, { onDurable: (e) => void seen.push(e ? 'wal' : 'ok') });
    expect(r.durable).toBe(true);
    expect(seen).toEqual(['ok']);
    mode = 'down';
    const r2 = await postWithWal(c, h, input, { onDurable: (e) => void seen.push(e ? 'wal' : 'ok') });
    expect(r2.durable).toBe(true); // kept for the drain
    expect(seen).toEqual(['ok', 'wal']);
    mode = 'config';
    const r3 = await postWithWal(c, h, input, { onDurable: (e) => void seen.push(e ? 'wal' : 'ok') });
    expect(r3.durable).toBe(false); // discarded: the caller must not journal it
    expect(seen).toEqual(['ok', 'wal']);
    // config breaker now open: nothing is written, the callback never fires
    const r4 = await postWithWal(c, h, input, { onDurable: (e) => void seen.push(e ? 'wal' : 'ok') });
    expect(r4.durable).toBe(false);
    expect(seen).toEqual(['ok', 'wal']);
    expect(!r4.result.ok && r4.result.kind).toBe('config');
  });

  it('a hook killed mid-request leaves the body for the drain, which replays it with its own sessionId/at', async () => {
    const h = home();
    const never = fakeFetch(() => new Promise(() => undefined));
    const c = new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: never.fetch, home: h, role: 'worker' });
    const pending = postWithWal(c, h, { sessionId: 'dead-session', kind: 'events', endpoint: '/v1/events', body, now: Date.now() - 60_000, at: new Date(Date.now() - 60_000).toISOString() });
    void pending; // never settles: simulates the process dying
    await new Promise((r) => setTimeout(r, 20));
    const queued = listOutbox(h).entries;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.sessionId).toBe('dead-session');
    const received: EventsRequest[] = [];
    const ok = fakeFetch((_u, init) => {
      received.push(JSON.parse(String(init.body)) as EventsRequest);
      return json({ snapshot: makeSnapshot(Date.now()), inbox: [] });
    });
    const later = new HubClient({ hub: 'http://hub', token: 't', dev: 'other', client: 'cli', fetch: ok.fetch, home: h, role: 'worker' });
    const r = await drainOutbox(h, walSender(later));
    expect(r.sent).toHaveLength(1);
    expect(received[0]?.replay).toBe(true);
    expect(received[0]?.session.id).toBe('s1');
    expect(listOutbox(h).entries).toHaveLength(0);
    // a config error during the drain discards and stops
    const h2 = home();
    recordConfigError(h2, 401, 'x');
    const r2 = await postWithWal(new HubClient({ hub: 'http://hub', token: 't', dev: 'd', client: 'cli', fetch: ok.fetch, home: h2 }), h2, { sessionId: 's', kind: 'events', endpoint: '/v1/events', body });
    expect(r2.entry).toBeNull();
  });
});
