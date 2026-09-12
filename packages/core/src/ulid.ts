/**
 * Monotonic ULID generator, no dependency (docs/BUILD-PLAN.md). Used for
 * event ids (idempotency keys, §10.1) and outbox file names (§4.0 rule 6):
 * lexicographic order == creation order, so `ls outbox` is oldest-first.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod] + out;
    t = (t - mod) / 32;
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const out: number[] = [];
  for (let i = 0; i < RANDOM_LEN; i++) out.push((bytes[i] ?? 0) % 32);
  return out;
}

/** Increment the random part by one (carry); wraps around only after 2^80 ids in one ms. */
function increment(digits: number[]): number[] {
  const out = digits.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = (out[i] ?? 0) + 1;
    if (v < 32) {
      out[i] = v;
      return out;
    }
    out[i] = 0;
  }
  return out;
}

/**
 * A 26-char ULID. Without an argument it is monotonic within this process
 * (same-millisecond calls increment; a clock that went backwards keeps the
 * previous time). An explicit `now` is honoured as given (outbox tests and
 * replays stamp historical times).
 */
export function ulid(now?: number): string {
  const explicit = now !== undefined;
  const time = Math.max(0, Math.floor(now ?? Date.now()));
  if (time === lastTime) {
    lastRandom = increment(lastRandom);
  } else if (time > lastTime) {
    lastTime = time;
    lastRandom = freshRandom();
  } else if (explicit) {
    return encodeTime(time) + freshRandom().map((d) => ENCODING[d] ?? '0').join('');
  } else {
    lastRandom = increment(lastRandom);
  }
  const rand = lastRandom.map((d) => ENCODING[d] ?? '0').join('');
  return encodeTime(lastTime) + rand;
}

/** Epoch milliseconds encoded in a ULID; null when malformed. */
export function ulidTime(id: string): number | null {
  if (!isUlid(id)) return null;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id.charAt(i).toUpperCase());
    if (idx < 0) return null;
    t = t * 32 + idx;
  }
  return t;
}

/** Structural check: 26 Crockford base32 chars, first char <= '7'. */
export function isUlid(id: unknown): id is string {
  return typeof id === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(id);
}
