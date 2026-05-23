import type { Hono } from 'hono';
import { log } from '../log.js';
import type { ServerDeps } from '../index.js';

/**
 * URL proxy so plugins can ingest data from CORS-blocked APIs in browser mode.
 * In Electron the renderer can call this too; main process owns the actual fetch.
 *
 * Body: { url: string, method?: string, headers?: Record<string,string>, body?: string }
 */
export function mountFetch(app: Hono, deps: ServerDeps) {
  app.post('/fetch', async (c) => {
    const { url, method = 'GET', headers = {}, body } = await c.req.json<{
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }>();

    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      log('fetch', 'reject invalid-url', { url: String(url) });
      return c.json({ error: 'invalid url' }, 400);
    }

    if (deps.fetchAllowlist && deps.fetchAllowlist.length > 0) {
      const host = new URL(url).host;
      if (!deps.fetchAllowlist.some((pat) => host === pat || host.endsWith(`.${pat}`))) {
        log('fetch', 'reject not-in-allowlist', { host });
        return c.json({ error: 'host not in allowlist' }, 403);
      }
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    log('fetch', 'proxy', { method, url });
    const res = await deps.fetchFn(url, init);
    const max = deps.fetchMaxBytes ?? 5_000_000;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > max) {
      log('fetch', 'response too-large', { url, bytes: buf.byteLength, max });
      return c.json({ error: 'response too large', max }, 413);
    }
    log('fetch', 'response', { url, status: res.status, bytes: buf.byteLength });

    return new Response(buf, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
      },
    });
  });
}
