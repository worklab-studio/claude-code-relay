import { defineConfig } from 'vitest/config';

// Per-package vitest config so `pnpm --filter <pkg> test` runs in isolation;
// the root vitest.config.ts lists this package as a project for `pnpm test`.
export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
