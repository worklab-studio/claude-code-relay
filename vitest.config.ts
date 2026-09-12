import { defineConfig } from 'vitest/config';

// Root runner: `pnpm test` runs every workspace package as a vitest project.
// Each package also has its own `test` script (`vitest run --passWithNoTests`).
export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/hooks', 'packages/mcp', 'apps/api'],
    passWithNoTests: true,
  },
});
