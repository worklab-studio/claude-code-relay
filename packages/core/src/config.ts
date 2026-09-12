/**
 * `.relay.json` loading with defaults, team.json + environment overrides
 * (§4.0 env list, §5.4, §7.1, §3.4 plugin sha).
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONTRACT_GLOBS,
  RELAY_CONFIG_DEFAULTS,
  isRecord,
  isRelayConfig,
  isTeamConfig,
  type RelayArea,
  type RelayConfig,
  type RelayConfigResolved,
  type RepoSlug,
  type TeamConfig,
} from './protocol.js';
import { defaultProject } from './repo.js';
import { canonicalJson, readJson, readText, sha1 } from './util.js';

/** Typed view of the environment variables Relay reads (§4.0). */
export interface RelayEnv {
  home: string;
  dev: string | null;
  hub: string | null;
  token: string | null;
  node: string | null;
  debug: boolean;
  disable: boolean;
  /** RELAY_INTERACTIVE=0 downgrades ask -> context (§4.0 rule 14) */
  interactive: boolean;
  snapshotTtlMs: number | null;
  bg: boolean;
  project: string | null;
  pluginRoot: string | null;
  envFile: string | null;
  entrypoint: string | null;
  pid: number | null;
  sessionId: string | null;
  user: string | null;
  hostname: string;
}

/** `$RELAY_HOME` or `~/.relay` (§10.3). */
export function relayHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env['RELAY_HOME'];
  return h && h.trim() ? h : join(homedir(), '.relay');
}

/** Read every RELAY_* / CLAUDE_* variable once, defensively. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): RelayEnv {
  const str = (k: string): string | null => {
    const v = env[k];
    return v && v.trim() ? v.trim() : null;
  };
  const ttl = str('RELAY_SNAPSHOT_TTL_MS');
  const pid = str('CLAUDE_PID');
  return {
    home: relayHome(env),
    dev: str('RELAY_DEV'),
    hub: str('RELAY_HUB'),
    token: str('RELAY_TOKEN'),
    node: str('RELAY_NODE'),
    debug: str('RELAY_DEBUG') === '1',
    disable: str('RELAY_DISABLE') === '1',
    interactive: str('RELAY_INTERACTIVE') !== '0',
    snapshotTtlMs: ttl && /^\d+$/.test(ttl) ? Number(ttl) : null,
    bg: str('RELAY_BG') === '1',
    project: str('RELAY_PROJECT'),
    pluginRoot: str('CLAUDE_PLUGIN_ROOT'),
    envFile: str('CLAUDE_ENV_FILE'),
    entrypoint: str('CLAUDE_CODE_ENTRYPOINT'),
    pid: pid && /^\d+$/.test(pid) ? Number(pid) : null,
    sessionId: str('CLAUDE_CODE_SESSION_ID'),
    user: str('USER') ?? str('LOGNAME'),
    hostname: safeHostname(),
  };
}

function safeHostname(): string {
  try {
    return hostname() || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

/** Effective contract globs: `"+glob"` entries prepend to the defaults, plain entries replace them (§5.4, §7.1). */
export function resolveContractGlobs(configured: string[] | undefined): string[] {
  if (!configured || configured.length === 0) return [...DEFAULT_CONTRACT_GLOBS];
  const plus = configured.filter((g) => g.startsWith('+')).map((g) => g.slice(1).trim()).filter(Boolean);
  const plain = configured.filter((g) => !g.startsWith('+')).map((g) => g.trim()).filter(Boolean);
  const base = plain.length > 0 ? plain : [...DEFAULT_CONTRACT_GLOBS];
  return [...plus, ...base];
}

/** sha1 of the canonical JSON of the raw file (uploaded once per hash, §4.1). */
export function configHash(raw: RelayConfig | null): string | null {
  return raw ? sha1(canonicalJson(raw)) : null;
}

