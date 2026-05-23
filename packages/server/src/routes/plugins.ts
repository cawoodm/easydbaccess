import type { Hono } from 'hono';
import { log } from '../log.js';
import type { ServerDeps } from '../index.js';

/**
 * Optional plugin registry / proxy. Lets the host fetch a plugin .js by URL
 * through the backend (e.g. to bypass CORS or to host first-party plugins).
 *
 *   GET /plugins/proxy?url=...   — fetches and returns the JS body with
 *                                  text/javascript content type
 *   GET /plugins/registry        — returns a curated list of known plugins
 */
export function mountPlugins(app: Hono, _deps: ServerDeps) {
  app.get('/plugins/registry', (c) => {
    log('plugins', 'registry');
    return c.json({
      plugins: [],
      todo: 'curated plugin list',
    });
  });
}
