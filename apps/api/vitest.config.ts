import { defineConfig } from 'vitest/config';

// Per-package vitest config so `pnpm --filter <pkg> test` runs in isolation;
// the root vitest.config.ts lists this package as a project for `pnpm test`.
// Every test boots one or more in-memory PGlite instances (WASM), so files run
// one at a time with a generous timeout instead of racing the other packages.
export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
