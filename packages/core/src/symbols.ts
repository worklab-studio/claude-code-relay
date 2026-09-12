/**
 * Cheap exported-symbol extraction per file type (§7.1): TS/JS exports and
 * signatures, Prisma models (via the hunk header), OpenAPI paths/schemas,
 * GraphQL types, proto messages/services, SQL tables; anything else is
 * file-level. Produces `{symbols, kinds, summary}` for ContractEvent.
 */
import { basename, extname } from 'node:path';
import type { ContractKind } from './protocol.js';
import type { DiffHunk } from './contracts.js';

export type FileLang = 'ts' | 'js' | 'py' | 'go' | 'prisma' | 'openapi' | 'graphql' | 'proto' | 'sql' | 'other';

export interface SymbolExtraction {
  symbols: string[];
  kinds: ContractKind[];
  /** <= 240 chars, factual: `Invoice: total → amountDue, +currency; createInvoice(input) → createInvoice(input, currency)` */
  summary: string;
}

export function fileLang(path: string): FileLang {
  const base = basename(path).toLowerCase();
  const ext = extname(base);
  if (/^(openapi|swagger)[^/]*\.(json|ya?ml)$/.test(base)) return 'openapi';
  if (ext === '.prisma') return 'prisma';
  if (ext === '.graphql' || ext === '.gql') return 'graphql';
  if (ext === '.proto') return 'proto';
  if (ext === '.sql' || /(^|\/)migrations\//.test(path.toLowerCase())) return ext === '.sql' || ext === '' ? 'sql' : langByExt(ext);
  return langByExt(ext);
}

function langByExt(ext: string): FileLang {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.py':
      return 'py';
    case '.go':
      return 'go';
    default:
      return 'other';
  }
}

const SUMMARY_MAX = 240;
const SIG_MAX = 100;

interface SigChange {
  minus: string[];
  plus: string[];
}

