/**
 * Test harness: a fake $RELAY_HOME with a live session (current/<ppid>.json +
 * sessions/<sid>/meta.json), an optional cached snapshot, and an MCP Client
 * connected to createRelayServer over InMemoryTransport.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { applySnapshot, makeCurrentFile, repoKey, sessionDir, writeCurrentFile, writeMeta, type SessionMeta, type Snapshot } from '@relay/core';
import { createRelayServer } from '../src/app.js';
import type { ServerOptions } from '../src/context.js';
import { resetContextCache } from '../src/context.js';
import { PROJECT, REPO } from './stub-hub.js';

export const PPID = 4242;
export const SESSION_ID = 'sess-deepak';

export interface Harness {
  home: string;
  cwd: string;
  client: Client;
  env: NodeJS.ProcessEnv;
  call: (name: string, args?: Record<string, unknown>) => Promise<ParsedResult>;
  close: () => Promise<void>;
}

export interface ParsedResult {
  raw: CallToolResult;
  text: string;
  /** text above the json block */
  head: string;
  json: unknown;
  isError: boolean;
}

export function parseResult(raw: CallToolResult): ParsedResult {
  const first = raw.content[0];
  const text = first && first.type === 'text' ? first.text : '';
  const m = /```json\n([\s\S]*?)\n```\s*$/.exec(text);
  const json = m ? (JSON.parse(m[1] ?? 'null') as unknown) : undefined;
  const head = m ? text.slice(0, m.index).trimEnd() : text;
  return { raw, text, head, json, isError: raw.isError === true };
}

export function tmpHome(prefix = 'relay-mcp-'): string {
  const base = process.env['RELAY_TEST_TMP'] ?? tmpdir();
  return mkdtempSync(join(base, prefix));
}

export function meta(home: string, cwd: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    v: 1,
    sessionId: SESSION_ID,
    dev: 'deepak',
    identitySource: 'git-email',
    repo: REPO,
    project: PROJECT,
    repoKey: repoKey(REPO),
    repoRoot: cwd,
    cwd,
    branch: 'main',
    worktree: null,
    startSha: null,
    lastStopSha: null,
    lastStopAt: null,
    client: 'cli',
    host: 'mac',
    pid: PPID,
    startedAt: new Date().toISOString(),
    source: 'startup',
    gitEmail: 'deepak@example.com',
    gitEmails: ['deepak@example.com'],
    configHash: null,
    model: null,
    pluginSha: null,
    ...extra,
  };
}

/** Write current/<ppid>.json + sessions/<sid>/meta.json for a live session. */
export function writeLiveSession(home: string, cwd: string, opts: { sessionId?: string; pid?: number; dev?: string; metaExtra?: Partial<SessionMeta> } = {}): void {
  const sessionId = opts.sessionId ?? SESSION_ID;
  const pid = opts.pid ?? PPID;
  const dev = opts.dev ?? 'deepak';
  writeCurrentFile(home, makeCurrentFile({ home, pid, sessionId, cwd, repoKey: repoKey(REPO), dev }));
  const dir = sessionDir(home, sessionId);
  mkdirSync(dir, { recursive: true });
  writeMeta(dir, meta(home, cwd, { sessionId, dev, pid, ...opts.metaExtra }));
}

export function writeCachedSnapshot(home: string, snap: Snapshot, fetchedAtMs = Date.now()): void {
  applySnapshot(home, repoKey(snap.repo.slug), snap, { sessionId: SESSION_ID, now: fetchedAtMs, myDev: 'deepak' });
}

export function writeCachedDigest(home: string, text: string): void {
  const dir = join(home, 'cache', repoKey(REPO));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'digest.md'), text);
}

export interface HarnessOptions {
  hubUrl?: string | null;
  token?: string;
  cwd?: string;
  ppid?: number;
  session?: boolean;
  snapshot?: Snapshot | null;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  resetContextCache();
  const home = tmpHome();
  const cwd = opts.cwd ?? join(home, 'repo');
  mkdirSync(cwd, { recursive: true });
  if (opts.session !== false) writeLiveSession(home, cwd, { pid: opts.ppid ?? PPID });
  if (opts.snapshot) writeCachedSnapshot(home, opts.snapshot);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    USER: 'dev',
    RELAY_HOME: home,
    RELAY_DEV: 'deepak',
    ...(opts.hubUrl === null ? {} : { RELAY_HUB: opts.hubUrl ?? 'http://127.0.0.1:9', RELAY_TOKEN: opts.token ?? 'rt_test' }),
    ...opts.env,
  };
  const serverOpts: ServerOptions = { processEnv: env, ppid: opts.ppid ?? PPID, cwd, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const server = createRelayServer(serverOpts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'relay-test', version: '0' });
  await client.connect(clientTransport);
  return {
    home,
    cwd,
    client,
    env,
    call: async (name, args = {}) => parseResult((await client.callTool({ name, arguments: args })) as CallToolResult),
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    },
  };
}
