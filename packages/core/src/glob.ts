/**
 * Minimal glob matcher for area maps, contract globs, claim targets and mutes
 * (§5.4, §7.1, §6.3). Supports `**`, `*`, `?`, `{a,b}` and `[...]`; paths are
 * repo-relative POSIX strings. A pattern with no `/` matches the basename
 * anywhere (minimatch's `matchBase`), which is what `.relay.json` authors expect
 * from `*.prisma`.
 */

const cache = new Map<string, RegExp>();

/** Convert one glob to an anchored RegExp (cached). */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let src = '';
  let i = 0;
  const matchBase = !glob.includes('/');
  const g = glob.replace(/^\.\//, '');
  while (i < g.length) {
    const c = g[i] ?? '';
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` -> zero or more directories; trailing `**` -> anything
        if (g[i + 2] === '/') {
          src += '(?:.*/)?';
          i += 3;
        } else {
          src += '.*';
          i += 2;
        }
      } else {
        src += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      src += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) {
        src += '\\{';
        i += 1;
      } else {
        const alts = g
          .slice(i + 1, end)
          .split(',')
          .map((a) => globToRegExp(a).source.replace(/^\^(?:\(\?:\.\*\/\)\?)?/, '').replace(/\$$/, ''));
        src += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end < 0) {
        src += '\\[';
        i += 1;
      } else {
        src += g.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      src += c.replace(/[.+^$()|\\]/g, '\\$&');
      i += 1;
    }
  }
  const re = new RegExp(`^${matchBase ? '(?:.*/)?' : ''}${src}$`);
  cache.set(glob, re);
  return re;
}

/** Does `path` match `glob`? A directory-style glob (`apps/app`) also matches everything beneath it. */
export function matchGlob(glob: string, path: string): boolean {
  const p = path.replace(/^\.\//, '');
  if (globToRegExp(glob).test(p)) return true;
  // `apps/app` (no wildcard) is a prefix target: matches `apps/app/**`
  if (!/[*?{[]/.test(glob)) {
    const prefix = glob.replace(/\/+$/, '');
    return p === prefix || p.startsWith(prefix + '/');
  }
  return false;
}

/** First matching glob of a list, or null. */
export function matchAny(globs: readonly string[], path: string): string | null {
  for (const g of globs) if (matchGlob(g, path)) return g;
  return null;
}

/** Is the string a glob (has wildcards) rather than a literal path? */
export function isGlobPattern(s: string): boolean {
  return /[*?{[]/.test(s);
}
