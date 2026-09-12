/**
 * Auth on every /v1 route (§10.4): `Authorization: Bearer <team token>` — the
 * current token, or the previous one within the 14-day rotation grace, which adds
 * `X-Relay-Warn: token-rotated` (§3.3); `X-Relay-Dev` is the self-declared handle
 * (unknown handles are upserted, placeholders resolve through merged_into);
 * `X-Relay-Proto` below the hub's minimum answers 426. Admin routes use
 * `RELAY_ADMIN_TOKEN` only.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { HTTP_STATUS, LIMITS, RELAY_HEADERS, type HubErrorBody, type HubWarning, type RequestClient } from '@relay/core';
import type { Hub } from './hub.js';
import type { DevRow } from './db/schema.js';
import { isValidHandle } from './util/ids.js';

export type AppEnv = {
  Variables: {
    hub: Hub;
    dev: DevRow;
    client: RequestClient;
    sessionHeader: string | null;
    pluginSha: string | null;
    warn: HubWarning[];
  };
};

export function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? null;
}

export type TokenCheck = 'current' | 'previous' | 'invalid';

export function checkTeamToken(hub: Hub, token: string | null, now: Date): TokenCheck {
  if (!token) return 'invalid';
  if (safeEqual(token, hub.tokens.current)) return 'current';
  if (hub.tokens.previous && safeEqual(token, hub.tokens.previous)) {
    const rotatedAt = hub.tokens.rotatedAt ?? now;
    if (now.getTime() - rotatedAt.getTime() <= LIMITS.tokenGraceMs) return 'previous';
  }
  return 'invalid';
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function errorBody(error: string, message?: string, extra?: Partial<HubErrorBody>): HubErrorBody {
  return { error, ...(message ? { message } : {}), ...extra };
}

export function teamAuth(hub: Hub): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const now = hub.now();
    const check = checkTeamToken(hub, bearer(c), now);
    if (check === 'invalid') {
      return c.json(errorBody('bad_token', 'team token not accepted; update the plugin: claude plugin marketplace update relay && claude plugin update relay@relay'), HTTP_STATUS.badToken);
    }
    const proto = c.req.header(RELAY_HEADERS.proto);
    if (proto !== undefined) {
      const v = Number(proto);
      if (Number.isFinite(v) && v < hub.minClient) {
        return c.json(
          errorBody('client_too_old', `Relay plugin protocol ${v} is below the hub minimum ${hub.minClient}; update the plugin: claude plugin marketplace update relay && claude plugin update relay@relay`, { minClient: hub.minClient }),
          HTTP_STATUS.clientTooOld,
        );
      }
    }
    const handle = (c.req.header(RELAY_HEADERS.dev) ?? '').trim();
    if (!isValidHandle(handle)) {
      return c.json(errorBody('missing_dev', 'X-Relay-Dev header with the developer handle is required'), 400);
    }
    const dev = await hub.devByHandle(handle, true);
    if (!dev) return c.json(errorBody('missing_dev'), 400);
    const warn: HubWarning[] = check === 'previous' ? ['token-rotated'] : [];
    if (check === 'previous') c.header(RELAY_HEADERS.warn, 'token-rotated');
    c.set('hub', hub);
    c.set('dev', dev);
    c.set('warn', warn);
    const client = (c.req.header(RELAY_HEADERS.client) ?? 'cli') as RequestClient;
    c.set('client', client === 'desktop' || client === 'mcp' ? client : 'cli');
    c.set('sessionHeader', c.req.header(RELAY_HEADERS.session) ?? null);
    c.set('pluginSha', c.req.header(RELAY_HEADERS.plugin) ?? null);
    await next();
  };
}

export function adminAuth(hub: Hub): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (!hub.adminToken || !token || !safeEqual(token, hub.adminToken)) {
      return c.json(errorBody('admin_token', 'admin token required'), HTTP_STATUS.badToken);
    }
    c.set('hub', hub);
    await next();
  };
}
