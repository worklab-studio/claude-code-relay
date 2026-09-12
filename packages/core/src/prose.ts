/**
 * `prose()` (§4.8 step 1, §8.2, §11.1): strip fenced code blocks, inline code
 * longer than 80 chars, and diff / stack-trace lines from an assistant message,
 * then cap at 3,000 chars. Applied client-side before redaction.
 */
import { LIMITS } from './protocol.js';
import { truncateWords } from './util.js';

const DIFF_LINE = /^(?:diff --git |index [0-9a-f]{6,}\.\.[0-9a-f]{6,}|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|@@ -\d+|[+-](?![+-])(?:\s{2,}|\S))/;
const STACK_LINE =
  /^(?:\s+at\s+\S.*|\s*at\s+.*\(.*:\d+:\d+\)|Traceback \(most recent call last\):|\s+File ".*", line \d+.*|\s*\w*(?:Error|Exception)(?::\s|$).*|goroutine \d+ \[.*\]:|\s+\S+\.\S+\(.*\)\s*$|\s+\/\S+\.go:\d+.*)$/;
const INLINE_CODE = /`([^`\n]*)`/g;

/** Is the line diff-shaped? Prose lines starting with "- " (markdown bullets) are kept. */
export function isDiffLine(line: string): boolean {
  if (/^[-+] /.test(line) && !/^[-+] {2,}/.test(line)) return false; // "- bullet" / "+ bullet" -> prose
  return DIFF_LINE.test(line);
}

export function isStackTraceLine(line: string): boolean {
  return STACK_LINE.test(line);
}

/** A markdown indented code line (4+ spaces or a tab) that is not a nested list item. */
export function isIndentedCodeLine(line: string): boolean {
  if (!/^(?: {4,}|\t)\S/.test(line)) return false;
  return !/^\s+(?:[-*+•]|\d+[.)])\s/.test(line);
}

export interface ProseOptions {
  max?: number;
  inlineCodeMax?: number;
}

/** Strip code and traces; keep prose (§4.8). */
export function prose(text: string | null | undefined, opts: ProseOptions = {}): string {
  if (!text) return '';
  const max = opts.max ?? LIMITS.turnTextChars;
  const inlineMax = opts.inlineCodeMax ?? 80;
  let t = text.replace(/\r\n?/g, '\n');
  // fenced blocks (``` or ~~~) at any indentation — Claude Code nests fences inside numbered
  // and bulleted list items constantly — including an unterminated trailing one
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$1');
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*$/g, '$1');
  // long inline code
  t = t.replace(INLINE_CODE, (m, inner: string) => (inner.length > inlineMax ? '' : m));
  const lines: string[] = [];
  let prevKept: string | null = null;
  for (const l of t.split('\n')) {
    if (isDiffLine(l) || isStackTraceLine(l)) continue;
    // indented code block (4+ spaces / a tab) after a blank line or a line ending with ':'; nested list items stay
    if (isIndentedCodeLine(l) && (prevKept === null || prevKept.trim() === '' || prevKept.trimEnd().endsWith(':'))) continue;
    lines.push(l);
    prevKept = l;
  }
  const joined = lines
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncateWords(joined, max);
}
