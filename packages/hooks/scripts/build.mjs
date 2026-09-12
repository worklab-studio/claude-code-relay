// Bundles packages/hooks/src/index.ts (+ @relay/core from source) into
// packages/plugin/dist/hook.mjs: ESM, node18, unminified (readable stack traces,
// BUILD-PLAN decision 12), zero external dependencies — only node:* imports may
// remain (§2.2). Run with `pnpm --filter @relay/hooks build`.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, '../../plugin/dist/hook.mjs');

await build({
  entryPoints: [resolve(here, '../src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    js: [
      '// Relay hook program (DESIGN.md §4): built by packages/hooks/scripts/build.mjs from',
      '// packages/hooks/src + packages/core/src. Invoked as `node hook.mjs <verb>` by',
      '// scripts/hook.sh with Claude Code hook JSON on stdin; every path exits 0.',
      '// Do not edit: regenerate with `pnpm --filter @relay/hooks build`.',
    ].join('\n'),
  },
});

// Guard: the bundle must stay zero-dependency (only node:* imports).
const text = readFileSync(outfile, 'utf8');
const bad = [...text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]).filter((s) => !s.startsWith('node:'));
if (bad.length) {
  console.error(`hook.mjs imports non-node modules: ${[...new Set(bad)].join(', ')}`);
  process.exit(1);
}
console.log(`hook.mjs: ${(text.length / 1024).toFixed(0)} KB`);
