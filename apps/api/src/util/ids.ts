/**
 * ULID generator for hub records (§10.1 ids). Zero-dependency, monotonic within a
 * process; core's ulid.ts is the client-side twin and either can replace the other.
 */
import { randomBytes } from 'node:crypto';
import { ID_PREFIX } from '@relay/core';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // increment the previous random part so ids created in the same ms stay sorted
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      const v = (lastRandom[i] ?? 0) + 1;
      if (v < 32) {
        lastRandom[i] = v;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    const bytes = randomBytes(16);
    lastRandom = Array.from(bytes, (b) => b % 32);
  }
  return encodeTime(now) + lastRandom.map((v) => ALPHABET[v]).join('');
}

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind, now?: number): string {
  return ID_PREFIX[kind] + ulid(now);
}

export function isPrefixed(id: string, kind: IdKind): boolean {
  return id.startsWith(ID_PREFIX[kind]);
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Developer handles are self-declared (§3.3); this is the only shape the hub stores. */
export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}
