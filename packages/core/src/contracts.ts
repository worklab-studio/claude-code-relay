/**
 * Contract candidate detection (§7.1, §7.2): path globs + `shared` areas, the
 * exported-symbol scan over `-U0 -w` hunks, hunk extraction (<= 1,500 chars),
 * and the whitespace-insensitive content hash that dedups the three detection
 * points. Pure functions over diff text; git access is the caller's job.
 */
import { matchAny } from './glob.js';
import { LIMITS, type ContractKind, type RelayArea, type RelayConfigResolved } from './protocol.js';
import { extractSymbols, fileLang, type FileLang, type SymbolExtraction } from './symbols.js';
import { sha1, truncateLines } from './util.js';

export interface DiffLine {
  sign: '+' | '-' | ' ';
  text: string;
}

export interface DiffHunk {
  /** function context after the second `@@` (git's funcname heuristic) */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

// Accepts the standard numeric header and the bare `@@ context` form that renderHunk used to emit.
const HUNK_RE = /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)? ?(.*)$/;

/** Parse unified diff text (one or more files) into hunks; file headers are skipped. */
export function parseUnifiedDiff(text: string | null | undefined): DiffHunk[] {
  if (!text) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\r$/, '');
    const m = HUNK_RE.exec(l);
    if (m) {
      current = {
        oldStart: m[1] === undefined ? 0 : Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: m[3] === undefined ? 0 : Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        header: (m[5] ?? '').trim(),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (l.startsWith('diff --git') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ')) {
      current = null;
      continue;
    }
    if (l.startsWith('\\')) continue; // "\ No newline at end of file"
    const sign = l[0];
    if (sign === '+' || sign === '-' || sign === ' ') current.lines.push({ sign, text: l.slice(1) });
  }
  return hunks;
}

/** Comment-only line for the language (whitespace-only lines are already gone with `-w`). */
export function isCommentLine(text: string, lang: FileLang): boolean {
  const t = text.trim();
  if (!t) return true;
  switch (lang) {
    case 'ts':
    case 'js':
    case 'go':
    case 'proto':
      return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/');
    case 'py':
    case 'prisma':
    case 'graphql':
    case 'openapi':
      return t.startsWith('#') || t.startsWith('"""') || t.startsWith('//');
    case 'sql':
      return t.startsWith('--') || t.startsWith('/*');
    default:
      return false;
  }
}

/** Changed (`+`/`-`) lines that are neither blank nor comment-only. */
export function meaningfulLines(hunks: readonly DiffHunk[], lang: FileLang): DiffLine[] {
  const out: DiffLine[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === ' ') continue;
      if (!l.text.trim() || isCommentLine(l.text, lang)) continue;
      out.push(l);
    }
  }
  return out;
}

/** Canonical form for hashing: `+`/`-` lines with all whitespace removed, in order. Headers and line numbers are ignored so a re-indent or a shifted hunk keeps its identity. */
export function normalizeHunks(hunks: readonly DiffHunk[]): string {
  const parts: string[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === ' ') continue;
      const t = l.text.replace(/\s+/g, '');
      if (t) parts.push(l.sign + t);
    }
  }
  return parts.join('\n');
}

/** `hash = sha1(normalized hunk)` (§7.2). */
export function hunkHash(hunksOrText: readonly DiffHunk[] | string): string {
  const hunks = typeof hunksOrText === 'string' ? parseUnifiedDiff(hunksOrText) : hunksOrText;
  return sha1(normalizeHunks(hunks));
}

