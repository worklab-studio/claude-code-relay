/**
 * Vercel entry (§2.3): hono/vercel `handle()` over the process-level hub.
 * The hub (DB client + migrations) is built once per instance and awaited per request.
 */
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { createApp } from '../src/app.js';
import { getProcessHub } from '../src/hub.js';

const appPromise = getProcessHub().then((hub) => createApp(hub));

const outer = new Hono();
outer.all('*', async (c) => {
  const app = await appPromise;
  return app.fetch(c.req.raw);
});

export default handle(outer);
