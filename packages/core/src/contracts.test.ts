import { describe, expect, it } from 'vitest';
import {
  braceDepth,
  detectContract,
  diffIsEmpty,
  exportScanHit,
  hunkContainedIn,
  hunkHash,
  isContractPath,
  normalizeHunks,
  parseUnifiedDiff,
  plusLines,
  renderHunk,
} from './contracts.js';
import { extractSymbols, fileLang } from './symbols.js';
import { RELAY_CONFIG_DEFAULTS, type RelayConfigResolved } from './protocol.js';

const billingDiff = `diff --git a/packages/contracts/src/billing.ts b/packages/contracts/src/billing.ts
index 1111111..2222222 100644
--- a/packages/contracts/src/billing.ts
+++ b/packages/contracts/src/billing.ts
@@ -12,1 +12,2 @@ export interface Invoice {
-  total: number
+  amountDue: number
+  currency: Currency
@@ -40,1 +41,1 @@ export function createInvoice(input: InvoiceInput): Invoice {
-export function createInvoice(input: InvoiceInput): Invoice {
+export function createInvoice(input: InvoiceInput, currency: Currency): Invoice {
`;

const config: Pick<RelayConfigResolved, 'contracts' | 'areas'> = {
  contracts: { ...RELAY_CONFIG_DEFAULTS.contracts },
  areas: { contracts: { paths: ['packages/contracts/**'], shared: true }, app: { paths: ['apps/app/**'] } },
};

