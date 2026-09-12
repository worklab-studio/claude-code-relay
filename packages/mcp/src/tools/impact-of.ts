/**
 * `impact_of {path?, sha?}` (§9.2): dry run before changing a contract —
 * exported symbols, dependents per repo (hub: recorded impacts + dependency
 * indexes; here: a live `git grep` in this checkout, §7.3), owners, who is
 * active there, heat, open change sets. The local grep and export scan run
 * even when the hub is down, so the answer degrades to "this repo only".
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  areaOfPath,
  areasOfPath,
  extractSymbols,
  fileLang,
  findDependents,
  isContractPath,
  nearestPackageName,
  parseUnifiedDiff,
  readBreaker,
  shortTime,
  type Dependent,
  type ImpactOfResponse,
  type PresenceRecord,
} from '@relay/core';
import { z } from 'zod';
import { areasOf, type CallContext } from '../context.js';
import { cacheFreshness, cachedLabel, hubFailureLine, plural, toolResult } from '../format.js';
import { hubGet } from '../hub.js';
import { dependentText, heatLine, sessionLine } from '../render.js';
import { READ, defineTool } from './define.js';

const SCAN_MAX_BYTES = 256 * 1024;

/** Exported symbols of the file as it is on disk: the whole file as one all-`+` hunk through core's extractor (§7.1). */
export function scanLocalExports(repoRoot: string, path: string): { symbols: string[]; kinds: ImpactOfResponse['kinds'] } | null {
  try {
    const abs = join(repoRoot, path);
    if (statSync(abs).size > SCAN_MAX_BYTES) return null;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const diff = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
    const out = extractSymbols(path, parseUnifiedDiff(diff));
    return { symbols: out.symbols, kinds: out.kinds };
  } catch {
    return null;
  }
}

function localKind(path: string): 'ts' | 'prisma' | 'openapi' | 'graphql' | 'other' {
  const lang = fileLang(path);
  if (lang === 'prisma' || lang === 'openapi' || lang === 'graphql') return lang;
  if (lang === 'ts' || lang === 'js') return 'ts';
  return 'other';
}

function render(r: ImpactOfResponse, ctx: CallContext, label: string, extra: string[]): string {
  const subject = r.path ?? (r.sha ? `commit ${r.sha.slice(0, 7)}` : 'unknown');
  const lines = [`Relay impact_of ${subject} at ${shortTime(r.at)} ${label}: ${r.symbols.length ? `exports ${r.symbols.slice(0, 20).join(', ')}${r.symbols.length > 20 ? ', …' : ''} (${r.kinds.join(', ')})` : 'no exported symbols recorded'} · ${plural(r.dependents.length, 'dependent')} · owners: ${r.owners.join(', ') || 'none configured'} · ${plural(r.openChangeSets.length, 'open change set')}${r.openChangeSets.length ? ` (${r.openChangeSets.join(', ')})` : ''}`];
  for (const d of r.dependents.slice(0, 30)) lines.push(`- dependent ${dependentText(d)}`);
  if (r.dependents.length > 30) lines.push(`- (+${r.dependents.length - 30} more in json)`);
  for (const s of r.active) lines.push(`- active there: ${sessionLine(s, ctx.dev)}`);
  for (const h of r.heat.slice(0, 15)) lines.push(`- ${heatLine(h, ctx.dev)}`);
  lines.push(...extra);
  return lines.join('\n');
}

