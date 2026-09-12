/**
 * Identity resolution ladder (§3.3): env, identity.json, git email vs
 * team.json, GitHub noreply, email local part, $USER, per-machine placeholder.
 * Pure `resolveIdentityFrom` + a small IO wrapper with the 24 h cache.
 */
import { join } from 'node:path';
import {
  LOCAL_PATHS,
  PLACEHOLDER_PREFIX,
  isRecord,
  type DevHandle,
  type IdentityFile,
  type IdentitySource,
  type TeamConfig,
} from './protocol.js';
import { nowIso, parseIso, readJson, sha1, writeJsonAtomic } from './util.js';

export interface IdentityInputs {
  /** RELAY_DEV */
  envDev: string | null;
  /** current ~/.relay/identity.json, if any */
  file: IdentityFile | null;
  team: TeamConfig | null;
  gitEmail: string | null;
  user: string | null;
  hostname: string;
  now?: number;
}

export interface ResolvedIdentity {
  dev: DevHandle;
  source: IdentitySource;
  /** true when the handle is a `unknown-<6hex>` placeholder */
  placeholder: boolean;
  /** author-filter emails for this dev: team.json emails plus the git email (§4.0 rule 7) */
  emails: string[];
}

const CACHE_MS = 24 * 60 * 60 * 1000;

/** `unknown-<sha1(hostname + $USER).slice(0,6)>` (§3.3 step 7). */
export function placeholderHandle(hostname: string, user: string | null): DevHandle {
  return PLACEHOLDER_PREFIX + sha1(`${hostname}${user ?? ''}`).slice(0, 6);
}

export function isPlaceholderHandle(dev: string): boolean {
  return dev.startsWith(PLACEHOLDER_PREFIX);
}

/** Find the member whose emails include `email` (case-insensitive). */
export function memberByEmail(team: TeamConfig | null, email: string | null): DevHandle | null {
  if (!team || !email) return null;
  const needle = email.trim().toLowerCase();
  for (const [handle, member] of Object.entries(team.members)) {
    if (Array.isArray(member.emails) && member.emails.some((e) => e.toLowerCase() === needle)) return handle;
  }
  return null;
}

/** Emails to use as the git author filter for a handle (§4.0 rule 7). */
export function authorEmails(team: TeamConfig | null, dev: DevHandle, gitEmail: string | null): string[] {
  const set = new Set<string>();
  const member = team?.members[dev];
  for (const e of member?.emails ?? []) if (e) set.add(e.toLowerCase());
  if (gitEmail) set.add(gitEmail.toLowerCase());
  return [...set];
}

/** The pure ladder. `file` with source `identity-file` always wins (after env); other cached sources are honoured for 24 h while the git email is unchanged. */
export function resolveIdentityFrom(input: IdentityInputs): ResolvedIdentity {
  const now = input.now ?? Date.now();
  const team = input.team;
  const finish = (dev: DevHandle, source: IdentitySource): ResolvedIdentity => ({
    dev,
    source,
    placeholder: isPlaceholderHandle(dev),
    emails: authorEmails(team, dev, input.gitEmail),
  });

  // 1. RELAY_DEV
  if (input.envDev) return finish(input.envDev, 'env');

  // 2. explicit /relay:iam or whoami iam=
  const file = input.file;
  if (file && file.source === 'identity-file' && file.dev) return finish(file.dev, 'identity-file');

  // cached evaluation still valid?
  if (file && file.dev && file.source !== 'placeholder') {
    const at = parseIso(file.at) ?? 0;
    const sameEmail = (file.gitEmail ?? null) === (input.gitEmail ?? null);
    if (sameEmail && now - at < CACHE_MS && now >= at) return finish(file.dev, file.source);
  }

  // 3. git email vs team.json
  const byEmail = memberByEmail(team, input.gitEmail);
  if (byEmail) return finish(byEmail, 'git-email');

  // 4. GitHub noreply <id>+<login>@users.noreply.github.com
  const noreply = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(input.gitEmail ?? '');
  if (noreply && team) {
    const login = (noreply[1] ?? '').toLowerCase();
    for (const [handle, member] of Object.entries(team.members)) {
      if (member.github && member.github.toLowerCase() === login) return finish(handle, 'github-noreply');
    }
  }

  // 5. local part == handle
  const local = (input.gitEmail ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (local && team && Object.keys(team.members).some((h) => h.toLowerCase() === local)) {
    return finish(matchHandle(team, local), 'email-local');
  }

  // 6. $USER == handle
  const user = (input.user ?? '').toLowerCase();
  if (user && team && Object.keys(team.members).some((h) => h.toLowerCase() === user)) {
    return finish(matchHandle(team, user), 'user');
  }

  // 7. per-machine placeholder
  return finish(placeholderHandle(input.hostname, input.user), 'placeholder');
}

function matchHandle(team: TeamConfig, lower: string): DevHandle {
  return Object.keys(team.members).find((h) => h.toLowerCase() === lower) ?? lower;
}

/** identity.json guard. */
export function isIdentityFile(x: unknown): x is IdentityFile {
  return isRecord(x) && typeof x['dev'] === 'string' && typeof x['source'] === 'string' && typeof x['at'] === 'string';
}

export function identityPath(home: string): string {
  return join(home, LOCAL_PATHS.identity);
}

export function readIdentityFile(home: string): IdentityFile | null {
  const v = readJson(identityPath(home));
  return isIdentityFile(v) ? v : null;
}

/** Write identity.json (explicit `iam` uses source `identity-file`). */
export function writeIdentityFile(home: string, file: IdentityFile): boolean {
  return writeJsonAtomic(identityPath(home), file, true);
}

/**
 * Resolve and cache. Placeholder and env results are not cached (a placeholder
 * would otherwise stick for 24 h after the developer fixes their git email).
 */
export function resolveIdentity(
  home: string,
  input: Omit<IdentityInputs, 'file'> & { file?: IdentityFile | null },
): ResolvedIdentity {
  const file = input.file === undefined ? readIdentityFile(home) : input.file;
  const result = resolveIdentityFrom({ ...input, file });
  const now = input.now ?? Date.now();
  const cacheable = result.source !== 'env' && result.source !== 'placeholder';
  const unchanged =
    file &&
    file.dev === result.dev &&
    file.source === result.source &&
    (file.gitEmail ?? null) === (input.gitEmail ?? null) &&
    now - (parseIso(file.at) ?? 0) < CACHE_MS;
  if (cacheable && !unchanged) {
    writeIdentityFile(home, { dev: result.dev, source: result.source, at: nowIso(now), gitEmail: input.gitEmail ?? null });
  }
  return result;
}
