/**
 * Hub access for the tools: GET/POST through core's HubClient with the 5 s
 * MCP budget (§9.1), plus the cached-digest section reader used by the
 * fallbacks of `handoffs` and `decisions` (the snapshot carries neither).
 */
import { readDigest, type HubResult } from '@relay/core';
import { HUB_OPTS, type CallContext } from './context.js';

/** Read tools consult the breaker (an open breaker answers from the cache at once). */
export function hubGet<T>(ctx: CallContext, path: string, query: Record<string, string | undefined> = {}): Promise<HubResult<T> | null> {
  if (!ctx.client) return Promise.resolve(null);
  return ctx.client.get<T>(path, { repo: ctx.repo ?? undefined, ...query }, HUB_OPTS);
}

/** Write tools always try (the developer asked explicitly) and report honestly (§9.1). */
export function hubPost<T>(ctx: CallContext, path: string, body: Record<string, unknown>): Promise<HubResult<T> | null> {
  if (!ctx.client) return Promise.resolve(null);
  const withRepo = ctx.repo && body['repo'] === undefined ? { ...body, repo: ctx.repo } : body;
  return ctx.client.post<T>(path, withRepo, { ...HUB_OPTS, ignoreBreaker: true });
}

export interface DigestSection {
  heading: string;
  lines: string[];
  /** age of digest.md by mtime */
  ageMs: number;
}

/** Lines of the `## <heading…>` section of the cached SessionStart digest (§9.3), when one exists. */
export function digestSection(ctx: CallContext, headingPrefix: string): DigestSection | null {
  if (!ctx.repoKey) return null;
  const d = readDigest(ctx.home, ctx.repoKey, ctx.now);
  if (!d) return null;
  const lines = d.digest.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).toLowerCase().startsWith(headingPrefix.toLowerCase()));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('## ') || l.startsWith('</relay-digest')) break;
    if (l.trim()) out.push(l.replace(/^- /, ''));
  }
  return { heading: lines[start]?.slice(3) ?? headingPrefix, lines: out, ageMs: d.ageMs };
}
