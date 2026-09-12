import { describe, expect, it } from 'vitest';
import { globToRegExp, isGlobPattern, matchAny, matchGlob } from './glob.js';
import { DEFAULT_CONTRACT_GLOBS } from './protocol.js';

describe('glob', () => {
  it('matches ** across zero or more directories', () => {
    expect(matchGlob('**/contracts/**', 'packages/contracts/src/billing.ts')).toBe(true);
    expect(matchGlob('**/contracts/**', 'contracts/x.ts')).toBe(true);
    expect(matchGlob('apps/app/**', 'apps/app/src/index.ts')).toBe(true);
    expect(matchGlob('apps/app/**', 'apps/dashboard/src/index.ts')).toBe(false);
  });

  it('handles braces, single stars and matchBase patterns', () => {
    expect(matchGlob('**/*.contract.{ts,js}', 'src/x.contract.ts')).toBe(true);
    expect(matchGlob('**/*.contract.{ts,js}', 'src/x.contract.py')).toBe(false);
    expect(matchGlob('packages/*/src/index.ts', 'packages/api/src/index.ts')).toBe(true);
    expect(matchGlob('packages/*/src/index.ts', 'packages/api/lib/src/index.ts')).toBe(false);
    expect(matchGlob('*.prisma', 'prisma/schema.prisma')).toBe(true);
    expect(matchGlob('schema.prisma', 'prisma/schema.prisma')).toBe(true);
  });

  it('treats a literal directory as a prefix target', () => {
    expect(matchGlob('apps/app', 'apps/app/src/a.ts')).toBe(true);
    expect(matchGlob('apps/app', 'apps/application/src/a.ts')).toBe(false);
    expect(matchGlob('apps/app/src/a.ts', 'apps/app/src/a.ts')).toBe(true);
  });

  it('covers the default contract globs', () => {
    const yes = [
      'packages/contracts/src/billing.ts',
      'packages/api/src/index.ts',
      'prisma/schema.prisma',
      'db/migrations/0042_x.sql',
      'docs/openapi.yaml',
      'apps/web/app/api/users/route.ts',
      'src/routes/users.ts',
      'src/types/invoice.ts',
      'lib/foo.d.ts',
      'schema/user.schema.json',
      '.env.example',
      'config/prod.env.example',
    ];
    for (const p of yes) expect(matchAny(DEFAULT_CONTRACT_GLOBS, p), p).not.toBeNull();
    const no = ['apps/app/src/Button.tsx', 'README.md', 'packages/api/src/handlers/users.ts'];
    for (const p of no) expect(matchAny(DEFAULT_CONTRACT_GLOBS, p), p).toBeNull();
  });

  it('exposes the regexp and pattern detection', () => {
    expect(globToRegExp('a/*.ts').test('a/b.ts')).toBe(true);
    expect(isGlobPattern('a/*.ts')).toBe(true);
    expect(isGlobPattern('a/b.ts')).toBe(false);
  });
});
