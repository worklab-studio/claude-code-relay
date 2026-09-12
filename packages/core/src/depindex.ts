/**
 * Dependency index (§7.4) and in-repo dependents (§7.3). The parsers are pure
 * (`parseImportLine`, `buildDepIndexFromLines`); `buildDepIndex` and
 * `findDependents` run `git grep` through git.ts in async hooks / workers only.
 */
import { basename, dirname, extname, posix } from 'node:path';
import { gitGrep, gitHead, type GitRunOptions } from './git.js';
import { GENERIC_BASENAMES, LIMITS, type DepIndex, type RepoSlug } from './protocol.js';
import { escapeRegExp, nowIso, readJson } from './util.js';
import { isRecord } from './protocol.js';

/** Source pathspecs scanned for imports (§7.3, §7.4). */
export const SOURCE_PATHSPECS: readonly string[] = [
  ':!node_modules',
  ':!**/node_modules/**',
  ':!**/dist/**',
  ':!**/build/**',
  ':!**/*.min.js',
  '*.ts',
  '*.tsx',
  '*.mts',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.py',
  '*.go',
  '*.graphql',
  '*.gql',
];

/** Non-word boundary for POSIX ERE (`git grep -E` on macOS has no `\b` / `\s`). */
const NW = '[^A-Za-z0-9_]';

/** One `git grep -n -E` pass (POSIX ERE only) finds import/require lines, prisma model references and literal HTTP paths (§7.4). */
export const DEPINDEX_GREP_PATTERN =
  `^[[:space:]]*(import|export)${NW}.*${NW}from[[:space:]]*['"]|^[[:space:]]*import[[:space:]]*['"]|require\\(['"]|${NW}prisma\\.[a-zA-Z_]+|['"]/api/[A-Za-z0-9_./{}:-]*['"]`;

export interface ParsedImport {
  specifier: string;
  /** imported identifiers (`import { A, B as C }` -> A, B; `import * as X` -> X; default -> X) */
  identifiers: string[];
}

/** Parse one source line for ES/CJS/Python/Go import forms; null when it is not an import. */
export function parseImportLine(text: string, lang: 'ts' | 'py' | 'go' | 'other' = 'ts'): ParsedImport | null {
  const t = text.trim();
  if (lang === 'py') {
    const from = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(t);
    if (from) {
      const ids = (from[2] ?? '')
        .replace(/[()]/g, '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((s) => /^\w+$/.test(s));
      return { specifier: from[1] ?? '', identifiers: ids };
    }
    const imp = /^import\s+([\w.]+)/.exec(t);
    return imp ? { specifier: imp[1] ?? '', identifiers: [] } : null;
  }
  if (lang === 'go') {
    const m = /^(?:import\s+)?(?:\w+\s+)?"([^"]+)"/.exec(t);
    return m ? { specifier: m[1] ?? '', identifiers: [] } : null;
  }
  const es = /^(?:import|export)\s+(?:type\s+)?(.*?)\s*from\s*['"]([^'"]+)['"]/.exec(t);
  if (es) {
    const clause = es[1] ?? '';
    return { specifier: es[2] ?? '', identifiers: identifiersFromClause(clause) };
  }
  const side = /^import\s*['"]([^'"]+)['"]/.exec(t);
  if (side) return { specifier: side[1] ?? '', identifiers: [] };
  const req = /(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(t);
  if (req) return { specifier: req[2] ?? '', identifiers: identifiersFromClause(req[1] ?? '') };
  const bareReq = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(t);
  if (bareReq) return { specifier: bareReq[1] ?? '', identifiers: [] };
  return null;
}

function identifiersFromClause(clause: string): string[] {
  const ids: string[] = [];
  const star = /\*\s+as\s+(\w+)/.exec(clause);
  if (star) ids.push(star[1] ?? '');
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of (braces[1] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(name)) ids.push(name);
    }
  }
  const def = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, '').trim());
  if (def && def[1] && def[1] !== 'type') ids.push(def[1]);
  return [...new Set(ids.filter(Boolean))];
}