/** Render hunks for the wire: `@@ context` headers plus changed lines, <= `max` chars on a line boundary (§4.5). */
export function renderHunk(hunks: readonly DiffHunk[], max: number = LIMITS.hunkChars): string {
  const lines: string[] = [];
  for (const h of hunks) {
    const changed = h.lines.filter((l) => l.sign !== ' ');
    if (!changed.length) continue;
    lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.header ? ' ' + h.header : ''}`);
    for (const l of changed) lines.push(l.sign + l.text);
  }
  return truncateLines(lines.join('\n'), max);
}

/** The `+` lines of a hunk (content-path ancestry check, §4.12). */
export function plusLines(hunks: readonly DiffHunk[]): string[] {
  const out: string[] = [];
  for (const h of hunks) for (const l of h.lines) if (l.sign === '+' && l.text.trim()) out.push(l.text);
  return out;
}

/** Every non-blank `+` line of the hunk appears in `content` (whitespace-insensitive) — the squash/rebase-safe "already in my branch" test (§7.2). */
export function hunkContainedIn(hunk: string, content: string): boolean {
  const plus = plusLines(parseUnifiedDiff(hunk));
  if (!plus.length) return false;
  const haystack = content.replace(/\s+/g, '');
  return plus.every((l) => haystack.includes(l.replace(/\s+/g, '')));
}

/** Whole diff has no changed lines at all (revert -> retract, §4.5 step 2). */
export function diffIsEmpty(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return true;
  return parseUnifiedDiff(text).every((h) => h.lines.every((l) => l.sign === ' '));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface ContractPathInput {
  globs: readonly string[];
  areas?: Record<string, RelayArea>;
}

/** Path matches a contract glob or lies under a `shared: true` area (§7.1 signal 1). */
export function isContractPath(path: string, cfg: ContractPathInput): boolean {
  if (matchAny(cfg.globs, path)) return true;
  for (const area of Object.values(cfg.areas ?? {})) {
    if (area.shared && matchAny(area.paths, path)) return true;
  }
  return false;
}

const TS_EXPORT_RE =
  /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:type|interface|enum|class|function\*?|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_EXPORT_BLOCK_HEADER_RE = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type|enum|class)\s+([A-Za-z_$][\w$]*)/;
const TS_MEMBER_RE = /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\??\s*[:(<]/;
const PY_DEF_RE = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
const GO_FUNC_RE = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/;
const GO_TYPE_RE = /^\s*type\s+([A-Z]\w*)/;
const ZOD_TRPC_RE = /\b(z\.object\(|router\(|\.procedure\b)/;

/** Exported-symbol scan (§7.1 signal 2) on TS/JS/Python/Go hunks. */
export function exportScanHit(hunks: readonly DiffHunk[], lang: FileLang): boolean {
  if (lang !== 'ts' && lang !== 'js' && lang !== 'py' && lang !== 'go') return false;
  for (const h of hunks) {
    let inExportBlock = TS_EXPORT_BLOCK_HEADER_RE.test(h.header) && braceDepth(h.header) > 0;
    let depth = inExportBlock ? 1 : 0;
    for (const l of h.lines) {
      const t = l.text;
      if (isCommentLine(t, lang)) continue;
      if (lang === 'ts' || lang === 'js') {
        if (l.sign !== ' ' && (TS_EXPORT_RE.test(t) || ZOD_TRPC_RE.test(t))) return true;
        if (TS_EXPORT_BLOCK_HEADER_RE.test(t)) {
          inExportBlock = true;
          depth = braceDepth(t) > 0 ? 1 : 0;
          if (depth === 0) inExportBlock = false;
          continue;
        }
        if (inExportBlock) {
          if (l.sign !== ' ' && TS_MEMBER_RE.test(t)) return true;
          depth += braceDepth(t);
          if (depth <= 0) inExportBlock = false;
        }
      } else if (lang === 'py') {
        if (l.sign !== ' ' && PY_DEF_RE.test(t)) return true;
      } else if (lang === 'go') {
        if (l.sign !== ' ' && (GO_FUNC_RE.test(t) || GO_TYPE_RE.test(t))) return true;
      }
    }
  }
  return false;
}

/** `{` minus `}` on a line (string literals ignored — good enough for hunks). */
export function braceDepth(text: string): number {
  let d = 0;
  for (const c of text) {
    if (c === '{') d += 1;
    else if (c === '}') d -= 1;
  }
  return d;
}

export interface ContractCandidate extends SymbolExtraction {
  path: string;
  lang: FileLang;
  viaGlob: boolean;
  viaExport: boolean;
  /** rendered `+`/`-` lines with `@@` context, <= 1,500 chars (redact before sending) */
  hunk: string;
  hash: string;
  hunks: DiffHunk[];
}

export interface DetectContractInput {
  path: string;
  /** output of `git diff -U0 -w HEAD -- <path>` (or a commit's `git show -U0 -w`) */
  diffText: string | null;
  config: Pick<RelayConfigResolved, 'contracts' | 'areas'>;
}

/** Empty/absent diff -> null (caller decides retract); no glob and no export hit -> null; else the candidate. */
export function detectContract(input: DetectContractInput): ContractCandidate | null {
  if (diffIsEmpty(input.diffText)) return null;
  const hunks = parseUnifiedDiff(input.diffText);
  const lang = fileLang(input.path);
  if (!meaningfulLines(hunks, lang).length) return null; // comment-only change
  const viaGlob = isContractPath(input.path, { globs: input.config.contracts.globs, areas: input.config.areas });
  const viaExport = !viaGlob && input.config.contracts.export_scan && exportScanHit(hunks, lang);
  if (!viaGlob && !viaExport) return null;
  const extraction = extractSymbols(input.path, hunks);
  return {
    ...extraction,
    path: input.path,
    lang,
    viaGlob,
    viaExport,
    hunk: renderHunk(hunks),
    hash: hunkHash(hunks),
    hunks,
  };
}

/** Kinds worth routing above `low` even with no dependents (schema-type files default to all areas, §7.3). */
export function isSchemaKind(kinds: readonly ContractKind[]): boolean {
  return kinds.some((k) => k === 'prisma' || k === 'openapi' || k === 'graphql' || k === 'proto' || k === 'sql');
}
