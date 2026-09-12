/**
 * Small shared helpers for @relay/core: hashing, atomic file writes, JSON
 * reads, time formatting. Node built-ins only (§2.2 zero-dep hook bundle).
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  promises as fsp,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { IsoTime } from './protocol.js';

/** Lower-case hex sha1 of a string (repoKey, mark keys, hunk hashes, §4.0). */
export function sha1(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Current time as ISO-8601 UTC (millisecond precision). */
export function nowIso(now: number = Date.now()): IsoTime {
  return new Date(now).toISOString();
}

/** Parse an ISO time; NaN-safe (returns null for garbage). */
export function parseIso(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** `HH:MM:SSZ` for hook context lines (§4.0 rule 15). */
export function shortTime(iso: string | number | null | undefined): string {
  const t = typeof iso === 'number' ? iso : parseIso(iso);
  if (t === null) return '??:??Z';
  return new Date(t).toISOString().slice(11, 19) + 'Z';
}

/** `HH:MMZ` for status lines and labels (§4.11, §6.5). */
export function hhmm(iso: string | number | null | undefined): string {
  const t = typeof iso === 'number' ? iso : parseIso(iso);
  if (t === null) return '??:??Z';
  return new Date(t).toISOString().slice(11, 16) + 'Z';
}

/** `2026-09-12T09:41Z` — the digest's absolute timestamp form (§9.3). */
export function dateTimeZ(iso: string | number | null | undefined): string {
  const t = typeof iso === 'number' ? iso : parseIso(iso);
  if (t === null) return 'unknown';
  return new Date(t).toISOString().slice(0, 16) + 'Z';
}

/** Human duration for cached labels: "12m", "3h", "2d". */
export function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Truncate on a word boundary with an ellipsis, never exceeding `max` chars. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return head.trimEnd() + '…';
}

/**
 * Teammate-supplied text destined for a `<relay-*>` block (§4.0 rule 15, §11):
 * one line (newlines collapsed), no `<relay-` / `</relay-` sequence that could
 * close the block and continue as unmarked instructions, capped on a word
 * boundary. Applied on the hub at insert time and again by every renderer.
 */
export function inlineText(text: string | null | undefined, max = 500): string {
  if (!text) return '';
  return truncateWords(neutralizeRelayTags(text.replace(/\s+/g, ' ').trim()), max);
}

/** Multi-line variant for diff hunks: only the block-closing sequences are defused, newlines stay. */
export function neutralizeRelayTags(text: string): string {
  return text.replace(/<\s*(\/?)\s*relay-/gi, '‹$1relay-');
}

/** Truncate at a line boundary, never exceeding `max` chars. */
export function truncateLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.5 ? cut.slice(0, nl) : cut).trimEnd();
}

/** Byte length of a UTF-8 string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Clamp a number into [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// File helpers (sync: the hooks read a handful of small files in 1–2 ms)
// ---------------------------------------------------------------------------

/** mkdir -p; never throws. */
export function ensureDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 file; null when missing or unreadable. */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse a JSON file; null when missing, unreadable or malformed. */
export function readJson(path: string): unknown {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Parse a JSON file through a type guard. */
export function readJsonAs<T>(path: string, guard: (x: unknown) => x is T): T | null {
  const value = readJson(path);
  return guard(value) ? value : null;
}

/** tmp + rename write so readers never see a partial file (§4.0 rule 8). Never throws; returns success. */
export function writeAtomic(path: string, data: string): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    ensureDir(dirname(path));
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** Atomic JSON write. */
export function writeJsonAtomic(path: string, value: unknown, pretty = false): boolean {
  return writeAtomic(path, pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value));
}

/** Async variant of writeAtomic for workers. */
export async function writeAtomicAsync(path: string, data: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, path);
    return true;
  } catch {
    await fsp.unlink(tmp).catch(() => undefined);
    return false;
  }
}

/** File mtime in epoch ms; null when missing. */
export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** File size in bytes; null when missing. */
export function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Does a path exist (any type)? */
export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** unlink that never throws. */
export function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Join helper that keeps call sites short. */
export function p(...parts: string[]): string {
  return join(...parts);
}

/** Promise-based sleep for lock spins. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable JSON (sorted keys) for content hashes such as configHash (§4.1). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