export interface NormalizedSpecifier {
  kind: 'package' | 'relative' | 'alias' | 'builtin';
  /** package name (`@acme/contracts`) or repo-relative path without extension */
  key: string;
  /** deep import (`@acme/contracts/billing`) when present */
  deepKey?: string;
}

/** Normalize a specifier: packages to name + deep form, relative imports to repo-relative paths without extension (§7.4). */
export function normalizeSpecifier(specifier: string, fromFile: string): NormalizedSpecifier {
  const spec = specifier.trim();
  if (spec.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    return { kind: 'relative', key: stripExt(resolved) };
  }
  if (spec.startsWith('/')) return { kind: 'relative', key: stripExt(spec.replace(/^\/+/, '')) };
  if (/^node:/.test(spec)) return { kind: 'builtin', key: spec };
  if (/^[@~#$]\//.test(spec) && !spec.startsWith('@')) return { kind: 'alias', key: spec };
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
  const deep = parts.length > (spec.startsWith('@') ? 2 : 1) ? stripExt(spec) : undefined;
  return deep ? { kind: 'package', key: name, deepKey: deep } : { kind: 'package', key: name };
}

function stripExt(p: string): string {
  const ext = extname(p);
  const base = ext && /^\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|d)$/.test(ext) ? p.slice(0, -ext.length) : p;
  return base.replace(/\/index$/, '').replace(/\.d$/, '');
}

export interface GrepLine {
  file: string;
  text: string;
}

/** Split `path:line:text` grep output. */
export function parseGrepLines(lines: readonly string[]): GrepLine[] {
  const out: GrepLine[] = [];
  for (const l of lines) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(l);
    if (m) out.push({ file: m[1] ?? '', text: m[3] ?? '' });
  }
  return out;
}

const MAX_KEYS = 20_000;
const MAX_FILES_PER_KEY = 200;

function add(map: Record<string, string[]>, key: string, file: string): void {
  if (!key) return;
  const list = map[key];
  if (list) {
    if (list.length < MAX_FILES_PER_KEY && !list.includes(file)) list.push(file);
  } else if (Object.keys(map).length < MAX_KEYS) {
    map[key] = [file];
  }
}

function langOfFile(file: string): 'ts' | 'py' | 'go' | 'other' {
  const ext = extname(file);
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  if (/^\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ext)) return 'ts';
  return 'other';
}

