import { defineConfig } from 'vitest/config';

// Per-package vitest config so `pnpm --filter <pkg> test` runs in isolation;
// the root vitest.config.ts lists this package as a project for `pnpm test`.
export default defineConfig({
  test: {
    passWithNoTests: true,
    // The verb tests spawn real git and the integration test spawns the bundle; running the
    // files one at a time keeps the design's 300 ms rev-parse timeouts from tripping under load.
    fileParallelism: false,
    // Wall-time assertions (hook deadlines) can trip on a loaded CI runner; retry only there.
    retry: process.env['CI'] ? 2 : 0,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
