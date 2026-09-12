/**
 * Demo seed (§12 M0): identities priya (app) and arjun (dashboard) for project
 * acme-portal / repo demo/app, matching examples/demo-repo/.relay.json. Idempotent.
 */
import { eq } from 'drizzle-orm';
import type { RelayConfig } from '@relay/core';
import { devs } from './db/schema.js';
import { upsertRepo, type Hub } from './hub.js';

export const DEMO_REPO_SLUG = 'demo/app';
export const DEMO_PROJECT = 'acme-portal';

export const DEMO_CONFIG: RelayConfig = {
  project: DEMO_PROJECT,
  repo: DEMO_REPO_SLUG,
  areas: {
    app: { paths: ['apps/app/**'], owners: ['priya'] },
    dashboard: { paths: ['apps/dashboard/**'], owners: ['arjun'] },
    contracts: { paths: ['packages/contracts/**', 'prisma/**'], shared: true },
  },
  contracts: { packages: ['@acme/contracts'], export_scan: true },
  depends: { dashboard: ['contracts'], app: ['contracts'] },
  impacts: { debounce_minutes: 3 },
};

export const DEMO_DEVS: Array<{ handle: string; name: string; emails: string[] }> = [
  { handle: 'priya', name: 'Priya', emails: ['priya@demo'] },
  { handle: 'arjun', name: 'Arjun', emails: ['arjun@demo'] },
];

export async function seedDemo(hub: Hub): Promise<void> {
  for (const d of DEMO_DEVS) {
    const row = await hub.devByHandle(d.handle, true);
    if (!row) continue;
    const emails = [...new Set([...row.emails, ...d.emails])];
    if (row.name !== d.name || emails.length !== row.emails.length) {
      await hub.db.update(devs).set({ name: d.name, emails }).where(eq(devs.id, row.id));
      hub.cache.devs.delete(d.handle);
    }
  }
  const existing = await hub.repoBySlug(DEMO_REPO_SLUG);
  if (!existing) {
    await upsertRepo(hub, DEMO_REPO_SLUG, { project: DEMO_PROJECT, config: DEMO_CONFIG, configHash: 'seed' });
  }
}
