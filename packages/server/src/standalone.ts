import { serve } from '@hono/node-server';
import { createServer } from './index.js';

const port = Number(process.env.PORT ?? 3000);

const app = createServer({
  storage: null, // placeholder until storage layer lands
  fetchFn: globalThis.fetch,
  fetchAllowlist: process.env.FETCH_ALLOWLIST?.split(',').map((s) => s.trim()),
  fetchMaxBytes: Number(process.env.FETCH_MAX_BYTES ?? 5_000_000),
});

serve({ fetch: app.fetch, port }, ({ port: p }) => {
  // eslint-disable-next-line no-console
  console.log(`easydb server listening on http://localhost:${p}`);
});
