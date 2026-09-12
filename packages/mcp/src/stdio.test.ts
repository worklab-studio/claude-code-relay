/**
 * End-to-end through the committed bundle: spawn packages/plugin/dist/mcp.mjs
 * over stdio (as Claude Code does via scripts/mcp.sh), resolve the session
 * from current/<ppid>.json where ppid is this test process, call tools
 * against the stub hub, and check a clean exit. Skipped when the bundle has
 * not been built yet (`pnpm --filter @relay/mcp build`).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOL_NAMES, RELAY_HEADERS, type WhoamiResult } from '@relay/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseResult, tmpHome, writeCachedSnapshot, writeLiveSession, SESSION_ID } from '../test/harness.js';
import { REPO, snapshot, startStubHub, type StubHub } from '../test/stub-hub.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '..', '..', 'plugin', 'dist', 'mcp.mjs');
const built = existsSync(BUNDLE);

describe.skipIf(!built)('dist/mcp.mjs over stdio', () => {
  let hub: StubHub;
  let home: string;
  let cwd: string;
  let client: Client;
  let transport: StdioClientTransport;
  const stderr: string[] = [];

  beforeAll(async () => {
    hub = await startStubHub();
    home = tmpHome('relay-mcp-stdio-');
    cwd = join(home, 'repo');
    mkdirSync(cwd, { recursive: true });
    // the child's ppid is this process: current/<process.pid>.json names the live session (§9.1)
    writeLiveSession(home, cwd, { pid: process.pid });
    writeCachedSnapshot(home, snapshot());
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', BUNDLE],
      cwd,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', RELAY_HOME: home, RELAY_HUB: hub.url, RELAY_TOKEN: 'rt_stdio', RELAY_DEV: 'deepak', RELAY_DEBUG: '1' },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
    client = new Client({ name: 'relay-stdio-test', version: '0' });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('lists the 13 tools and the instructions', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(client.getInstructions()).toContain('Relay tools report');
  });

  it('resolves the live session from current/<ppid>.json and answers whoami locally', async () => {
    const r = parseResult((await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult);
    const w = r.json as WhoamiResult;
    expect(w.sessionId).toBe(SESSION_ID);
    expect(w.sessionSource).toBe('current-file');
    expect(w.dev).toBe('deepak');
    expect(w.repo).toBe(REPO);
    expect(hub.requests).toHaveLength(0);
  });

  it('calls the hub with the §10.4 headers and renders status', async () => {
    const r = parseResult((await client.callTool({ name: 'status', arguments: {} })) as CallToolResult);
    expect(r.isError).toBe(false);
    expect(r.head).toContain('Relay status at 09:41:07Z (live)');
    const req = hub.requests[hub.requests.length - 1]!;
    expect(req.headers[RELAY_HEADERS.client]).toBe('mcp');
    expect(req.headers[RELAY_HEADERS.session]).toBe(SESSION_ID);
    expect(req.headers['authorization']).toBe('Bearer rt_stdio');
  });

  it('falls back to the cache when the hub answers 503', async () => {
    hub.handlers.set('GET /v1/query/status', () => ({ status: 503, body: { error: 'down' } }));
    const r = parseResult((await client.callTool({ name: 'status', arguments: {} })) as CallToolResult);
    expect(r.isError).toBe(false);
    expect(r.head).toContain('(cached 09:41Z)');
    expect(r.head).toContain('Relay hub answered 503');
  });

  it('exits cleanly when the client closes stdin', async () => {
    const pid = transport.pid;
    await client.close();
    // give the child a moment to see EOF and exit 0
    for (let i = 0; i < 50; i++) {
      try {
        if (pid) process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        break;
      }
    }
    let alive = false;
    try {
      if (pid) process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(stderr.join('')).toContain('relay-mcp: connected');
    expect(stderr.join('')).not.toMatch(/uncaught|unhandled/);
  });
});
