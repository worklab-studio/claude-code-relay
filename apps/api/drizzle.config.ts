// drizzle-kit config for `pnpm db:push` against Neon (§3.1). Local PGlite is migrated
// programmatically at boot by src/db/migrate.ts.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? 'postgres://localhost/relay' },
});
