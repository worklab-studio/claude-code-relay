/**
 * The Relay hub as a Hono app (§10.4): `/health` unauthenticated, `/v1/*` behind
 * the team token, `/admin/*` behind the admin token, error mapping
 * (400/401/404/409/413/426/429/500) and the per-team 60 req/s soft limit.
 */
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { HTTP_STATUS, type HealthResponse } from '@relay/core';
import { adminAuth, errorBody, teamAuth, type AppEnv } from './auth.js';
import type { Hub } from './hub.js';
import { actionRoutes } from './routes/actions.js';
import { adminRoutes } from './routes/admin.js';
import { HttpError } from './routes/common.js';
import { depindexRoutes } from './routes/depindex.js';
import { eventRoutes } from './routes/events.js';
import { queryRoutes } from './routes/query.js';
import { sessionRoutes } from './routes/session.js';

export const RATE_LIMIT_PER_SECOND = 60;

export function createApp(hub: Hub): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json(errorBody('bad_body', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')), 400);
    }
    console.error('[relay] unhandled error:', err);
    return c.json(errorBody('internal', err instanceof Error ? err.message : String(err)), 500);
  });

  app.get('/health', (c) => {
    const body: HealthResponse = { ok: true, version: hub.version, db: hub.dbKind, time: hub.now().toISOString() };
    return c.json(body);
  });

  const v1 = new Hono<AppEnv>();
  v1.use('*', async (c, next) => {
    // per-team soft limit (§10.4 429); one counter per instance is enough for a 4-person shop
    const nowMs = hub.now().getTime();
    const rate = hub.cache.rate;
    if (nowMs - rate.windowStart >= 1000) {
      rate.windowStart = nowMs;
      rate.count = 0;
    }
    rate.count += 1;
    if (rate.count > RATE_LIMIT_PER_SECOND) {
      return c.json(errorBody('rate_limited', 'per-team request limit exceeded'), HTTP_STATUS.rateLimited);
    }
    await next();
  });
  v1.use('*', teamAuth(hub));
  v1.route('/', sessionRoutes);
  v1.route('/', eventRoutes);
  v1.route('/', queryRoutes);
  v1.route('/', actionRoutes);
  v1.route('/', depindexRoutes);
  app.route('/v1', v1);

  const admin = new Hono<AppEnv>();
  admin.use('*', adminAuth(hub));
  admin.route('/', adminRoutes);
  app.route('/admin', admin);

  app.notFound((c) => c.json(errorBody('not_found', `${c.req.method} ${c.req.path}`), 404));
  return app;
}
