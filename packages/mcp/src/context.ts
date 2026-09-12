/**
 * Per-call context for every tool (§9.1): environment, team.json, the live
 * session (current/<ppid>.json), identity through the same ladder as the
 * hooks (§3.3), the repo scope (session meta → cached snapshot → git), the
 * cached snapshot and a HubClient with the 5 s MCP budget (§10.4 headers).
 * Nothing here throws; a missing piece degrades to null.
 */
import {
  BUDGET_MS,
  HubClient,
  applySnapshot,
  configForMeta,
  loadRelayConfig,
  loadTeamConfig,
  localSlug,
  normalizeOriginUrl,
  isPlaceholderHandle,
  readEnv,
  readIdentityFile,
  readMeta,
  readSnapshot,
  repoKey as repoKeyOf,
  resolveIdentity,
  resolvePluginSha,
  revParseSet,
  sessionDir,
  type CachedSnapshot,
  type DevHandle,
  type IdentitySource,
  type RelayArea,
  type RelayConfigResolved,
  type RelayEnv,
  type RepoKey,
  type RepoSlug,
  type SessionMeta,
  type TeamConfig,
} from '@relay/core';
import { resolveLiveSession, type LiveSession } from './session.js';

export interface ServerOptions {
  /** process.env by default; tests inject RELAY_HOME / RELAY_HUB / RELAY_TOKEN */
  processEnv?: NodeJS.ProcessEnv;
  /** process.ppid by default (the Claude Code pid, experiment B.16) */
  ppid?: number;
  /** process.cwd() by default */
  cwd?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CallContext {
  env: RelayEnv;
  home: string;
  cwd: string;
  ppid: number;
  team: TeamConfig | null;
  session: LiveSession;
  meta: SessionMeta | null;
  dev: DevHandle;
  identitySource: IdentitySource;
  placeholder: boolean;
  gitEmail: string | null;
  repo: RepoSlug | null;
  repoKey: RepoKey | null;
  project: string | null;
  repoRoot: string | null;
  config: RelayConfigResolved | null;
  pluginSha: string | null;
  /** null when neither team.json nor RELAY_HUB/RELAY_TOKEN is configured */
  client: HubClient | null;
  snapshot: CachedSnapshot | null;
  now: number;
}

interface GitScope {
  toplevel: string | null;
  slug: RepoSlug;
  userEmail: string | null;
}

/** The server's cwd never changes, so the <= 300 ms rev-parse phase runs once per process. */
const gitScopeCache = new Map<string, Promise<GitScope>>();

function gitScope(cwd: string): Promise<GitScope> {
  let p = gitScopeCache.get(cwd);
  if (!p) {
    p = revParseSet(cwd).then((rp) => ({
      toplevel: rp.toplevel,
      slug: normalizeOriginUrl(rp.originUrl) ?? localSlug(rp.toplevel ?? cwd),
      userEmail: rp.userEmail,
    }));
    gitScopeCache.set(cwd, p);
  }
  return p;
}

/** Test hook: forget the cached rev-parse result. */
export function resetContextCache(): void {
  gitScopeCache.clear();
}

export async function buildContext(opts: ServerOptions = {}): Promise<CallContext> {
  const processEnv = opts.processEnv ?? process.env;
  const env = readEnv(processEnv);
  const home = env.home;
  const cwd = opts.cwd ?? process.cwd();
  const ppid = opts.ppid ?? process.ppid;
  const now = opts.now ? opts.now() : Date.now();
  const team = loadTeamConfig(env);
  const session = resolveLiveSession({ home, ppid, cwd, envSessionId: env.sessionId });
  const meta = session.sessionId ? readMeta(sessionDir(home, session.sessionId)) : null;

  let repo: RepoSlug | null = null;
  let repoKey: RepoKey | null = null;
  let project: string | null = null;
  let repoRoot: string | null = null;
  let config: RelayConfigResolved | null = null;
  let gitEmail: string | null = null;

  if (meta) {
    repo = meta.repo;
    repoKey = meta.repoKey;
    project = meta.project;
    repoRoot = meta.repoRoot;
    gitEmail = meta.gitEmail;
    config = configForMeta(meta).resolved;
  } else {
    // no session meta (hooks not live yet, or a session id from the env only):
    // the cached snapshot names the repo when a hook ever ran here, else git does
    const cached = session.current ? readSnapshot(home, session.current.repoKey) : null;
    const scope = await gitScope(cwd);
    gitEmail = scope.userEmail;
    repoRoot = scope.toplevel;
    if (cached) {
      repo = cached.repo.slug;
      repoKey = session.current?.repoKey ?? repoKeyOf(repo);
      project = cached.repo.project;
      config = cached.repo.config;
    } else {
      const loaded = loadRelayConfig(scope.toplevel ?? cwd, { slug: scope.slug, project: env.project });
      repo = loaded.resolved.repo;
      repoKey = repoKeyOf(repo);
      project = loaded.resolved.project;
      config = loaded.resolved;
    }
  }

  // identity (§3.3): with session meta the hooks' handle wins so hub rows stay
  // attributed to one dev (only the explicit overrides RELAY_DEV and an `iam`
  // identity.json rank above it); without meta the full ladder runs, exactly
  // as ensureSessionMeta would. Evaluated per call so `iam` applies at once.
  let dev: DevHandle;
  let identitySource: IdentitySource;
  const identityFile = readIdentityFile(home);
  if (env.dev) {
    dev = env.dev;
    identitySource = 'env';
  } else if (meta && identityFile?.source === 'identity-file' && identityFile.dev) {
    dev = identityFile.dev;
    identitySource = 'identity-file';
  } else if (meta) {
    dev = meta.dev;
    identitySource = meta.identitySource;
  } else {
    const identity = resolveIdentity(home, { envDev: env.dev, team, gitEmail, user: env.user, hostname: env.hostname, now });
    dev = identity.dev;
    identitySource = identity.source;
  }
  const placeholder = isPlaceholderHandle(dev);
  const pluginSha = resolvePluginSha(env);
  const snapshot = repoKey ? readSnapshot(home, repoKey) : null;
  const sessionId = session.sessionId;
  const keyForSnapshot = repoKey;

  const client = team
    ? new HubClient({
        hub: team.hub,
        token: team.token,
        dev,
        client: 'mcp',
        sessionId,
        pluginSha,
        home,
        role: 'sync',
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        onSnapshot: (s) => {
          applySnapshot(home, keyForSnapshot ?? repoKeyOf(s.repo.slug), s, { sessionId, myDev: dev });
        },
      })
    : null;

  return {
    env,
    home,
    cwd,
    ppid,
    team,
    session,
    meta,
    dev,
    identitySource,
    placeholder,
    gitEmail,
    repo,
    repoKey,
    project,
    repoRoot,
    config,
    pluginSha,
    client,
    snapshot,
    now,
  };
}

/** Area map for local filtering: the checkout's .relay.json when it has areas, else the hub's resolved config from the cached snapshot. */
export function areasOf(ctx: CallContext): Record<string, RelayArea> {
  const local = ctx.config?.areas ?? {};
  if (Object.keys(local).length > 0) return local;
  return ctx.snapshot?.repo.config.areas ?? {};
}

/** Request options shared by every hub call: the 5 s MCP budget (§9.1). */
export const HUB_OPTS = { budgetMs: BUDGET_MS.mcpFetch } as const;
