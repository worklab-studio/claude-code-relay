/**
 * Secret redaction for every outbound text field (§11.1): cloud/API keys,
 * GitHub/Slack/Stripe/Anthropic/OpenAI tokens, Relay `rt_` team tokens, JWTs,
 * private key blocks, `Authorization:`/`password=`/`token=` values and
 * high-entropy base64 strings >= 32 chars -> `[redacted]`.
 */

export const REDACTED = '[redacted]';

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\brt_[A-Za-z0-9]{32,}\b/g, // Relay team token (§11.1)
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/g, // Slack incoming webhook (the path is the secret)
];

/** `Authorization: Bearer xxx` -> keep the scheme, redact the credential. */
const AUTH_HEADER = /(\bauthorization\s*[:=]\s*)(?:(bearer|basic|token|digest)\s+)?(['"]?)([^\s'",;]+)\3/gi;
/**
 * `password=…`, `token: "…"`, `api_key=…`, `secret=…` — value redacted, key kept. The
 * key may carry a `WORD_` prefix (`DB_PASSWORD`, `MY_SECRET`, `RELAY_TEAM_TOKEN`): `_` is
 * a word character, so a bare `\b` before the keyword would never match `.env` shapes.
 */
const KEY_VALUE =
  /\b([\w-]*?(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|refresh[_-]?token|session[_-]?token|apikey)\b[\w.-]*)(\s*[:=]\s*)(['"`]?)([^\s'"`,;&)]{4,})\3/gi;
/** `scheme://user:password@host` — the userinfo password of a connection string. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:)([^\s@\/]+)(@)/gi;
/** AWS secret access key next to its label. */
const AWS_SECRET = /(aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})/gi;

/** Values that are obviously not secrets: env references, `<placeholders>`, `xxx`, ALL_CAPS constant names, literals. Case-sensitive so `[A-Z_]{4,}` only matches constant names. */
const PLACEHOLDER_VALUE = /^(\$\{?[\w.]+\}?|<[^>]+>|[xX]+|\*+|\.{3}|process\.env\.[\w.]+|env\.[\w.]+|[A-Z_]{4,}|null|undefined|true|false|none|None|NULL|redacted|\[redacted\])$/;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** High-entropy base64-ish token >= 32 chars with mixed case and digits (never plain hex SHAs or paths). */
export function looksLikeSecretToken(token: string): boolean {
  if (token.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false; // git SHAs, digests
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(token)) return false; // ULID
  return shannonEntropy(token) >= 4.2;
}

const BASE64ISH = /[A-Za-z0-9+/=_-]{32,}/g;

/** Redact secrets in a string (idempotent; safe on empty/undefined input). */
export function redact(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_HEADER, (_m, pre: string, scheme: string | undefined) => `${pre}${scheme ? scheme + ' ' : ''}${REDACTED}`);
  out = out.replace(AWS_SECRET, (_m, pre: string) => `${pre}${REDACTED}`);
  out = out.replace(KEY_VALUE, (m: string, key: string, sep: string, q: string, value: string) => {
    if (PLACEHOLDER_VALUE.test(value)) return m;
    return `${key}${sep}${q}${REDACTED}${q}`;
  });
  out = out.replace(URL_USERINFO, (_m, pre: string, _pw: string, at: string) => `${pre}${REDACTED}${at}`);
  out = out.replace(BASE64ISH, (tok: string) => (looksLikeSecretToken(tok) ? REDACTED : tok));
  return out;
}

/** Redact every string inside a JSON-like value (arrays/objects walked, other types untouched). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