function sigOf(text: string): string {
  let s = text.trim().replace(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?/, '');
  s = s.replace(/\s*(=>|\{|=)\s*$/, '');
  const cut = s.search(/\s*(\{|=>|=)(?![^(]*\))/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/\s+/g, ' ').trim().replace(/[;,]$/, '');
  return s.length > SIG_MAX ? s.slice(0, SIG_MAX - 1) + '…' : s;
}

function memberName(text: string): string | null {
  const m = /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\??\s*[:(<]/.exec(text);
  return m ? (m[1] ?? null) : null;
}

/** Group `-`/`+` names into `old → new` pairs when counts match, else `-old`, `+new`. */
function describeChanges(minus: string[], plus: string[]): string[] {
  const removed = minus.filter((n) => !plus.includes(n));
  const added = plus.filter((n) => !minus.includes(n));
  const changed = minus.filter((n) => plus.includes(n));
  const out: string[] = [];
  if (removed.length && removed.length === added.length) {
    removed.forEach((r, i) => out.push(`${r} → ${added[i]}`));
  } else {
    for (const r of removed) out.push(`-${r}`);
    for (const a of added) out.push(`+${a}`);
  }
  for (const c of changed) out.push(`~${c}`);
  return out;
}

function pushUnique(list: string[], value: string | null | undefined): void {
  if (value && !list.includes(value)) list.push(value);
}

function joinSummary(parts: string[], fallback: string): string {
  const s = parts.filter(Boolean).join('; ');
  if (!s) return fallback;
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1) + '…' : s;
}

// --- TS / JS -----------------------------------------------------------------

const TS_TOP_RE =
  /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(type|interface|enum|class|function\*?|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_BLOCK_RE = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type|enum|class)\s+([A-Za-z_$][\w$]*)/;
const ZOD_RE = /\bz\.object\(/;
const TRPC_RE = /\b(router\(|\.procedure\b)/;

function extractTs(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const kinds: ContractKind[] = [];
  const sigs = new Map<string, SigChange>();
  const members = new Map<string, SigChange>();
  for (const h of hunks) {
    const headerParent = TS_BLOCK_RE.exec(h.header)?.[1] ?? null;
    let parent: string | null = headerParent;
    let depth = headerParent ? 1 : 0;
    for (const l of h.lines) {
      const t = l.text;
      const top = TS_TOP_RE.exec(t);
      if (top) {
        const kind = top[1] ?? '';
        const name = top[2] ?? '';
        pushUnique(symbols, name);
        pushUnique(kinds, 'export');
        if (l.sign !== ' ') {
          const sc = sigs.get(name) ?? { minus: [], plus: [] };
          (l.sign === '-' ? sc.minus : sc.plus).push(sigOf(t));
          sigs.set(name, sc);
        }
        if (/^(interface|type|enum|class)$/.test(kind) && /\{\s*$/.test(t)) {
          parent = name;
          depth = 1;
        } else {
          parent = null;
          depth = 0;
        }
        if (ZOD_RE.test(t)) pushUnique(kinds, 'zod');
        if (TRPC_RE.test(t)) pushUnique(kinds, 'trpc');
        continue;
      }
      if (ZOD_RE.test(t)) pushUnique(kinds, 'zod');
      if (TRPC_RE.test(t)) pushUnique(kinds, 'trpc');
      if (parent) {
        const name = memberName(t);
        if (name && l.sign !== ' ') {
          pushUnique(symbols, parent);
          pushUnique(kinds, 'member');
          const mc = members.get(parent) ?? { minus: [], plus: [] };
          (l.sign === '-' ? mc.minus : mc.plus).push(name);
          members.set(parent, mc);
        }
        for (const c of t) {
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
        }
        if (depth <= 0) parent = null;
      }
    }
  }
  const parts: string[] = [];
  for (const [name, sc] of sigs) {
    const before = sc.minus[sc.minus.length - 1];
    const after = sc.plus[sc.plus.length - 1];
    const memberPart = members.get(name);
    if (before && after && before !== after) parts.push(`${before} → ${after}`);
    else if (after && !before) parts.push(`+${after}`);
    else if (before && !after) parts.push(`-${name}`);
    else if (!memberPart) parts.push(`~${name}`);
  }
  for (const [parent, mc] of members) {
    const desc = describeChanges(mc.minus, mc.plus);
    if (desc.length) parts.push(`${parent}: ${desc.join(', ')}`);
  }
  if (!kinds.length) kinds.push('file');
  return { symbols, kinds, summary: joinSummary(parts, symbols.length ? symbols.join(', ') : '') };
}

// --- Python / Go --------------------------------------------------------------

function extractPy(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const minus: string[] = [];
  const plus: string[] = [];
  for (const h of hunks) {
    const headerName = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(h.header)?.[1];
    for (const l of h.lines) {
      const m = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(l.text);
      const name = m?.[1] ?? (l.sign !== ' ' ? headerName : undefined);
      if (!name) continue;
      pushUnique(symbols, name);
      if (m && l.sign === '-') minus.push(name);
      if (m && l.sign === '+') plus.push(name);
    }
  }
  const desc = describeChanges(minus, plus);
  return { symbols, kinds: symbols.length ? ['python'] : ['file'], summary: joinSummary(desc.length ? desc : symbols, '') };
}

function extractGo(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const sigs = new Map<string, SigChange>();
  for (const h of hunks) {
    const headerName = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/.exec(h.header);
    const parent = headerName?.[1] ?? headerName?.[2] ?? null;
    for (const l of h.lines) {
      const m = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^\s*type\s+([A-Z]\w*)/.exec(l.text);
      const name = m?.[1] ?? m?.[2] ?? (l.sign !== ' ' ? parent : null);
      if (!name) continue;
      pushUnique(symbols, name);
      if (m && l.sign !== ' ') {
        const sc = sigs.get(name) ?? { minus: [], plus: [] };
        (l.sign === '-' ? sc.minus : sc.plus).push(sigOf(l.text));
        sigs.set(name, sc);
      }
    }
  }
  const parts: string[] = [];
  for (const [name, sc] of sigs) {
    const b = sc.minus[sc.minus.length - 1];
    const a = sc.plus[sc.plus.length - 1];
    if (b && a && b !== a) parts.push(`${b} → ${a}`);
    else if (a && !b) parts.push(`+${a}`);
    else if (b && !a) parts.push(`-${name}`);
  }
  return { symbols, kinds: symbols.length ? ['go'] : ['file'], summary: joinSummary(parts.length ? parts : symbols, '') };
}

// --- Schema-type files --------------------------------------------------------

function extractPrisma(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const members = new Map<string, SigChange>();
  for (const h of hunks) {
    let model = /^(?:model|enum|type)\s+(\w+)/.exec(h.header)?.[1] ?? null;
    for (const l of h.lines) {
      const m = /^\s*(?:model|enum|type)\s+(\w+)/.exec(l.text);
      if (m) {
        model = m[1] ?? null;
        pushUnique(symbols, model);
        continue;
      }
      if (/^\s*}/.test(l.text)) {
        model = null;
        continue;
      }
      if (model && l.sign !== ' ') {
        const field = /^\s*(\w+)\s+\S/.exec(l.text)?.[1];
        if (!field || field.startsWith('@')) continue;
        pushUnique(symbols, model);
        const mc = members.get(model) ?? { minus: [], plus: [] };
        (l.sign === '-' ? mc.minus : mc.plus).push(field);
        members.set(model, mc);
      }
    }
  }
  const parts: string[] = [];
  for (const [model, mc] of members) {
    const desc = describeChanges(mc.minus, mc.plus);
    parts.push(desc.length ? `model ${model} ${desc.join(', ')}` : `model ${model}`);
  }
  for (const s of symbols) if (!members.has(s)) parts.push(`model ${s}`);
  return { symbols, kinds: symbols.length ? ['prisma'] : ['file'], summary: joinSummary(parts, '') };
}

function extractGraphql(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const re = /^\s*(?:extend\s+)?(?:type|input|enum|interface|union|scalar)\s+(\w+)/;
  for (const h of hunks) {
    const parent = re.exec(h.header)?.[1] ?? null;
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) pushUnique(symbols, m[1]);
      else if (l.sign !== ' ' && parent) pushUnique(symbols, parent);
    }
  }
  return { symbols, kinds: symbols.length ? ['graphql'] : ['file'], summary: joinSummary(symbols, '') };
}

function extractProto(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const re = /^\s*(?:message|service|enum|rpc)\s+(\w+)/;
  for (const h of hunks) {
    const parent = re.exec(h.header)?.[1] ?? null;
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) pushUnique(symbols, m[1]);
      else if (l.sign !== ' ' && parent) pushUnique(symbols, parent);
    }
  }
  return { symbols, kinds: symbols.length ? ['proto'] : ['file'], summary: joinSummary(symbols, '') };
}

