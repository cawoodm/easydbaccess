import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { log } from './log.js';
import { mountFetch } from './routes/fetch.js';
import { mountPlugins } from './routes/plugins.js';
import { mountSync } from './routes/sync.js';
import type { StoreAdapter } from './storage/types.js';

export type { StoreAdapter } from './storage/types.js';

/**
 * Anything the server needs that varies by environment lives behind these
 * factories so the same code can run inside Electron's main process and as
 * a standalone Node service.
 */
export interface ServerDeps {
  /** Whole-workspace blob store. See storage/types.ts. */
  store: StoreAdapter;
  /** Outbound fetch function. In Electron the main process can use globalThis.fetch directly. */
  fetchFn: typeof fetch;
  /** Optional list of allowed origins for the /fetch proxy. Empty/undefined = allow all (electron-only default). */
  fetchAllowlist?: string[] | undefined;
  /** Max bytes the /fetch proxy will return. */
  fetchMaxBytes?: number | undefined;
  /**
   * Allowed origins for browser CORS. Pass '*' to allow any (dev default).
   * Pass a list of explicit origins for production deployments.
   * Pass an empty list to disable CORS entirely (Electron / same-origin).
   */
  corsOrigins?: '*' | string[] | undefined;
}

export function createServer(deps: ServerDeps) {
  const app = new Hono();

  // Request/response line per call: `<-- GET /path` and `--> GET /path 200 5ms`.
  // Set EASYDB_LOG=quiet to disable (e.g. inside test runs).
  if (process.env.EASYDB_LOG !== 'quiet') {
    app.use(
      '*',
      logger((msg) => log('http', msg)),
    );
  }

  const origins = deps.corsOrigins ?? '*';
  if (origins !== undefined && (origins === '*' || origins.length > 0)) {
    app.use(
      '*',
      cors({
        origin: origins === '*' ? (o) => o ?? '*' : (o) => (origins.includes(o) ? o : null),
        allowMethods: ['GET', 'PUT', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'If-Match'],
        exposeHeaders: ['ETag'],
      }),
    );
  }

  app.get('/health', (c) => c.json({ ok: true, version: '0.0.3S' }));

  mountSync(app, { store: deps.store });
  mountFetch(app, deps);
  mountPlugins(app, deps);

  return app;
}

export type AppType = ReturnType<typeof createServer>;