describe('diff parsing and hashing', () => {
  it('parses hunks with header context', () => {
    const hunks = parseUnifiedDiff(billingDiff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe('export interface Invoice {');
    expect(hunks[0]?.lines.map((l) => l.sign)).toEqual(['-', '+', '+']);
    expect(hunks[1]?.newStart).toBe(41);
  });

  it('hashes whitespace-insensitively and ignores line numbers', () => {
    const a = hunkHash(billingDiff);
    const reindented = billingDiff.replace('-  total: number', '-      total:   number').replace('@@ -12,1 +12,2 @@', '@@ -99,1 +120,2 @@');
    expect(hunkHash(reindented)).toBe(a);
    expect(hunkHash(billingDiff.replace('amountDue', 'amountPaid'))).not.toBe(a);
    expect(normalizeHunks(parseUnifiedDiff(billingDiff))).toContain('+amountDue:number');
  });

  it('renders capped hunks and detects empty diffs', () => {
    const r = renderHunk(parseUnifiedDiff(billingDiff));
    expect(r.startsWith('@@ -12,1 +12,2 @@ export interface Invoice {')).toBe(true);
    expect(parseUnifiedDiff(r)).toHaveLength(2);
    expect(parseUnifiedDiff('@@ export interface X {\n+  a: 1\n')[0]?.header).toBe('export interface X {');
    expect(r).toContain('+  currency: Currency');
    expect(renderHunk(parseUnifiedDiff(billingDiff), 40).length).toBeLessThanOrEqual(40);
    expect(diffIsEmpty('')).toBe(true);
    expect(diffIsEmpty(null)).toBe(true);
    expect(diffIsEmpty(billingDiff)).toBe(false);
    expect(plusLines(parseUnifiedDiff(billingDiff))).toHaveLength(3);
  });

  it('content-path ancestry: every + line present in HEAD content', () => {
    const hunk = renderHunk(parseUnifiedDiff(billingDiff));
    const head = 'export interface Invoice {\n  amountDue: number\n  currency: Currency\n}\nexport function createInvoice(input: InvoiceInput, currency: Currency): Invoice {}';
    expect(hunkContainedIn(hunk, head)).toBe(true);
    expect(hunkContainedIn(hunk, head.replace('amountDue', 'total'))).toBe(false);
    expect(braceDepth('a { b { } ')).toBe(1);
  });
});

describe('contract detection', () => {
  it('matches globs and shared areas', () => {
    expect(isContractPath('packages/contracts/src/billing.ts', { globs: config.contracts.globs })).toBe(true);
    expect(isContractPath('apps/app/src/x.ts', { globs: config.contracts.globs, areas: config.areas })).toBe(false);
    expect(isContractPath('apps/app/src/x.ts', { globs: [], areas: { app: { paths: ['apps/app/**'], shared: true } } })).toBe(true);
  });

  it('export scan finds exported symbols and members, ignores comments and internals', () => {
    const exported = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-export function foo(a: string) {\n+export function foo(a: string, b: number) {\n');
    expect(exportScanHit(exported, 'ts')).toBe(true);
    const internal = parseUnifiedDiff('@@ -1,1 +1,1 @@ function helper() {\n-  const x = 1\n+  const x = 2\n');
    expect(exportScanHit(internal, 'ts')).toBe(false);
    const comment = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-// export function foo()\n+// export function bar()\n');
    expect(exportScanHit(comment, 'ts')).toBe(false);
    const member = parseUnifiedDiff('@@ -3,1 +3,1 @@ export interface Invoice {\n-  total: number\n+  amountDue: number\n');
    expect(exportScanHit(member, 'ts')).toBe(true);
    const memberOutside = parseUnifiedDiff('@@ -3,1 +3,1 @@ interface Internal {\n-  total: number\n+  amountDue: number\n');
    expect(exportScanHit(memberOutside, 'ts')).toBe(false);
    expect(exportScanHit(parseUnifiedDiff('@@ -1 +1 @@\n-def foo():\n+def foo(x):\n'), 'py')).toBe(true);
    expect(exportScanHit(parseUnifiedDiff('@@ -1 +1 @@\n-    def inner():\n+    def inner(x):\n'), 'py')).toBe(false);
    expect(exportScanHit(parseUnifiedDiff('@@ -1 +1 @@\n-func (s *Server) Handle() {\n+func (s *Server) Handle(ctx Ctx) {\n'), 'go')).toBe(true);
    expect(exportScanHit(parseUnifiedDiff('@@ -1 +1 @@\n-func helper() {\n+func helper(x int) {\n'), 'go')).toBe(false);
    expect(exportScanHit(parseUnifiedDiff('@@ -1 +1 @@\n+const S = z.object({ a: z.string() })\n'), 'ts')).toBe(true);
  });

  it('produces a candidate with symbols, summary, hash and hunk', () => {
    const c = detectContract({ path: 'packages/contracts/src/billing.ts', diffText: billingDiff, config });
    expect(c).not.toBeNull();
    expect(c!.viaGlob).toBe(true);
    expect(c!.symbols).toEqual(['Invoice', 'createInvoice']);
    expect(c!.kinds).toEqual(expect.arrayContaining(['member', 'export']));
    expect(c!.summary).toContain('billing.ts:');
    expect(c!.summary).toContain('function createInvoice(input: InvoiceInput): Invoice → function createInvoice(input: InvoiceInput, currency: Currency): Invoice');
    expect(c!.summary).toContain('Invoice: -total, +amountDue, +currency');
    expect(c!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(c!.hunk.length).toBeLessThanOrEqual(1500);
  });

  it('returns null for empty diffs, comment-only hunks and non-contract edits', () => {
    expect(detectContract({ path: 'packages/contracts/src/billing.ts', diffText: '', config })).toBeNull();
    expect(detectContract({ path: 'packages/contracts/src/billing.ts', diffText: '@@ -1 +1 @@\n-// a\n+// b\n', config })).toBeNull();
    expect(detectContract({ path: 'apps/app/src/util.ts', diffText: '@@ -1 +1 @@ function helper() {\n-  return 1\n+  return 2\n', config })).toBeNull();
    const viaExport = detectContract({ path: 'apps/app/src/Button.tsx', diffText: '@@ -1 +1 @@\n-export function Button() {\n+export function Button(props: Props) {\n', config });
    expect(viaExport?.viaExport).toBe(true);
    expect(detectContract({ path: 'apps/app/src/Button.tsx', diffText: '@@ -1 +1 @@\n-export function Button() {\n+export function Button(props: Props) {\n', config: { ...config, contracts: { ...config.contracts, export_scan: false } } })).toBeNull();
  });
});

describe('symbols per file type', () => {
  it('detects languages', () => {
    expect(fileLang('a/b.tsx')).toBe('ts');
    expect(fileLang('a/b.mjs')).toBe('js');
    expect(fileLang('docs/openapi.v1.yaml')).toBe('openapi');
    expect(fileLang('db/migrations/001_init.sql')).toBe('sql');
    expect(fileLang('prisma/schema.prisma')).toBe('prisma');
    expect(fileLang('x.graphql')).toBe('graphql');
    expect(fileLang('x.proto')).toBe('proto');
    expect(fileLang('x.md')).toBe('other');
  });

  it('attributes prisma fields to the enclosing model via the hunk header', () => {
    const r = extractSymbols('prisma/schema.prisma', parseUnifiedDiff('@@ -20,0 +21,1 @@ model Invoice {\n+  currency String @default("USD")\n'));
    expect(r.symbols).toEqual(['Invoice']);
    expect(r.kinds).toEqual(['prisma']);
    expect(r.summary).toBe('schema.prisma: model Invoice +currency');
  });

  it('extracts graphql, proto, sql, openapi, python and go names', () => {
    expect(extractSymbols('s.graphql', parseUnifiedDiff('@@ -1 +1 @@\n-type Order { id: ID! }\n+type Order { id: ID!, status: String }\n')).symbols).toEqual(['Order']);
    expect(extractSymbols('s.graphql', parseUnifiedDiff('@@ -2,0 +3 @@ type Query {\n+  orders: [Order!]!\n')).symbols).toEqual(['Query']);
    expect(extractSymbols('s.proto', parseUnifiedDiff('@@ -1 +1 @@\n+message OrderFilter { string status = 1; }\n+service Orders { rpc List (OrderFilter) returns (OrderList); }\n')).symbols).toEqual(['OrderFilter', 'Orders']);
    expect(extractSymbols('db/migrations/0042.sql', parseUnifiedDiff('@@ -1 +1 @@\n+ALTER TABLE "invoices" ADD COLUMN currency text;\n+create table if not exists fx_rates (id int);\n')).symbols).toEqual(['invoices', 'fx_rates']);
    expect(extractSymbols('openapi.yaml', parseUnifiedDiff('@@ -10,0 +11,3 @@ paths:\n+  /invoices/{id}:\n+    get:\n+      summary: x\n')).symbols).toEqual(['/invoices/{id}', 'GET']);
    const py = extractSymbols('svc.py', parseUnifiedDiff('@@ -1 +1 @@\n-def create_invoice(input):\n+def create_invoice(input, currency):\n'));
    expect(py).toMatchObject({ symbols: ['create_invoice'], kinds: ['python'] });
    const go = extractSymbols('svc.go', parseUnifiedDiff('@@ -1 +1 @@\n-func CreateInvoice(in Input) Invoice {\n+func CreateInvoice(in Input, cur string) Invoice {\n'));
    expect(go.symbols).toEqual(['CreateInvoice']);
    expect(go.summary).toContain('→');
    expect(extractSymbols('notes.md', parseUnifiedDiff('@@ -1 +1 @@\n+hello\n'))).toEqual({ symbols: [], kinds: ['file'], summary: 'edited notes.md' });
  });

  it('flags zod and trpc surfaces', () => {
    const r = extractSymbols('packages/api/src/router.ts', parseUnifiedDiff('@@ -1 +1 @@\n-export const OrderInput = z.object({ id: z.string() })\n+export const OrderInput = z.object({ id: z.string(), status: z.string() })\n+export const orders = router({ list: publicProcedure.query(() => []) })\n'));
    expect(r.symbols).toEqual(['OrderInput', 'orders']);
    expect(r.kinds).toEqual(expect.arrayContaining(['export', 'zod', 'trpc']));
  });
});
