/**
 * Minimal glob matching for area and contract globs (§5.4, §7.1): `**`, `*`, `?`
 * and `{a,b}` alternation over repo-relative POSIX paths. A glob without a slash
 * matches the basename anywhere (like gitignore), so `*.prisma` finds
 * `prisma/schema.prisma`.
 */

const cache = new Map<string, RegExp>();

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let g = glob.trim().replace(/^\.\//, '').replace(/^\//, '');
  const anywhere = !g.includes('/');
  // `dir/**` should also match `dir` itself and everything below it
  let out = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` -> zero or more directories; trailing `**` -> anything
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
        i += 1;
      } else {
        const alts = g
          .slice(i + 1, end)
          .split(',')
          .map((a) => escapeRegex(a.trim()));
        out += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      out += escapeRegex(c);
      i += 1;
    }
  }
  g = anywhere ? `(?:^|.*/)${out}$` : `^${out}$`;
  const re = new RegExp(g);
  cache.set(glob, re);
  return re;
}

export function matchesGlob(path: string, glob: string): boolean {
  const p = path.replace(/^\.\//, '').replace(/^\//, '');
  if (globToRegExp(glob).test(p)) return true;
  // `apps/app/**` written as a directory prefix should match the directory itself
  if (glob.endsWith('/**') && p === glob.slice(0, -3)) return true;
  return false;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

/** True when `target` (path, dir prefix or glob) covers `path` (§6.3 claims). */
export function targetCovers(target: string, path: string): boolean {
  const t = target.replace(/^\.\//, '').replace(/\/$/, '');
  if (t === path) return true;
  if (path.startsWith(t + '/')) return true;
  if (/[*?{]/.test(t)) return matchesGlob(path, t);
  return false;
}
