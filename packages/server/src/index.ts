import { Hono } from 'hono';
import { mountReplicate } from './routes/replicate.js';
import { mountFetch } from './routes/fetch.js';
import { mountPlugins } from './routes/plugins.js';

/**
 * Anything the server needs that varies by environment lives behind these
 * factories so the same code can run inside Electron's main process and as
 * a standalone Node service.
 */
export interface ServerDeps {
  /** RxDB-style storage handle. Real type lives in @easydb/shared once the storage abstraction is wired. */
  storage: unknown;
  /** Outbound fetch function. In Electron the main process can use globalThis.fetch directly. */
  fetchFn: typeof fetch;
  /** Optional list of allowed origins for the /fetch proxy. Empty/undefined = allow all (electron-only default). */
  fetchAllowlist?: string[] | undefined;
  /** Max bytes the /fetch proxy will return. */
  fetchMaxBytes?: number | undefined;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, version: '0.0.0' }));

  mountReplicate(app, deps);
  mountFetch(app, deps);
  mountPlugins(app, deps);

  return app;
}

export type AppType = ReturnType<typeof createServer>;
