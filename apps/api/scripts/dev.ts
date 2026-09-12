/**
 * `pnpm dev` (§2.3, §12 M0): @hono/node-server on :8787 with PGlite in .data/
 * (or DATABASE_URL when set), migrations at boot and the demo seed (priya, arjun,
 * team token "demo"). Environment: RELAY_PORT, RELAY_DATA_DIR, RELAY_TEAM_TOKEN,
 * RELAY_TEAM_TOKEN_PREV, RELAY_ADMIN_TOKEN, ANTHROPIC_API_KEY, RELAY_HANDOFF_MODEL.
 */
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { createHub } from '../src/hub.js';
import { createLlm } from '../src/llm.js';
import { seedDemo } from '../src/seed.js';

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(env['RELAY_PORT'] ?? env['PORT'] ?? 8787);
  const databaseUrl = env['DATABASE_URL'] ?? null;
  const dataDir = databaseUrl ? null : resolve(env['RELAY_DATA_DIR'] ?? '.data/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true });

  const handle = await createDb({ databaseUrl, dataDir });
  const hub = await createHub({
    db: handle.db,
    dbKind: handle.kind,
    close: handle.close,
    teamSlug: env['RELAY_TEAM'] ?? 'exampleteam',
    teamName: env['RELAY_TEAM_NAME'] ?? 'Parallel Connect',
    tokens: {
      current: env['RELAY_TEAM_TOKEN'] ?? 'demo',
      previous: env['RELAY_TEAM_TOKEN_PREV'] ?? null,
      rotatedAt: env['RELAY_TEAM_TOKEN_ROTATED_AT'] ? new Date(env['RELAY_TEAM_TOKEN_ROTATED_AT']) : null,
    },
    adminToken: env['RELAY_ADMIN_TOKEN'] ?? 'demo-admin',
    llm: createLlm(env),
    version: env['RELAY_VERSION'] ?? '0.1.0-dev',
  });
  if (!env['RELAY_NO_SEED']) await seedDemo(hub);

  const app = createApp(hub);
  // never the token itself: the console and demo hub.log are readable by other local users (§11.2)
  const tokenLabel = hub.tokens.current === 'demo' ? '"demo"' : `fingerprint ${createHash('sha1').update(hub.tokens.current).digest('hex').slice(0, 8)}`;
  const server = serve({ fetch: app.fetch, port, hostname: env['RELAY_HOST'] ?? '127.0.0.1' }, (info) => {
    console.log(
      `[relay] hub listening on http://${info.address}:${info.port} (${handle.kind}${dataDir ? ` at ${dataDir}` : ''}; team token ${tokenLabel}; handoff synthesis ${hub.llm ? `on (${hub.llm.model})` : 'off — set ANTHROPIC_API_KEY'})`,
    );
  });

  const shutdown = async () => {
    console.log('[relay] shutting down');
    server.close();
    await hub.drain();
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[relay] dev server failed to start:', err);
  process.exit(1);
});
