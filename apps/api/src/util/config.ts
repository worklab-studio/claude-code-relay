/**
 * `.relay.json` resolution on the hub side (§5.4): defaults, `"+glob"` prepend
 * semantics, area lookup for a path, and the project derived from a repo slug.
 * Mirrors core's config.ts so the hub renders digests and routes impacts with the
 * same map the client uses; kept local so apps/api depends only on protocol types.
 */
import {
  DEFAULT_CONTRACT_GLOBS,
  RELAY_CONFIG_DEFAULTS,
  type RelayArea,
  type RelayConfig,
  type RelayConfigResolved,
  type RepoSlug,
} from '@relay/core';
import { matchesAny, matchesGlob } from './glob.js';

/** `github.com/acme/app` -> `acme/app`; `local/foo` -> `foo` (§5.3 project default). */
export function defaultProject(slug: RepoSlug): string {
  const parts = slug.split('/').filter(Boolean);
  if (parts.length >= 3) return parts.slice(1).join('/');
  if (parts.length === 2) return parts[1]!;
  return slug;
}

export function resolveConfig(slug: RepoSlug, raw: RelayConfig | null | undefined, project?: string | null): RelayConfigResolved {
  const cfg = raw ?? {};
  const globsIn = cfg.contracts?.globs;
  let globs: string[];
  if (!globsIn || globsIn.length === 0) {
    globs = [...DEFAULT_CONTRACT_GLOBS];
  } else if (globsIn.every((g) => g.startsWith('+'))) {
    globs = [...globsIn.map((g) => g.slice(1)), ...DEFAULT_CONTRACT_GLOBS];
  } else {
    globs = globsIn.map((g) => (g.startsWith('+') ? g.slice(1) : g));
  }
  return {
    project: project ?? cfg.project ?? defaultProject(cfg.repo ?? slug),
    repo: cfg.repo ?? slug,
    areas: cfg.areas ?? {},
    contracts: {
      globs,
      packages: cfg.contracts?.packages ?? RELAY_CONFIG_DEFAULTS.contracts.packages,
      export_scan: cfg.contracts?.export_scan ?? RELAY_CONFIG_DEFAULTS.contracts.export_scan,
      consumers: cfg.contracts?.consumers ?? RELAY_CONFIG_DEFAULTS.contracts.consumers,
    },
    depends: cfg.depends ?? {},
    impacts: { debounce_minutes: cfg.impacts?.debounce_minutes ?? RELAY_CONFIG_DEFAULTS.impacts.debounce_minutes },
    collision: { ...RELAY_CONFIG_DEFAULTS.collision, ...(cfg.collision ?? {}) },
    privacy: { ...RELAY_CONFIG_DEFAULTS.privacy, ...(cfg.privacy ?? {}) },
    handoff: { ...RELAY_CONFIG_DEFAULTS.handoff, ...(cfg.handoff ?? {}) },
  };
}

/** Area of a repo-relative path: first declared area whose globs match, else the first two path segments (§5.4 absent-file rule). */
export function areaOf(path: string, areas: Record<string, RelayArea>): string | null {
  for (const [name, area] of Object.entries(areas)) {
    if (matchesAny(path, area.paths)) return name;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0]!;
  return null;
}

/** Areas whose globs include the target (an area name, a path or a glob). */
export function areasForTarget(target: string, areas: Record<string, RelayArea>): string[] {
  if (areas[target]) return [target];
  const out: string[] = [];
  for (const [name, area] of Object.entries(areas)) {
    if (area.paths.some((g) => matchesGlob(target, g) || g === target || target.startsWith(g.replace(/\/\*\*$/, '') + '/'))) {
      out.push(name);
    }
  }
  return out;
}

export function isContractPath(path: string, cfg: RelayConfigResolved): boolean {
  if (matchesAny(path, cfg.contracts.globs)) return true;
  for (const area of Object.values(cfg.areas)) {
    if (area.shared && matchesAny(path, area.paths)) return true;
  }
  return false;
}

export function areaOwners(area: string | null, cfg: RelayConfigResolved): string[] {
  if (!area) return [];
  return cfg.areas[area]?.owners ?? [];
}
