/** POST /v1/depindex — replaces the per-repo dependency index row (§7.4, §10.4). */
import { Hono } from 'hono';
import { z } from 'zod';
import type { OkResponse } from '@relay/core';
import type { AppEnv } from '../auth.js';
import { depindex } from '../db/schema.js';
import { upsertRepo } from '../hub.js';
import { toDate } from '../util/time.js';
import { readJson } from './common.js';

export const depindexRoutes = new Hono<AppEnv>();

const listMap = z.record(z.string(), z.array(z.string()));

const schema = z.object({
  repo: z.string().min(1),
  head: z.string().min(1),
  builtAt: z.string().optional(),
  imports: listMap.default({}),
  symbols: listMap.default({}),
  contractPaths: listMap.default({}),
});

depindexRoutes.post('/depindex', async (c) => {
  const hub = c.get('hub');
  const body = schema.parse(await readJson(c));
  const repo = (await hub.repoBySlug(body.repo)) ?? (await upsertRepo(hub, body.repo, {}));
  const builtAt = toDate(body.builtAt) ?? hub.now();
  const values = { repoId: repo.id, head: body.head, builtAt, imports: body.imports, symbols: body.symbols, contractPaths: body.contractPaths };
  await hub.db
    .insert(depindex)
    .values(values)
    .onConflictDoUpdate({ target: depindex.repoId, set: values });
  const response: OkResponse = { ok: true };
  return c.json(response);
});
