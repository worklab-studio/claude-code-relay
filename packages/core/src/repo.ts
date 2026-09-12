/**
 * Repo identity and path normalization (§4.1 step 1, §5.3, §4.3 step 1).
 * Pure functions plus a best-effort realpath; git access lives in git.ts.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { ClientKind, RepoKey, RepoSlug } from './protocol.js';
import { sha1 } from './util.js';

/**
 * Normalize an origin URL to a slug: `git@github.com:acme/app.git` and
 * `https://github.com/acme/app` -> `github.com/acme/app`; file/local paths ->
 * `local/<basename>`; empty -> null. Lower-cased because GitHub/GitLab/Bitbucket
 * are case-insensitive and two devs must land on one board (§5.3).
 */
export function normalizeOriginUrl(url: string | null | undefined): RepoSlug | null {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;
  // file:///path/to/repo.git or a bare filesystem path -> local slug
  if (/^file:\/\//i.test(u)) return localSlug(u.replace(/^file:\/\//i, ''));
  if (u.startsWith('/') || u.startsWith('.') || /^[A-Za-z]:[\\/]/.test(u)) return localSlug(u);
  // scp-like: [user@]host:path
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
  let host: string;
  let path: string;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    // scheme://[user[:pass]@]host[:port]/path
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
    if (!m) return null;
    host = m[1] ?? '';
    path = m[2] ?? '';
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  if (!host || !path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

/** `local/<basename>` for repos without an origin (§5.3). */
export function localSlug(rootOrUrl: string): RepoSlug {
  const cleaned = rootOrUrl.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const base = basename(cleaned) || 'repo';
  return `local/${base.toLowerCase()}`;
}

/** `sha1(slug).slice(0, 12)` — cache directory key (§4.0 rule 8). */
export function repoKey(slug: RepoSlug): RepoKey {
  return sha1(slug).slice(0, 12);
}

/** Default project when `.relay.json.project` is absent: origin owner/name (§5.3). */
export function defaultProject(slug: RepoSlug): string {
  const parts = slug.split('/').filter(Boolean);
  if (parts.length >= 2 && (parts[0] ?? '').includes('.')) return parts.slice(1).join('/');
  return slug;
}

/** Best-effort realpath: resolves the deepest existing ancestor (Write targets may not exist yet). */
export function realpathBestEffort(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
  return resolve(path);
}

/** POSIX form of a relative path. */
export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join(posix.sep);
}

/** Is `child` equal to or under `parent` (both absolute)? */
export function isPathUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Repo-relative POSIX path for a tool `file_path` (§4.3 step 1). Relative
 * inputs resolve against `cwd`; symlinked roots (`/tmp` vs `/private/tmp` on
 * macOS) are reconciled through realpath. Null when outside the repo.
 */
export function toRepoRelative(filePath: string, repoRoot: string, cwd?: string): string | null {
  if (!filePath) return null;
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd ?? repoRoot, filePath);
  const candidates = [
    [abs, resolve(repoRoot)],
    [realpathBestEffort(abs), realpathBestEffort(repoRoot)],
  ] as const;
  for (const [file, root] of candidates) {
    const rel = relative(root, file);
    if (rel === '') return null; // the root itself is not a file
    if (!rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  }
  return null;
}

/** Worktree name when the git dir differs from the common dir (§5.3). `rev-parse` prints paths relative to its cwd (`baseDir`), or absolute. */
export function worktreeName(toplevel: string, gitDir: string | null, commonDir: string | null, baseDir: string = toplevel): string | null {
  if (!gitDir || !commonDir) return null;
  const a = realpathBestEffort(resolve(baseDir, gitDir));
  const b = realpathBestEffort(resolve(baseDir, commonDir));
  if (a === b) return null;
  return basename(toplevel) || null;
}

/** `desktop` when launched by the Claude Desktop app, else `cli` (§5.3). */
export function clientKind(env: NodeJS.ProcessEnv = process.env): ClientKind {
  return env['CLAUDE_CODE_ENTRYPOINT'] === 'claude-desktop' ? 'desktop' : 'cli';
}

/** Inferred area name when `.relay.json` has no areas: first two path segments (§5.4). */
export function inferAreaFromPath(path: string): string {
  const parts = path.replace(/^\.\//, '').split('/').filter(Boolean);
  if (parts.length <= 1) return 'root';
  if (parts.length === 2) return parts[0] ?? 'root';
  return `${parts[0]}/${parts[1]}`;
}