export const impactOfTool = defineTool({
  name: 'impact_of',
  description:
    'Dry run before changing a contract file: its exported symbols, the files that depend on it in every repo of the project (recorded impacts, dependency indexes, plus a live git grep in this checkout), the owners of the affected areas, who is active there right now, 24 h heat and open change sets on it. Pass path (repo-relative) or sha (a commit whose files are looked up). Works from the local checkout when the hub is unreachable (this repo only).',
  schema: {
    path: z.string().max(500).optional().describe('repo-relative path of the contract file'),
    sha: z.string().max(64).optional().describe('commit SHA; its changed files are analysed'),
  },
  annotations: READ,
  handler: async (ctx: CallContext, args) => {
    const path = args.path?.trim().replace(/^\.\//, '') || null;
    const sha = args.sha?.trim() || null;
    if (!path && !sha) return toolResult('Relay impact_of needs a path or a sha.', { error: 'bad_args', message: 'path or sha is required' }, { isError: true });

    const areas = areasOf(ctx);
    const localScan = path && ctx.repoRoot ? scanLocalExports(ctx.repoRoot, path) : null;
    const [result, localDeps] = await Promise.all([
      hubGet<ImpactOfResponse>(ctx, '/v1/query/impact_of', { path: path ?? undefined, sha: sha ?? undefined }),
      path && ctx.repoRoot
        ? findDependents(ctx.repoRoot, { path, packageName: nearestPackageName(ctx.repoRoot, path), symbols: localScan?.symbols ?? [], kind: localKind(path) })
        : Promise.resolve<string[] | null>(null),
    ]);
    const localDependents: Dependent[] = (localDeps ?? []).map((p) => ({ path: p, area: areaOfPath(p, areas), via: 'import' as const, ...(ctx.repo ? { repo: ctx.repo } : {}) }));
    const extra: string[] = [];
    if (path && ctx.repoRoot) {
      extra.push(localDeps === null ? '- live grep in this checkout unavailable (not a git checkout, or git grep exceeded its 2 s budget)' : `- live grep in this checkout: ${plural(localDeps.length, 'importer')}`);
      const cfg = ctx.config;
      if (cfg) extra.push(`- ${path} ${isContractPath(path, { globs: cfg.contracts.globs, areas: cfg.areas }) ? 'matches' : 'does not match'} the contract globs of .relay.json`);
    }

    if (result?.ok) {
      const r = result.data;
      const seen = new Set(r.dependents.map((d) => `${d.repo ?? ''}|${d.path}`));
      const merged: ImpactOfResponse = {
        ...r,
        symbols: r.symbols.length ? r.symbols : (localScan?.symbols ?? []),
        kinds: r.kinds.length ? r.kinds : (localScan?.kinds ?? []),
        dependents: [...r.dependents, ...localDependents.filter((d) => !seen.has(`${d.repo ?? ''}|${d.path}`))],
      };
      return toolResult(render(merged, ctx, '(live)', extra), merged);
    }

    // offline: symbols from the local export scan, dependents from the live grep, presence/heat/change sets from the snapshot
    const snap = ctx.snapshot;
    const breaker = readBreaker(ctx.home, ctx.now);
    const area = path ? areaOfPath(path, areas) : null;
    const pathAreas = path ? areasOfPath(path, areas) : [];
    const heat = (snap?.heat ?? []).filter((h) => (path ? h.path === path : sha ? h.headSha === sha : false) || localDependents.some((d) => d.path === h.path));
    const heatSessions = new Set(heat.map((h) => h.sessionId));
    const active: PresenceRecord[] = (snap?.sessions ?? [])
      .filter((s) => s.state !== 'gone' && (heatSessions.has(s.id) || (s.area !== null && pathAreas.includes(s.area))))
      .map((s) => ({
        dev: s.dev,
        sessionId: s.id,
        client: s.client,
        host: s.host,
        repo: s.repo ?? snap?.repo.slug ?? '',
        project: snap?.repo.project ?? '',
        branch: s.branch,
        worktree: s.worktree,
        area: s.area,
        objective: s.objective,
        objectiveSource: null,
        state: s.state,
        startedAt: s.lastSeenAt,
        lastSeenAt: s.lastSeenAt,
        lastEditAt: s.lastEditAt,
        inTurnSince: s.inTurnSince,
        editCount: 0,
        recentFiles: [],
      }));
    const openSets = (snap?.changeSets ?? []).filter((cs) => cs.impacts.some((i) => (path ? i.path === path : sha ? i.commitSha === sha : false)) && cs.status !== 'withdrawn' && cs.status !== 'merged');
    const knownSymbols = openSets.flatMap((cs) => cs.impacts.filter((i) => !path || i.path === path).flatMap((i) => i.symbols));
    const owners = [...new Set([...(area ? (areas[area]?.owners ?? []) : []), ...localDependents.flatMap((d) => (d.area ? (areas[d.area]?.owners ?? []) : []))])];
    const response: ImpactOfResponse & { freshness: ReturnType<typeof cacheFreshness> } = {
      at: snap?.serverTime ?? new Date(ctx.now).toISOString(),
      path,
      sha,
      symbols: localScan?.symbols.length ? localScan.symbols : [...new Set(knownSymbols)],
      kinds: localScan?.kinds ?? [],
      dependents: localDependents,
      owners,
      active,
      heat,
      openChangeSets: openSets.map((cs) => cs.id),
      freshness: cacheFreshness(snap, breaker.open, ctx.now),
    };
    extra.push(hubFailureLine(result, snap, ctx.now));
    extra.push('- dependents in the other repos of the project need the hub (dependency indexes)');
    return toolResult(render(response, ctx, snap ? cachedLabel(snap) : '(local only)', extra), response);
  },
});
