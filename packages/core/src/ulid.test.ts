import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUlid, ulid, ulidTime } from './ulid.js';

describe('ulid', () => {
  it('produces 26-char Crockford ids that decode to their time', () => {
    const t = 1_757_669_000_123;
    const id = ulid(t);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(t);
  });

  it('is monotonic within one millisecond and across time', () => {
    const t = Date.now();
    const ids = Array.from({ length: 200 }, () => ulid(t));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    const later = ulid(t + 5);
    expect(later > ids[ids.length - 1]!).toBe(true);
  });

  it('never goes backwards when the wall clock does, but honours explicit times', () => {
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(2_000_000_000_000);
    const a = ulid();
    spy.mockReturnValue(1_999_999_000_000);
    const b = ulid();
    expect(b > a).toBe(true);
    expect(ulidTime(b)).toBe(2_000_000_000_000);
    spy.mockRestore();
    expect(ulidTime(ulid(1_000_000_000_000))).toBe(1_000_000_000_000);
  });

  afterEach(() => vi.restoreAllMocks());

  it('rejects malformed ids', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
    expect(ulidTime('nope')).toBeNull();
  });
});
