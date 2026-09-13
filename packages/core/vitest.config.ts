import { defineConfig } from 'vitest/config';

// Per-package vitest config so `pnpm --filter <pkg> test` runs in isolation;
// the root vitest.config.ts lists this package as a project for `pnpm test`.
export default defineConfig({
  test: {
    passWithNoTests: true,
    // Tests that exercise the 300 ms git budget can trip on a loaded CI runner; retry only there.
    retry: process.env['CI'] ? 2 : 0,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
