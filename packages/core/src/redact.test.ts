import { describe, expect, it } from 'vitest';
import { REDACTED, looksLikeSecretToken, redact, redactDeep } from './redact.js';

describe('redact', () => {
  it('redacts known key formats', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdefghij',
      'sk_live_abcdefghij1234567890',
      'rk_live_abcdefghij1234567890',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'rt_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ];
    for (const s of samples) {
      const out = redact(`token is ${s} here`);
      expect(out, s).not.toContain(s);
      expect(out, s).toContain(REDACTED);
    }
  });

  it('redacts private key blocks and header/kv values while keeping keys', () => {
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIB\nxyz\n-----END RSA PRIVATE KEY-----')).toBe(REDACTED);
    expect(redact('Authorization: Bearer abc.def-ghi')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redact('password=hunter22 and token: "supersecretvalue"')).toBe(`password=${REDACTED} and token: "${REDACTED}"`);
    expect(redact('api_key = abcd1234')).toBe(`api_key = ${REDACTED}`);
    expect(redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(`aws_secret_access_key = ${REDACTED}`);
  });

  it('leaves placeholders, hex SHAs, paths and prose alone', () => {
    const keep = [
      'commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 on feat/currency',
      'packages/contracts/src/billing.ts exports createInvoice(input, currency)',
      'token = ${RELAY_TOKEN}',
      'password: <your-password>',
      'RELAY_TOKEN=process.env.RELAY_TOKEN',
      'the sha256 is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'set token=xxx',
      'ULID 01J9X3K2M4N5P6Q7R8S9T0V1W2',
    ];
    for (const s of keep) expect(redact(s), s).toBe(s);
  });

  it('catches high-entropy base64 blobs but not long identifiers', () => {
    expect(looksLikeSecretToken('Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O')).toBe(true);
    expect(looksLikeSecretToken('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(false);
    expect(looksLikeSecretToken('SomeVeryLongCamelCaseIdentifierNameHere1')).toBe(false);
    expect(redact('key Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O end')).toBe(`key ${REDACTED} end`);
  });

  it('is idempotent and walks objects', () => {
    const once = redact('password=abc12345');
    expect(redact(once)).toBe(once);
    expect(redactDeep({ a: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', b: [1, 'ok', { c: 'Authorization: Basic dXNlcjpwYXNz' }], d: null })).toEqual({
      a: REDACTED,
      b: [1, 'ok', { c: `Authorization: Basic ${REDACTED}` }],
      d: null,
    });
    expect(redact('')).toBe('');
    expect(redact(null)).toBe('');
  });
});