function extractSql(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  const re = /\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?["'`]?([\w.]+)/i;
  for (const h of hunks) {
    for (const l of h.lines) {
      const m = re.exec(l.text);
      if (m) pushUnique(symbols, m[1]);
    }
  }
  return { symbols, kinds: symbols.length ? ['sql'] : ['file'], summary: joinSummary(symbols.map((s) => `table ${s}`), '') };
}

function extractOpenapi(hunks: readonly DiffHunk[]): SymbolExtraction {
  const symbols: string[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.sign === ' ') continue;
      const t = l.text;
      const yamlPath = /^\s*(\/[^\s:"']*)\s*:/.exec(t)?.[1];
      const jsonPath = /^\s*"(\/[^"]*)"\s*:/.exec(t)?.[1];
      const method = /^\s*"?(get|post|put|patch|delete|options|head)"?\s*:/i.exec(t)?.[1];
      const schema = /^\s{4,}"?([A-Z]\w*)"?\s*:\s*(\{|$)/.exec(t)?.[1];
      pushUnique(symbols, yamlPath ?? jsonPath);
      if (method) pushUnique(symbols, method.toUpperCase());
      pushUnique(symbols, schema);
    }
    const headerPath = /(\/[\w/{}.-]+)/.exec(h.header)?.[1];
    if (headerPath && h.lines.some((l) => l.sign !== ' ')) pushUnique(symbols, headerPath);
  }
  return { symbols, kinds: symbols.length ? ['openapi'] : ['file'], summary: joinSummary(symbols, '') };
}

/** Symbol extraction for one file's hunks; unknown types are file-level (§7.1). */
export function extractSymbols(path: string, hunks: readonly DiffHunk[]): SymbolExtraction {
  const lang = fileLang(path);
  let out: SymbolExtraction;
  switch (lang) {
    case 'ts':
    case 'js':
      out = extractTs(hunks);
      break;
    case 'py':
      out = extractPy(hunks);
      break;
    case 'go':
      out = extractGo(hunks);
      break;
    case 'prisma':
      out = extractPrisma(hunks);
      break;
    case 'graphql':
      out = extractGraphql(hunks);
      break;
    case 'proto':
      out = extractProto(hunks);
      break;
    case 'sql':
      out = extractSql(hunks);
      break;
    case 'openapi':
      out = extractOpenapi(hunks);
      break;
    default:
      out = { symbols: [], kinds: ['file'], summary: '' };
  }
  if (!out.summary) out.summary = `edited ${path}`;
  else out.summary = `${basename(path)}: ${out.summary}`.slice(0, SUMMARY_MAX);
  return out;
}
