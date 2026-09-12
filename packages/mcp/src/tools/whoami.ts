/**
 * `whoami {iam?}` (§9.2): identity and its source, team, hub, repo, project,
 * the live session id and how it was resolved (§9.1), cache age, breaker
 * state, plugin commit vs the marketplace, hook firing counts. Answered
 * locally. `iam=<handle>` writes ~/.relay/identity.json, asks the hub to
 * merge the per-machine placeholder (§3.3 step 7) and updates the live
 * session's meta so the hooks switch immediately.
 */
import { join } from 'node:path';
import {
  HubClient,
  LOCAL_PATHS,
  hookCounts,
  humanAge,
  isPlaceholderHandle,
  isRecord,
  nowIso,
  readBreaker,
  readIdentityFile,
  readJson,
  readMeta,
  sessionDir,
  shortTime,
  snapshotAgeMs,
  withSessionLock,
  writeIdentityFile,
  writeMeta,
  type IamResponse,
  type PluginRemoteFile,
  type WhoamiResult,
} from '@relay/core';
import { z } from 'zod';
import { HUB_OPTS, type CallContext } from '../context.js';
import { kv, toolResult } from '../format.js';
import { READ, defineTool } from './define.js';

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function readPluginRemote(home: string): PluginRemoteFile | null {
  const v = readJson(join(home, LOCAL_PATHS.pluginRemote));
  return isRecord(v) && typeof v['sha'] === 'string' && typeof v['checkedAt'] === 'string' ? (v as unknown as PluginRemoteFile) : null;
}

export function whoamiResult(ctx: CallContext): WhoamiResult {
  const breaker = readBreaker(ctx.home, ctx.now);
  const remote = readPluginRemote(ctx.home);
  const sha = ctx.pluginSha;
  return {
    dev: ctx.dev,
    identitySource: ctx.identitySource,
    team: ctx.team?.team ?? null,
    hub: ctx.team?.hub ?? null,
    repo: ctx.repo,
    project: ctx.project,
    sessionId: ctx.session.sessionId,
    sessionSource: ctx.session.source,
    cacheAgeMs: snapshotAgeMs(ctx.snapshot, ctx.now),
    breaker: { open: breaker.open, until: breaker.until, configError: breaker.configError },
    plugin: { sha, remoteSha: remote?.sha ?? null, behind: sha && remote ? remote.sha !== sha : null },
    hookCounts: hookCounts(ctx.home, { sessionId: ctx.session.sessionId, now: ctx.now }),
  };
}

