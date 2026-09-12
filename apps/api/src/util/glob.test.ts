import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTRACT_GLOBS } from '@relay/core';
import { areaOf, defaultProject, isContractPath, resolveConfig } from './config.js';
import { matchesAny, matchesGlob, targetCovers } from './glob.js';

describe('glob matching (§5.4, §7.1)', () => {
  it('handles **, *, ? and {a,b}', () => {
    expect(matchesGlob('apps/app/src/x.ts', 'apps/app/**')).toBe(true);
    expect(matchesGlob('apps/app', 'apps/app/**')).toBe(true);
    expect(matchesGlob('apps/dashboard/src/x.ts', 'apps/app/**')).toBe(false);
    expect(matchesGlob('packages/contracts/src/index.ts', 'packages/*/src/index.ts')).toBe(true);
    expect(matchesGlob('packages/contracts/src/lib/index.ts', 'packages/*/src/index.ts')).toBe(false);
    expect(matchesGlob('src/billing.contract.ts', '**/*.contract.{ts,js}')).toBe(true);
    expect(matchesGlob('prisma/schema.prisma', '**/schema.prisma')).toBe(true);
    expect(matchesGlob('schema.prisma', '**/schema.prisma')).toBe(true);
    expect(matchesGlob('docs/openapi.yaml', '**/openapi*.{json,yaml,yml}')).toBe(true);
    expect(matchesGlob('apps/api/src/users/route.ts', '**/api/**/route.ts')).toBe(true);
    expect(matchesGlob('a/b.ts', '*.ts')).toBe(true); // no slash: basename anywhere
  });

  it('matches the default contract globs the way §7.1 lists them', () => {
    for (const p of ['packages/contracts/src/billing.ts', 'src/shared/types.ts', 'lib/foo.d.ts', 'db/migrations/0042_x.sql', 'api/schema.graphql', 'proto/orders.proto', 'config/.env.example']) {
      expect(matchesAny(p, DEFAULT_CONTRACT_GLOBS), p).toBe(true);
    }
    for (const p of ['apps/app/src/components/Button.tsx', 'README.md', 'package.json']) {
      expect(matchesAny(p, DEFAULT_CONTRACT_GLOBS), p).toBe(false);
    }
  });

  it('targetCovers handles paths, directory prefixes and globs (§6.3 claims)', () => {
    expect(targetCovers('apps/app/src/billing.ts', 'apps/app/src/billing.ts')).toBe(true);
    expect(targetCovers('apps/app', 'apps/app/src/billing.ts')).toBe(true);
    expect(targetCovers('apps/app/', 'apps/app/src/billing.ts')).toBe(true);
    expect(targetCovers('apps/app/**', 'apps/app/src/billing.ts')).toBe(true);
    expect(targetCovers('apps/appx', 'apps/app/src/billing.ts')).toBe(false);
  });
});

describe('config resolution (§5.4)', () => {
  it('derives the project from the slug and applies "+glob" prepend semantics', () => {
    expect(defaultProject('github.com/acme/app')).toBe('acme/app');
    expect(defaultProject('local/app')).toBe('app');
    const plus = resolveConfig('github.com/acme/app', { contracts: { globs: ['+**/*.graphql2'] } });
    expect(plus.contracts.globs[0]).toBe('**/*.graphql2');
    expect(plus.contracts.globs).toContain('**/contracts/**');
    const replace = resolveConfig('github.com/acme/app', { contracts: { globs: ['only/**'] } });
    expect(replace.contracts.globs).toEqual(['only/**']);
    expect(replace.impacts.debounce_minutes).toBe(3);
    expect(replace.collision.hot).toBe('ask');
    expect(replace.handoff.idle_minutes).toBe(20);
  });

  it('areaOf uses declared globs, then the first two path segments; shared areas are contracts', () => {
    const cfg = resolveConfig('demo/app', {
      areas: { app: { paths: ['apps/app/**'] }, contracts: { paths: ['packages/contracts/**'], shared: true } },
    });
    expect(areaOf('apps/app/src/x.ts', cfg.areas)).toBe('app');
    expect(areaOf('packages/contracts/src/x.ts', cfg.areas)).toBe('contracts');
    expect(areaOf('apps/dashboard/src/x.ts', cfg.areas)).toBe('apps/dashboard');
    expect(areaOf('README.md', cfg.areas)).toBeNull();
    expect(isContractPath('packages/contracts/src/x.ts', cfg)).toBe(true);
    expect(isContractPath('apps/app/src/x.ts', cfg)).toBe(false);
  });
});
