/**
 * Test harness: an in-memory PGlite hub with a fake clock, the Hono app, and a
 * request helper that speaks the wire protocol (team token, X-Relay-Dev, …).
 */
import type { Hono } from 'hono';
import {
  PROTOCOL_VERSION,
  RELAY_HEADERS,
  type CommitEvent,
  type ContractEvent,
  type EditEvent,
  type EventsRequest,
  type EventsResponse,
  type PromptEvent,
  type RelayConfig,
  type RelayEvent,
  type SessionStartRequest,
  type SessionStartResponse,
} from '@relay/core';
import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/auth.js';
import { createDb } from '../src/db/client.js';
import { createHub, type Hub } from '../src/hub.js';
import type { LlmClient } from '../src/llm.js';
import { ulid } from '../src/util/ids.js';

export const TOKEN = 'test-token';
export const PREV_TOKEN = 'prev-token';
export const ADMIN_TOKEN = 'admin-token';
export const START = '2026-09-12T09:00:00.000Z';

export interface Clock {
  now: () => Date;
  set: (iso: string) => void;
  advance: (ms: number) => void;
}

export function makeClock(start = START): Clock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (iso) => {
      t = new Date(iso).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface TestHub {
  hub: Hub;
  app: Hono<AppEnv>;
  clock: Clock;
  request: <T = unknown>(path: string, init?: RequestInit & { dev?: string; token?: string | null; session?: string; json?: unknown; client?: string; proto?: string }) => Promise<{ status: number; body: T; headers: Headers }>;
  close: () => Promise<void>;
}

export async function makeHub(opts: { llm?: LlmClient | null; clock?: Clock; rotatedAt?: Date | null } = {}): Promise<TestHub> {
  const clock = opts.clock ?? makeClock();
  const handle = await createDb({});
  const hub = await createHub({
    db: handle.db,
    dbKind: handle.kind,
    close: handle.close,
    teamSlug: 'exampleteam',
    tokens: { current: TOKEN, previous: PREV_TOKEN, rotatedAt: opts.rotatedAt === undefined ? clock.now() : opts.rotatedAt },
    adminToken: ADMIN_TOKEN,
    llm: opts.llm ?? null,
    now: clock.now,
  });
  const app = createApp(hub);
  const request: TestHub['request'] = async (path, init = {}) => {
    const { dev, token, session, json, client, proto, ...rest } = init;
    const headers = new Headers(rest.headers ?? {});
    if (token !== null) headers.set('authorization', `Bearer ${token ?? TOKEN}`);
    if (dev) headers.set(RELAY_HEADERS.dev, dev);
    if (session) headers.set(RELAY_HEADERS.session, session);
    if (client) headers.set(RELAY_HEADERS.client, client);
    if (proto) headers.set(RELAY_HEADERS.proto, proto);
    let body = rest.body;
    if (json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(json);
    }
    const res = await app.request(`http://hub.test${path}`, { ...rest, headers, body, method: rest.method ?? (json !== undefined ? 'POST' : 'GET') });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: res.status, body: parsed as never, headers: res.headers };
  };
  return {
    hub,
    app,
    clock,
    request,
    close: async () => {
      await hub.drain();
      await hub.close();
    },
  };
}

// ---------------------------------------------------------------------------
// fixtures: the demo project (§12 M0)
// ---------------------------------------------------------------------------

export const REPO = 'demo/app';
export const PROJECT = 'acme-portal';

export const CONFIG: RelayConfig = {
  project: PROJECT,
  repo: REPO,
  areas: {
    app: { paths: ['apps/app/**'], owners: ['priya'] },
    dashboard: { paths: ['apps/dashboard/**'], owners: ['arjun'] },
    contracts: { paths: ['packages/contracts/**', 'prisma/**'], shared: true },
  },
  contracts: { packages: ['@acme/contracts'] },
  depends: { dashboard: ['contracts'], app: ['contracts'] },
  impacts: { debounce_minutes: 3 },
};

