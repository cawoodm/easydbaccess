import { readFile } from 'node:fs/promises';
import type { Hono } from 'hono';
import { log } from '../log.js';
import type { ServerDeps } from '../index.js';

/**
 * Plugin registry endpoint. The renderer's Plugin Manager dialog renders the
 * returned list under a "From server" section so an operator can curate a
 * shared set of plugins without rebuilding the static catalog.
 *
 *   GET /plugins/registry
 *
 * Behavior:
 * - `PLUGINS_REGISTRY_PATH` unset → { plugins: [], note: '...' }
 * - File exists + valid JSON with `plugins` array → returns that JSON verbatim
 * - File missing at the configured path → empty list with a note (200, not
 *   500 — the renderer treats this as "nothing curated yet" rather than a
 *   hard failure)
 * - File exists but invalid JSON or missing the `plugins` array → 500 with
 *   the parse error so operators notice the misconfiguration
 *
 * The file is re-read on every request. JSON files for plugin lists are
 * small and operators may edit them without restarting the server.
 */
export function mountPlugins(app: Hono, deps: ServerDeps) {
  app.get('/plugins/registry', async (c) => {
    const path = deps.pluginsRegistryPath;
    if (!path) {
      log('plugins', 'registry unset');
      return c.json({ plugins: [], note: 'PLUGINS_REGISTRY_PATH is not configured' });
    }
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log('plugins', 'registry missing', { path });
        return c.json({
          plugins: [],
          note: `registry file not found at ${path}`,
        });
      }
      log('plugins', 'registry read-error', { path, error: (err as Error).message });
      return c.json({ error: (err as Error).message }, 500);
    }
    let parsed: { plugins?: unknown };
    try {
      parsed = JSON.parse(text) as { plugins?: unknown };
    } catch (err) {
      log('plugins', 'registry parse-error', { path, error: (err as Error).message });
      return c.json({ error: `invalid JSON in registry: ${(err as Error).message}` }, 500);
    }
    if (!Array.isArray(parsed.plugins)) {
      log('plugins', 'registry shape-error', { path });
      return c.json({ error: 'registry JSON must contain a `plugins` array' }, 500);
    }
    log('plugins', 'registry', { path, count: parsed.plugins.length });
    return c.json(parsed);
  });
}
