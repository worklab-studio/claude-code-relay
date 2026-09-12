import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpHome } from '../test/tmp.js';
import { buildDepIndexFromLines, dependentSpecifiers, nearestPackageName, normalizeSpecifier, parseGrepLines, parseImportLine, shrinkDepIndex } from './depindex.js';
import { LIMITS } from './protocol.js';

describe('import parsing', () => {
  it('parses ES, CJS, python and go forms', () => {
    expect(parseImportLine("import { Invoice, createInvoice as ci } from '@acme/contracts/billing'")).toEqual({ specifier: '@acme/contracts/billing', identifiers: ['Invoice', 'createInvoice'] });
    expect(parseImportLine("import * as billing from './billing'")).toEqual({ specifier: './billing', identifiers: ['billing'] });
    expect(parseImportLine("import React, { useState } from 'react'")).toEqual({ specifier: 'react', identifiers: ['useState', 'React'] });
    expect(parseImportLine("import type { Foo } from './types'")).toEqual({ specifier: './types', identifiers: ['Foo'] });
    expect(parseImportLine("export { a } from './a'")).toEqual({ specifier: './a', identifiers: ['a'] });
    expect(parseImportLine("import './side-effect'")).toEqual({ specifier: './side-effect', identifiers: [] });
    expect(parseImportLine("const { x } = require('pkg')")).toEqual({ specifier: 'pkg', identifiers: ['x'] });
    expect(parseImportLine('from app.models import Invoice, Order as O', 'py')).toEqual({ specifier: 'app.models', identifiers: ['Invoice', 'Order'] });
    expect(parseImportLine('import "github.com/acme/app/contracts"', 'go')).toEqual({ specifier: 'github.com/acme/app/contracts', identifiers: [] });
    expect(parseImportLine('const x = 1')).toBeNull();
  });

  it('normalizes specifiers', () => {
    expect(normalizeSpecifier('@acme/contracts/billing', 'apps/x.ts')).toEqual({ kind: 'package', key: '@acme/contracts', deepKey: '@acme/contracts/billing' });
    expect(normalizeSpecifier('react', 'apps/x.ts')).toEqual({ kind: 'package', key: 'react' });
    expect(normalizeSpecifier('../contracts/billing.js', 'packages/api/src/x.ts')).toEqual({ kind: 'relative', key: 'packages/api/contracts/billing' });
    expect(normalizeSpecifier('./index', 'packages/api/src/x.ts')).toEqual({ kind: 'relative', key: 'packages/api/src' });
    expect(normalizeSpecifier('node:fs', 'x.ts')).toEqual({ kind: 'builtin', key: 'node:fs' });
  });
});

describe('dependency index', () => {
  it('builds imports, symbols and contractPaths from grep lines', () => {
    const lines = parseGrepLines([
      "apps/dashboard/src/invoices.tsx:1:import { Invoice } from '@acme/contracts/billing'",
      "apps/dashboard/src/api/client.ts:3:import type { Invoice, Order } from '@acme/contracts'",
      "packages/api/src/invoices.ts:2:import { createInvoice } from '../../contracts/src/billing'",
      "packages/api/src/invoices.ts:9:  const rows = await prisma.invoice.findMany()",
      "apps/dashboard/src/hooks/useOrders.ts:4:  return fetch('/api/orders')",
      "packages/api/src/x.ts:1:import { a } from './index'",
      'garbage line without colon',
    ]);
    const idx = buildDepIndexFromLines(lines, { repo: 'github.com/acme/app', head: 'abc' });
    expect(idx.imports['@acme/contracts']).toEqual(['apps/dashboard/src/invoices.tsx', 'apps/dashboard/src/api/client.ts']);
    expect(idx.imports['@acme/contracts/billing']).toEqual(['apps/dashboard/src/invoices.tsx']);
    expect(idx.imports['packages/contracts/src/billing']).toEqual(['packages/api/src/invoices.ts']);
    expect(idx.imports['/api/orders']).toEqual(['apps/dashboard/src/hooks/useOrders.ts']);
    expect(idx.symbols['Invoice']).toEqual(['apps/dashboard/src/invoices.tsx', 'apps/dashboard/src/api/client.ts']);
    expect(idx.symbols['prisma.invoice']).toEqual(['packages/api/src/invoices.ts']);
    expect(idx.contractPaths['billing']).toEqual(['packages/api/src/invoices.ts']);
    expect(idx.contractPaths['packages/contracts/src/billing']).toEqual(['packages/api/src/invoices.ts']);
    expect(idx.contractPaths['index']).toBeUndefined(); // generic basename excluded (§7.4)
    expect(idx.contractPaths['packages/api/src']).toEqual(['packages/api/src/x.ts']);
    expect(idx.head).toBe('abc');
  });

  it('shrinks an oversized index under the client cap: symbols first, then file lists, then keys (review)', () => {
    const files = Array.from({ length: 200 }, (_, i) => `apps/app/src/very/long/module/path/number/${i}/component.tsx`);
    const imports: Record<string, string[]> = {};
    const symbols: Record<string, string[]> = {};
    for (let k = 0; k < 400; k++) {
      imports[`@acme/pkg${k}`] = files;
      symbols[`Symbol${k}`] = files;
    }
    const idx = buildDepIndexFromLines([], { repo: 'r', head: 'h' });
    const big = { ...idx, imports, symbols, contractPaths: { ...imports } };
    expect(JSON.stringify(big).length).toBeGreaterThan(LIMITS.payloadClientMaxBytes);
    const small = shrinkDepIndex(big);
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(LIMITS.payloadClientMaxBytes);
    expect(Object.keys(small.symbols)).toHaveLength(0);
    expect(Object.keys(small.imports).length).toBeGreaterThan(0);
    expect(shrinkDepIndex(idx)).toBe(idx); // small index untouched
  });

  it('finds the nearest package name', () => {
    const t = tmpHome();
    try {
      mkdirSync(join(t.home, 'packages/contracts/src'), { recursive: true });
      writeFileSync(join(t.home, 'packages/contracts/package.json'), JSON.stringify({ name: '@acme/contracts' }));
      writeFileSync(join(t.home, 'package.json'), JSON.stringify({ name: 'root' }));
      expect(nearestPackageName(t.home, 'packages/contracts/src/billing.ts')).toBe('@acme/contracts');
      expect(nearestPackageName(t.home, 'apps/x.ts')).toBe('root');
    } finally {
      t.cleanup();
    }
  });

  it('builds grep specifiers for a changed file', () => {
    const specs = dependentSpecifiers({ path: 'packages/contracts/src/billing.ts', packageName: '@acme/contracts', kind: 'ts' });
    const joined = specs.join('|');
    expect(joined).toContain("['\"]@acme/contracts['\"]");
    expect(joined).toContain('@acme/contracts/billing');
    expect(joined).toContain('/billing(\\.js|\\.ts)?[\'"]');
    expect(joined).toContain('packages/contracts/src/billing');
    for (const s of specs) expect(() => new RegExp(s)).not.toThrow();
    const prisma = dependentSpecifiers({ path: 'prisma/schema.prisma', symbols: ['Invoice'], kind: 'prisma' });
    expect(prisma.join('|')).toContain('prisma\\.invoice([^A-Za-z0-9_]|$)');
    const idx = dependentSpecifiers({ path: 'packages/api/src/index.ts', packageName: '@acme/api' });
    expect(idx.some((s) => s === "/index(\\.js|\\.ts)?['\"]")).toBe(false); // generic basename never grep'd alone
  });
});
