// Relay hub (DESIGN.md §2.3, §10): the Hono app factory and the process-level hub.
// The Vercel entry lives at api/[[...route]].ts, the local dev server at scripts/dev.ts.
export { createApp } from './app.js';
export { createHub, getProcessHub, type Hub, type HubOptions } from './hub.js';
export { createDb, type Db, type DbHandle } from './db/client.js';
export { migrate } from './db/migrate.js';
export { seedDemo } from './seed.js';
