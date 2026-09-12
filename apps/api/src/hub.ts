/**
 * The Hub: one object that every route and module receives — database handle,
 * clock, token state, LLM client, per-instance caches and background-task tracking.
 * Built once per process by `createHub()`; tests build their own with a fresh
 * PGlite and a fake clock.
 */
import { and, eq } from 'drizzle-orm';
import { PLACEHOLDER_PREFIX, PROTOCOL_VERSION, type DevHandle, type RelayConfigResolved, type RepoSlug } from '@relay/core';
import { createDb, type Db, type DbKind } from './db/client.js';
import { migrate } from './db/migrate.js';
import { devs, meta, repos, teams, type DevRow, type RepoRow, type TeamRow } from './db/schema.js';
import { createLlm, type LlmClient } from './llm.js';
import { ulid } from './util/ids.js';
import { defaultProject, resolveConfig } from './util/config.js';

export interface TokenState {
  current: string;
  previous: string | null;
  /** when `previous` stopped being current; the 14-day grace counts from here (§3.3) */
  rotatedAt: Date | null;
}

export interface HubOptions {
  db: Db;
  dbKind: DbKind;
  teamSlug: string;
  teamName?: string;
  tokens: { current: string; previous?: string | null; rotatedAt?: Date | null };
  adminToken?: string | null;
  llm?: LlmClient | null;
  now?: () => Date;
  minClient?: number;
  version?: string;
  close?: () => Promise<void>;
}

export interface Hub {
  db: Db;
  dbKind: DbKind;
  version: string;
  minClient: number;
  team: TeamRow;
  tokens: TokenState;
  adminToken: string | null;
  llm: LlmClient | null;
  now: () => Date;
  /** run work after the response (Vercel waitUntil when present, else detached but tracked) */
  background: (label: string, work: () => Promise<unknown>) => void;
  /** await every tracked background task (tests, dev shutdown) */
  drain: () => Promise<void>;
  cache: HubCache;
  /** dev lookups (placeholders resolved through merged_into) */
  devByHandle: (handle: DevHandle, upsert?: boolean) => Promise<DevRow | null>;
  devById: (id: string) => Promise<DevRow | null>;
  repoBySlug: (slug: RepoSlug) => Promise<RepoRow | null>;
  repoById: (id: string) => Promise<RepoRow | null>;
  configOf: (repo: RepoRow) => RelayConfigResolved;
  invalidateRepo: (slug: RepoSlug) => void;
  close: () => Promise<void>;
}

export interface HubCache {
  snapshots: Map<string, { at: number; value: unknown; repo: RepoSlug }>;
  devs: Map<string, DevRow>;
  repos: Map<string, RepoRow>;
  configs: Map<string, { hash: string | null; value: RelayConfigResolved }>;
  /** per-team request counter for the soft 60 req/s limit (§10.4) */
  rate: { windowStart: number; count: number };
}

const VERCEL_CONTEXT = Symbol.for('@vercel/request-context');

function vercelWaitUntil(p: Promise<unknown>): boolean {
  const holder = (globalThis as Record<symbol, unknown>)[VERCEL_CONTEXT] as
    | { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }
    | undefined;
  const ctx = holder?.get?.();
  if (ctx?.waitUntil) {
    ctx.waitUntil(p);
    return true;
  }
  return false;
}