function renderWhoami(r: WhoamiResult, ctx: CallContext, extra: string[]): string {
  const counts = Object.entries(r.hookCounts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const lines = [
    `Relay whoami at ${shortTime(ctx.now)}: ${kv([
      ['dev', `${r.dev} (${r.identitySource}${isPlaceholderHandle(r.dev) && r.identitySource !== 'placeholder' ? ', placeholder' : ''})`],
      ['team', r.team ?? 'not configured'],
      ['hub', r.hub ?? 'not configured'],
      ['repo', r.repo ?? 'unknown'],
      ['project', r.project ?? 'unknown'],
      ['session', r.sessionId ? `${r.sessionId.slice(0, 8)} via ${r.sessionSource}` : `none (${r.sessionSource})`],
      ['cwd', ctx.cwd],
    ])}`,
    `- cache: ${r.cacheAgeMs === null ? 'no snapshot' : `snapshot ${humanAge(r.cacheAgeMs)} old (as of ${ctx.snapshot ? shortTime(ctx.snapshot.serverTime) : '?'})`} · breaker: ${r.breaker.open ? `open until ${r.breaker.until ? shortTime(r.breaker.until) : '?'}` : 'closed'}${r.breaker.configError ? ` · config error ${r.breaker.configError.status} at ${shortTime(r.breaker.configError.at)}: ${r.breaker.configError.message}` : ''}`,
    `- plugin: ${r.plugin.sha ?? 'unknown commit'}${r.plugin.remoteSha ? ` · marketplace ${r.plugin.remoteSha.slice(0, 7)} (${r.plugin.behind ? 'behind' : 'current'})` : ' · marketplace not checked yet'}`,
    `- hooks in the last 24 h${r.sessionId ? ' (this session)' : ''}: ${counts || 'none recorded'}`,
  ];
  if (ctx.gitEmail) lines.push(`- git email: ${ctx.gitEmail}`);
  lines.push(...extra);
  return lines.join('\n');
}

export const whoamiTool = defineTool({
  name: 'whoami',
  description:
    'Relay diagnostics, answered locally: your handle and how it was resolved (RELAY_DEV, identity file, git email vs team.json, placeholder), team, hub URL, repo slug, project, the live session id and how it was found (current/<pid>.json, cwd match, env), snapshot cache age, breaker state and configuration errors, plugin commit vs the marketplace, hook firing counts. iam="<handle>" sets your identity for this machine and asks the hub to merge the placeholder identity into it.',
  schema: { iam: z.string().max(64).optional().describe('your team.json handle, to fix an unknown/placeholder identity') },
  annotations: { ...READ, readOnlyHint: false },
  handler: async (ctx: CallContext, args) => {
    const extra: string[] = [];
    let iam: { dev: string; previous: string; merged: IamResponse | null; note: string } | null = null;
    if (args.iam) {
      const handle = args.iam.trim();
      if (!HANDLE_RE.test(handle)) {
        return toolResult(`Relay iam rejected: "${handle}" is not a valid handle (letters, digits, . _ -).`, { error: 'bad_handle' }, { isError: true });
      }
      const previous = ctx.dev;
      const members = ctx.team ? Object.keys(ctx.team.members) : [];
      const known = members.some((m) => m.toLowerCase() === handle.toLowerCase());
      const dev = members.find((m) => m.toLowerCase() === handle.toLowerCase()) ?? handle;
      const prior = readIdentityFile(ctx.home);
      writeIdentityFile(ctx.home, { dev, source: 'identity-file', at: nowIso(ctx.now), gitEmail: ctx.gitEmail ?? prior?.gitEmail ?? null });
      let merged: IamResponse | null = null;
      let note = `identity.json now says ${dev}${known ? '' : ' (not a member of team.json; presence will show this handle as declared)'}`;
      if (ctx.env.dev && ctx.env.dev !== dev) note += `; RELAY_DEV=${ctx.env.dev} still overrides it in this environment`;
      if (isPlaceholderHandle(previous) && previous !== dev && ctx.team) {
        const client = new HubClient({ hub: ctx.team.hub, token: ctx.team.token, dev, client: 'mcp', sessionId: ctx.session.sessionId, pluginSha: ctx.pluginSha, home: ctx.home, role: 'sync' });
        const r = await client.post<IamResponse>('/v1/iam', { placeholder: previous, ...(ctx.session.sessionId ? { sessionId: ctx.session.sessionId } : {}) }, { ...HUB_OPTS, ignoreBreaker: true });
        if (r.ok) {
          merged = r.data;
          note += `; hub merged ${previous} into ${dev} (${r.data.sessions} session${r.data.sessions === 1 ? '' : 's'} moved)`;
        } else note += `; hub merge of ${previous} not done (${r.kind}: ${r.message}); the next session start retries it`;
      }
      // the live session's meta.json carries the dev the hooks send; patch it so the switch is immediate
      if (ctx.session.sessionId && readMeta(sessionDir(ctx.home, ctx.session.sessionId))) {
        const dir = sessionDir(ctx.home, ctx.session.sessionId);
        const patched = await withSessionLock(dir, () => {
          const meta = readMeta(dir);
          if (!meta || meta.dev === dev) return false;
          return writeMeta(dir, { ...meta, dev, identitySource: 'identity-file' });
        }).catch(() => false);
        if (patched) note += `; live session ${ctx.session.sessionId.slice(0, 8)} switched to ${dev}`;
      }
      iam = { dev, previous, merged, note };
      extra.push(`- iam: ${note}`);
      ctx = { ...ctx, dev, identitySource: 'identity-file', placeholder: false };
    }
    const r = whoamiResult(ctx);
    if (isPlaceholderHandle(r.dev)) extra.push(`- identity is a per-machine placeholder${ctx.gitEmail ? ` (git email ${ctx.gitEmail} is not in team.json)` : ' (no git email configured)'}; whoami iam=<handle> or /relay:iam <handle> fixes it`);
    return toolResult(renderWhoami(r, ctx, extra), { ...r, ...(iam ? { iam } : {}) });
  },
});
