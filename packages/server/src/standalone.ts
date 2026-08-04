import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createServer } from './index.js';
import { createStoreFromEnv } from './storage/factory.js';

// Load .env from the package root before anything reads process.env.
// Resolution is relative to this file so it works for both `tsx watch src/…`
// (dev) and `node dist/…` (built) — package root is one level up from either.
// process.loadEnvFile is built into Node 20.12+ / 21.7+, no dotenv dependency.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
  // eslint-disable-next-line no-console
  console.log(`loaded env from ${envPath}`);
}

const port = Number(process.env.PORT ?? 3000);

const store = createStoreFromEnv(process.env);

const corsRaw = process.env.CORS_ORIGINS?.trim();
const corsOrigins: '*' | string[] | undefined =
  corsRaw === undefined || corsRaw === ''
    ? '*'
    : corsRaw === '*'
      ? '*'
      : corsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

const app = createServer({
  store,
  fetchFn: globalThis.fetch,
  fetchAllowlist: process.env.FETCH_ALLOWLIST?.split(',').map((s) => s.trim()),
  fetchMaxBytes: Number(process.env.FETCH_MAX_BYTES ?? 5_000_000),
  corsOrigins,
  pluginsRegistryPath: process.env.PLUGINS_REGISTRY_PATH,
});

const server = serve({ fetch: app.fetch, port }, ({ port: p }) => {
  // eslint-disable-next-line no-console
  console.log(`easydb server listening on http://localhost:${p}`);
  // eslint-disable-next-line no-console
  console.log(`storage: ${process.env.STORAGE_KIND ?? 'fs'} @ ${process.env.STORAGE_PATH}`);
});

const shutdown = async () => {
  await store.close?.();
  server.close();
};
process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