export function startBody(sessionId: string, overrides: Partial<SessionStartRequest> & { branch?: string; gitEmail?: string; config?: RelayConfig | null } = {}): SessionStartRequest {
  const { branch, gitEmail, config, ...rest } = overrides;
  return {
    v: PROTOCOL_VERSION,
    session: {
      id: sessionId,
      source: 'startup',
      client: 'cli',
      host: 'mac',
      cwd: '/tmp/app',
      repo: { slug: REPO, root: '/tmp/app', project: PROJECT, config: config === undefined ? CONFIG : config, configHash: config === undefined ? 'h1' : null },
      branch: branch ?? 'main',
      worktree: null,
      startSha: 'a'.repeat(40),
      model: 'claude',
    },
    mode: 'full',
    recentShas: [],
    identityHint: { gitEmail: gitEmail ?? null },
    ...rest,
  };
}

export async function startSession(t: TestHub, dev: string, sessionId: string, overrides: Parameters<typeof startBody>[1] = {}): Promise<SessionStartResponse> {
  const res = await t.request<SessionStartResponse>('/v1/session/start', { dev, json: startBody(sessionId, overrides) });
  if (res.status !== 200) throw new Error(`session/start ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export function eventsBody(sessionId: string, events: RelayEvent[], overrides: Partial<EventsRequest> & { branch?: string; area?: string | null; objective?: string | null } = {}): EventsRequest {
  const { branch, area, objective, ...rest } = overrides;
  return {
    session: { id: sessionId, repo: REPO, branch: branch ?? 'main', worktree: null, area: area ?? null, objective: objective ?? null, objectiveSource: objective ? 'prompt' : null },
    events,
    ...rest,
  };
}

export async function postEvents(t: TestHub, dev: string, sessionId: string, events: RelayEvent[], overrides: Parameters<typeof eventsBody>[2] = {}): Promise<EventsResponse> {
  const res = await t.request<EventsResponse>('/v1/events', { dev, json: eventsBody(sessionId, events, overrides) });
  if (res.status !== 200) throw new Error(`events ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

export function editEvent(t: TestHub, path: string, extra: Partial<EditEvent> = {}): EditEvent {
  return { id: ulid(), at: t.clock.now().toISOString(), type: 'edit', path, tool: 'Edit', toolUseId: null, ...extra };
}

export function promptEvent(t: TestHub, extra: Partial<PromptEvent> = {}): PromptEvent {
  return { id: ulid(), at: t.clock.now().toISOString(), type: 'prompt', promptId: ulid(), objective: 'Add status to OrderFilter', objectiveSource: 'prompt', dirty: [], branch: 'main', ...extra };
}

export function contractEvent(t: TestHub, path: string, extra: Partial<ContractEvent> = {}): ContractEvent {
  return {
    id: ulid(),
    at: t.clock.now().toISOString(),
    type: 'contract',
    path,
    symbols: ['OrderFilter'],
    kinds: ['export'],
    hunk: '-export interface OrderFilter { customerId: string }\n+export interface OrderFilter { customerId: string; status?: OrderStatus }',
    hash: 'hash-1',
    blobId: 'b'.repeat(40),
    dependents: ['apps/dashboard/src/hooks/useOrders.ts', 'apps/app/src/api/orders.ts'],
    ...extra,
  };
}

export function commitEvent(t: TestHub, sha: string, authorEmail: string, extra: Partial<CommitEvent> = {}): CommitEvent {
  return {
    id: ulid(),
    at: t.clock.now().toISOString(),
    type: 'commit',
    sha,
    patchId: null,
    authorEmail,
    subject: 'contracts: status on OrderFilter',
    files: ['packages/contracts/src/orders.ts'],
    contracts: [{ path: 'packages/contracts/src/orders.ts', symbols: ['OrderFilter'], hash: 'hash-1', blobId: 'b'.repeat(40) }],
    ...extra,
  };
}

export const CONTRACT_PATH = 'packages/contracts/src/orders.ts';