export async function createHub(opts: HubOptions): Promise<Hub> {
  const { db } = opts;
  await migrate(db);
  const now = opts.now ?? (() => new Date());
  const team = await ensureTeam(db, opts.teamSlug, opts.teamName ?? opts.teamSlug, now());
  // the 14-day grace for a previous token counts from the rotation; when the deployment
  // does not say when that was, the first boot that sees RELAY_TEAM_TOKEN_PREV records it (§3.3)
  let rotatedAt = opts.tokens.rotatedAt ?? null;
  if (opts.tokens.previous && !rotatedAt) {
    const [row] = await db.select().from(meta).where(eq(meta.key, 'token_rotated_at')).limit(1);
    const stored = typeof row?.value === 'string' ? new Date(row.value) : null;
    if (stored && !Number.isNaN(stored.getTime())) {
      rotatedAt = stored;
    } else {
      rotatedAt = now();
      await db.insert(meta).values({ key: 'token_rotated_at', value: rotatedAt.toISOString() }).onConflictDoUpdate({ target: meta.key, set: { value: rotatedAt.toISOString() } });
    }
  }

  const cache: HubCache = {
    snapshots: new Map(),
    devs: new Map(),
    repos: new Map(),
    configs: new Map(),
    rate: { windowStart: 0, count: 0 },
  };
  const pending = new Set<Promise<unknown>>();

  const hub: Hub = {
    db,
    dbKind: opts.dbKind,
    version: opts.version ?? '0.1.0',
    minClient: opts.minClient ?? PROTOCOL_VERSION,
    team,
    tokens: {
      current: opts.tokens.current,
      previous: opts.tokens.previous ?? null,
      rotatedAt,
    },
    adminToken: opts.adminToken ?? null,
    llm: opts.llm ?? null,
    now,
    background(label, work) {
      const p = work().catch((err: unknown) => {
        console.error(`[relay] background ${label} failed:`, err instanceof Error ? err.message : err);
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
      vercelWaitUntil(p);
    },
    async drain() {
      // background tasks may enqueue more background tasks (handoff -> notifications)
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    cache,
    async devByHandle(handle, upsert = true) {
      const cached = cache.devs.get(handle);
      if (cached) return resolveMerged(cached);
      const [row] = await db
        .select()
        .from(devs)
        .where(and(eq(devs.teamId, team.id), eq(devs.handle, handle)))
        .limit(1);
      if (row) {
        cache.devs.set(handle, row);
        return resolveMerged(row);
      }
      if (!upsert) return null;
      const at = now();
      const fresh: DevRow = {
        id: 'dev_' + ulid(at.getTime()),
        teamId: team.id,
        handle,
        name: null,
        github: null,
        placeholder: handle.startsWith(PLACEHOLDER_PREFIX),
        mergedInto: null,
        emails: [],
        firstSeenAt: at,
        lastSeenAt: at,
      };
      await db.insert(devs).values(fresh).onConflictDoNothing();
      const [again] = await db
        .select()
        .from(devs)
        .where(and(eq(devs.teamId, team.id), eq(devs.handle, handle)))
        .limit(1);
      const row2 = again ?? fresh;
      cache.devs.set(handle, row2);
      return resolveMerged(row2);
    },
    async devById(id) {
      for (const d of cache.devs.values()) if (d.id === id) return d;
      const [row] = await db.select().from(devs).where(eq(devs.id, id)).limit(1);
      if (row) cache.devs.set(row.handle, row);
      return row ?? null;
    },
    async repoBySlug(slug) {
      const cached = cache.repos.get(slug);
      if (cached) return cached;
      const [row] = await db
        .select()
        .from(repos)
        .where(and(eq(repos.teamId, team.id), eq(repos.slug, slug)))
        .limit(1);
      if (row) cache.repos.set(slug, row);
      return row ?? null;
    },
    async repoById(id) {
      for (const r of cache.repos.values()) if (r.id === id) return r;
      const [row] = await db.select().from(repos).where(eq(repos.id, id)).limit(1);
      if (row) cache.repos.set(row.slug, row);
      return row ?? null;
    },
    configOf(repo) {
      const hit = cache.configs.get(repo.id);
      if (hit && hit.hash === repo.configHash) return hit.value;
      const value = resolveConfig(repo.slug, repo.config, repo.project);
      cache.configs.set(repo.id, { hash: repo.configHash, value });
      return value;
    },
    invalidateRepo(slug) {
      for (const [key, entry] of cache.snapshots) {
        if (entry.repo === slug) cache.snapshots.delete(key);
      }
    },
    close: opts.close ?? (async () => {}),
  };

  async function resolveMerged(row: DevRow): Promise<DevRow> {
    if (!row.mergedInto) return row;
    const target = await hub.devByHandle(row.mergedInto, false);
    return target ?? row;
  }

  return hub;
}

async function ensureTeam(db: Db, slug: string, name: string, at: Date): Promise<TeamRow> {
  const [existing] = await db.select().from(teams).where(eq(teams.slug, slug)).limit(1);
  if (existing) return existing;
  const row: TeamRow = { id: 'team_' + ulid(at.getTime()), slug, name, createdAt: at };
  await db.insert(teams).values(row).onConflictDoNothing();
  const [again] = await db.select().from(teams).where(eq(teams.slug, slug)).limit(1);
  return again ?? row;
}

/** Upserts a repo row from a session start (§10.4); returns the fresh row. */
export async function upsertRepo(
  hub: Hub,
  slug: RepoSlug,
  input: { project?: string | null; config?: RepoRow['config']; configHash?: string | null },
): Promise<RepoRow> {
  const existing = await hub.repoBySlug(slug);
  const project = input.project ?? input.config?.project ?? existing?.project ?? defaultProject(slug);
  if (!existing) {
    const at = hub.now();
    const row: RepoRow = {
      id: 'repo_' + ulid(at.getTime()),
      teamId: hub.team.id,
      slug,
      project,
      config: input.config ?? null,
      configHash: input.configHash ?? null,
      firstSeenAt: at,
    };
    await hub.db.insert(repos).values(row).onConflictDoNothing();
    hub.cache.repos.delete(slug);
    return (await hub.repoBySlug(slug)) ?? row;
  }
  const configChanged = input.configHash !== undefined && input.configHash !== existing.configHash;
  const projectChanged = project !== existing.project;
  if (configChanged || projectChanged) {
    await hub.db
      .update(repos)
      .set({
        project,
        config: configChanged ? (input.config ?? null) : existing.config,
        configHash: configChanged ? (input.configHash ?? null) : existing.configHash,
      })
      .where(eq(repos.id, existing.id));
    hub.cache.repos.delete(slug);
    hub.cache.configs.delete(existing.id);
    hub.invalidateRepo(slug);
    return (await hub.repoBySlug(slug)) ?? existing;
  }
  return existing;
}

/** Process-level hub for the Vercel entry and `pnpm dev`, built from the environment. */
let processHub: Promise<Hub> | null = null;

export function getProcessHub(): Promise<Hub> {
  if (!processHub) processHub = buildFromEnv();
  return processHub;
}

async function buildFromEnv(): Promise<Hub> {
  const env = process.env;
  const handle = await createDb({
    databaseUrl: env['DATABASE_URL'] ?? null,
    dataDir: env['DATABASE_URL'] ? null : (env['RELAY_DATA_DIR'] ?? '.data/pglite'),
  });
  const rotatedAt = env['RELAY_TEAM_TOKEN_ROTATED_AT'] ? new Date(env['RELAY_TEAM_TOKEN_ROTATED_AT']) : null;
  return createHub({
    db: handle.db,
    dbKind: handle.kind,
    close: handle.close,
    teamSlug: env['RELAY_TEAM'] ?? 'exampleteam',
    teamName: env['RELAY_TEAM_NAME'] ?? env['RELAY_TEAM'] ?? 'Parallel Connect',
    tokens: {
      current: env['RELAY_TEAM_TOKEN'] ?? 'demo',
      previous: env['RELAY_TEAM_TOKEN_PREV'] ?? null,
      rotatedAt: rotatedAt && !Number.isNaN(rotatedAt.getTime()) ? rotatedAt : null,
    },
    adminToken: env['RELAY_ADMIN_TOKEN'] ?? null,
    llm: createLlm(env),
    version: env['RELAY_VERSION'] ?? '0.1.0',
  });
}