/** Apply defaults to a raw (possibly null) `.relay.json` (§5.4). */
export function resolveRelayConfig(
  raw: RelayConfig | null,
  ctx: { slug: RepoSlug; project?: string | null },
): RelayConfigResolved {
  const cfg = raw ?? {};
  const areas: Record<string, RelayArea> = {};
  for (const [name, area] of Object.entries(cfg.areas ?? {})) {
    if (!isRecord(area) || !Array.isArray(area.paths)) continue;
    areas[name] = {
      paths: area.paths.filter((x): x is string => typeof x === 'string'),
      ...(Array.isArray(area.owners) ? { owners: area.owners.filter((x): x is string => typeof x === 'string') } : {}),
      ...(area.shared ? { shared: true } : {}),
    };
  }
  const d = RELAY_CONFIG_DEFAULTS;
  const c = cfg.contracts ?? {};
  return {
    project: cfg.project?.trim() || ctx.project || defaultProject(cfg.repo ?? ctx.slug),
    repo: cfg.repo?.trim() || ctx.slug,
    areas,
    contracts: {
      globs: resolveContractGlobs(c.globs),
      packages: (c.packages ?? d.contracts.packages).filter((x) => typeof x === 'string'),
      export_scan: c.export_scan ?? d.contracts.export_scan,
      consumers: isRecord(c.consumers) ? (c.consumers as Record<string, string[]>) : { ...d.contracts.consumers },
    },
    depends: isRecord(cfg.depends) ? (cfg.depends as Record<string, string[]>) : {},
    impacts: { debounce_minutes: numberOr(cfg.impacts?.debounce_minutes, d.impacts.debounce_minutes) },
    collision: {
      hot: cfg.collision?.hot ?? d.collision.hot,
      claimed: cfg.collision?.claimed ?? d.collision.claimed,
      warm: cfg.collision?.warm ?? d.collision.warm,
      same_dev: cfg.collision?.same_dev ?? d.collision.same_dev,
    },
    privacy: {
      send_prompts: cfg.privacy?.send_prompts ?? d.privacy.send_prompts,
      send_turns: cfg.privacy?.send_turns ?? d.privacy.send_turns,
      send_diffs: cfg.privacy?.send_diffs ?? d.privacy.send_diffs,
      objective_from_prompts: cfg.privacy?.objective_from_prompts ?? d.privacy.objective_from_prompts,
    },
    handoff: {
      llm: cfg.handoff?.llm ?? d.handoff.llm,
      idle_minutes: numberOr(cfg.handoff?.idle_minutes, d.handoff.idle_minutes),
    },
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Result of loading `.relay.json` from a repo root. */
export interface LoadedRelayConfig {
  raw: RelayConfig | null;
  resolved: RelayConfigResolved;
  hash: string | null;
  path: string;
  /** file present but malformed (treated as absent) */
  invalid: boolean;
}

/** Load `<repoRoot>/.relay.json`; absent or malformed -> defaults (§5.4). */
export function loadRelayConfig(repoRoot: string, ctx: { slug: RepoSlug; project?: string | null }): LoadedRelayConfig {
  const path = join(repoRoot, '.relay.json');
  const text = readText(path);
  let raw: RelayConfig | null = null;
  let invalid = false;
  if (text !== null) {
    try {
      const parsed = JSON.parse(stripJsonComments(text)) as unknown;
      if (isRelayConfig(parsed)) raw = parsed;
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  return { raw, resolved: resolveRelayConfig(raw, ctx), hash: configHash(raw), path, invalid };
}

/** `.relay.json` is documented as JSONC (§5.4 example has comments); strips line and block comments outside strings, plus trailing commas. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i] ?? '';
    const n = text[i + 1] ?? '';
    if (inString) {
      out += c;
      if (c === '\\') {
        out += n;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Effective team config: `team.json` from the plugin root with RELAY_HUB / RELAY_TOKEN overrides (§4.0). */
export function loadTeamConfig(env: RelayEnv): TeamConfig | null {
  let team: TeamConfig | null = null;
  if (env.pluginRoot) {
    const parsed = readJson(join(env.pluginRoot, 'team.json'));
    if (isTeamConfig(parsed)) team = parsed;
  }
  if (!team && env.hub && env.token) {
    team = { hub: env.hub, team: 'env', token: env.token, members: {} };
  }
  if (!team) return null;
  return {
    ...team,
    hub: (env.hub ?? team.hub).replace(/\/+$/, ''),
    token: env.token ?? team.token,
  };
}

/**
 * Plugin commit for X-Relay-Plugin (§3.4; experiment B.13): the cache dir is
 * named by plugin.json version, so read installed_plugins.json for the git
 * commit, then plugin.json version, then the directory basename.
 */
export function resolvePluginSha(env: RelayEnv, claudeHome: string = join(homedir(), '.claude')): string | null {
  const installed = readJson(join(claudeHome, 'plugins', 'installed_plugins.json'));
  if (isRecord(installed) && isRecord(installed['plugins'])) {
    const entry = (installed['plugins'] as Record<string, unknown>)['relay@relay'];
    const list = Array.isArray(entry) ? entry : isRecord(entry) ? [entry] : [];
    for (const item of list) {
      if (isRecord(item) && typeof item['gitCommitSha'] === 'string' && item['gitCommitSha']) {
        return item['gitCommitSha'];
      }
    }
  }
  if (env.pluginRoot) {
    const manifest = readJson(join(env.pluginRoot, '.claude-plugin', 'plugin.json'));
    if (isRecord(manifest) && typeof manifest['version'] === 'string' && manifest['version']) {
      return manifest['version'];
    }
    const base = env.pluginRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return base || null;
  }
  return null;
}