/** Build the index from grep lines (pure). */
export function buildDepIndexFromLines(
  lines: readonly GrepLine[],
  ctx: { repo: RepoSlug; head: string; builtAt?: string },
): DepIndex {
  const imports: Record<string, string[]> = {};
  const symbols: Record<string, string[]> = {};
  const contractPaths: Record<string, string[]> = {};
  for (const { file, text } of lines) {
    const lang = langOfFile(file);
    const parsed = parseImportLine(text, lang);
    if (parsed) {
      const n = normalizeSpecifier(parsed.specifier, file);
      if (n.kind !== 'builtin') {
        add(imports, n.key, file);
        if (n.deepKey) add(imports, n.deepKey, file);
        if (n.kind === 'relative') {
          add(contractPaths, n.key, file);
          const base = basename(n.key);
          if (!GENERIC_BASENAMES.includes(base)) add(contractPaths, base, file);
        }
      }
      for (const id of parsed.identifiers) add(symbols, id, file);
    }
    for (const m of text.matchAll(/\bprisma\.([a-zA-Z_]\w*)\b/g)) {
      const model = m[1] ?? '';
      if (model && !/^(\$|_)/.test(model)) add(symbols, `prisma.${model}`, file);
    }
    for (const m of text.matchAll(/['"](\/api\/[A-Za-z0-9_./{}:-]*)['"]/g)) add(imports, m[1] ?? '', file);
  }
  return { repo: ctx.repo, head: ctx.head, builtAt: ctx.builtAt ?? nowIso(), imports, symbols, contractPaths };
}

/** Run the grep pass and build the index (worker only, §7.4). Null on git failure. */
export async function buildDepIndex(
  cwd: string,
  ctx: { repo: RepoSlug; head?: string | null },
  opts?: GitRunOptions,
): Promise<DepIndex | null> {
  const head = ctx.head ?? (await gitHead(cwd, opts));
  if (!head) return null;
  const raw = await gitGrep(cwd, DEPINDEX_GREP_PATTERN, { ...opts, mode: 'lines', pathspecs: SOURCE_PATHSPECS, timeoutMs: opts?.timeoutMs ?? 10_000 });
  if (raw === null) return null;
  return buildDepIndexFromLines(parseGrepLines(raw), { repo: ctx.repo, head });
}

/** Nearest `package.json` `name` above a repo-relative file (§7.3); null when none. */
export function nearestPackageName(repoRoot: string, relPath: string): string | null {
  let dir = posix.dirname(relPath);
  for (let i = 0; i < 32; i++) {
    const pkg = readJson(posix.join(repoRoot, dir, 'package.json'));
    if (isRecord(pkg) && typeof pkg['name'] === 'string' && pkg['name']) return pkg['name'];
    if (dir === '.' || dir === '' || dir === '/') break;
    dir = posix.dirname(dir);
  }
  return null;
}

export interface DependentSpecInput {
  /** repo-relative path of the changed file */
  path: string;
  packageName?: string | null;
  symbols?: readonly string[];
  kind?: 'ts' | 'prisma' | 'openapi' | 'graphql' | 'other';
}

/** Alternation of POSIX-ERE specifiers for `git grep -l -E` (§7.3); no `\b`/`\s` (unsupported by macOS git). */
export function dependentSpecifiers(input: DependentSpecInput): string[] {
  const specs = new Set<string>();
  const noExt = stripExt(input.path);
  const base = basename(noExt);
  if (input.packageName) {
    specs.add(`['"]${escapeRegExp(input.packageName)}['"]`);
    const srcIdx = noExt.indexOf('/src/');
    const deep = srcIdx >= 0 ? noExt.slice(srcIdx + 5) : base;
    specs.add(`['"]${escapeRegExp(`${input.packageName}/${deep}`)}(\\.js)?['"]`);
  }
  if (!GENERIC_BASENAMES.includes(base)) {
    specs.add(`/${escapeRegExp(base)}(\\.js|\\.ts)?['"]`);
  }
  specs.add(`['"]${escapeRegExp(noExt)}(\\.js|\\.ts)?['"]`);
  const dir = basename(dirname(noExt));
  if (dir && dir !== '.' && !GENERIC_BASENAMES.includes(base)) specs.add(`${escapeRegExp(dir)}/${escapeRegExp(base)}(\\.js|\\.ts)?['"]`);
  if (input.kind === 'prisma') {
    for (const model of input.symbols ?? []) {
      if (!/^[A-Z]/.test(model)) continue;
      const camel = model.charAt(0).toLowerCase() + model.slice(1);
      specs.add(`prisma\\.${escapeRegExp(camel)}(${NW}|$)`);
      specs.add(`(^|${NW})${escapeRegExp(model)}(${NW}|$)`);
    }
  } else if (input.kind === 'openapi') {
    for (const p of input.symbols ?? []) if (p.startsWith('/')) specs.add(`['"]${escapeRegExp(p)}['"]`);
  } else if (input.kind === 'graphql') {
    for (const t of input.symbols ?? []) if (/^[A-Z]\w*$/.test(t)) specs.add(`(^|${NW})${escapeRegExp(t)}(${NW}|$)`);
  }
  return [...specs];
}

/**
 * In-repo dependents of a changed file: `git grep -l -E` over source files,
 * 2 s budget, cap 50; null on timeout (the hub falls back to the depindex, §7.3).
 */
export async function findDependents(
  cwd: string,
  input: DependentSpecInput,
  opts?: GitRunOptions & { cap?: number },
): Promise<string[] | null> {
  const specs = dependentSpecifiers(input);
  if (!specs.length) return [];
  const pattern = specs.join('|');
  const files = await gitGrep(cwd, pattern, {
    ...opts,
    mode: 'files',
    pathspecs: [`:!${input.path}`, ...SOURCE_PATHSPECS],
    cap: (opts?.cap ?? LIMITS.dependentsCap) + 1,
  });
  if (files === null) return null;
  return files.filter((f) => f !== input.path).slice(0, opts?.cap ?? LIMITS.dependentsCap);
}
