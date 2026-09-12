/**
 * Database client: `DATABASE_URL` -> Neon (@neondatabase/serverless Pool over
 * WebSocket, so transactions and the per-session advisory lock of §8.1 work),
 * else PGlite in a directory (`pnpm dev`, demos) or in memory (tests). One Drizzle
 * schema for both (§2.3, §10.1).
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type DbKind = 'pglite' | 'neon';
/** Driver-agnostic database handle; transactions (`db.transaction`) yield the same type. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: DbKind;
  close: () => Promise<void>;
}

export interface DbOptions {
  /** Neon connection string; wins over dataDir */
  databaseUrl?: string | null;
  /** PGlite data directory; omit for an in-memory database */
  dataDir?: string | null;
}

export async function createDb(opts: DbOptions = {}): Promise<DbHandle> {
  if (opts.databaseUrl) {
    return createNeon(opts.databaseUrl);
  }
  const client = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzlePglite({ client, schema }) as unknown as Db;
  return { db, kind: 'pglite', close: () => client.close() };
}

async function createNeon(url: string): Promise<DbHandle> {
  const neon = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-serverless');
  if (typeof globalThis.WebSocket === 'undefined') {
    // Node < 22 has no global WebSocket; the `ws` package fills in when installed.
    try {
      const wsModule = 'ws';
      const ws = (await import(wsModule)) as { default?: unknown };
      neon.neonConfig.webSocketConstructor = (ws.default ?? ws) as typeof neon.neonConfig.webSocketConstructor;
    } catch {
      // leave it to the runtime; Neon reports a clear error if no WebSocket exists
    }
  }
  const pool = new neon.Pool({ connectionString: url });
  const db = drizzle({ client: pool, schema }) as unknown as Db;
  return { db, kind: 'neon', close: () => pool.end() };
}

/** Rows of a raw `db.execute(sql...)` result, whichever driver produced it. */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
