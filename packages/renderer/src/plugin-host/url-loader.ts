import type { HostApi, PluginModule } from '@easydb/shared';
import { SAFE_MODE } from './safe-mode.js';

/**
 * Loads third-party plugins by URL.
 *
 * The URL list lives on Workspace.pluginUrls so it syncs across devices.
 * After install, each plugin's body is cached on its row in the `plugins`
 * collection (keyed by URL). Subsequent boots load from that cache —
 * NO synchronous network fetch — so the app boots fast and stays working
 * even when upstream URLs go offline (e.g. a previously-installed catalog
 * URL that the host removed in a later release).
 *
 * For each URL:
 *   1. Look up the matching record.
 *   2. If `enabled === false`, skip.
 *   3. If `cachedBody` is present (the normal case), use it directly and
 *      kick off a non-blocking background refresh so the cache updates
 *      for the next boot. Failures there are swallowed — they never affect
 *      the current boot.
 *   4. If `cachedBody` is absent (first boot after a manual addPlugin,
 *      or the cache row was lost), fetch synchronously and persist.
 *   5. Wrap the body in a Blob URL and dynamic-import it. Dynamic-import
 *      of a raw fetched body without going through Blob URLs is blocked
 *      by CSP in many environments; the Blob approach lets the imported
 *      module register a stable URL with the runtime.
 *   6. Call plugin.init(api). The returned object is held so the caller
 *      can drive plugin.load(api) once the shell is ready, matching the
 *      built-in lifecycle.
 *
 * Errors are caught at every step and recorded on the plugin row
 * (`lastError`) so the Plugin Manager dialog can surface them. The host
 * never aborts boot because of a single plugin failure.
 */
export async function loadUrlPlugins(api: HostApi): Promise<() => Promise<void>> {
  // ?safemode / ?safemode1: skip URL plugins entirely for this boot. Transient
  // only — no plugins-collection writes, so nothing is persisted. See
  // safe-mode.ts.
  if (SAFE_MODE === 'url-plugins' || SAFE_MODE === 'all-optional') {
    return async () => undefined;
  }

  const workspaceId = api.workspaceId();
  if (!workspaceId) return async () => undefined;
  const ws = await api.store.workspaces.findOne(workspaceId);
  const urls = ws?.pluginUrls ?? [];
  const loaded: Array<{ url: string; mod: PluginModule }> = [];

  for (const url of urls) {
    try {
      const rec = await api.store.plugins.findOne(url);
      if (rec && rec.enabled === false) continue;

      let body = rec?.cachedBody ?? '';

      if (body) {
        // Already cached — use it now, refresh in the background for next boot.
        void backgroundRefresh(api, url, body);
      } else {
        // First boot for this URL: fetch synchronously.
        try {
          body = await fetchPluginBody(url);
        } catch (fetchErr) {
          await api.store.plugins.upsert({
            url,
            enabled: rec?.enabled ?? true,
            lastFetched: Date.now(),
            lastError: `fetch: ${(fetchErr as Error).message}`,
          });
          api.events.emit('plugin:error', { url, phase: 'fetch', error: fetchErr });
          continue;
        }
        await api.store.plugins.upsert({
          url,
          enabled: true,
          lastFetched: Date.now(),
          cachedBody: body,
        });
      }

      const blob = new Blob([body], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        // /* @vite-ignore */ — Vite tries to resolve dynamic imports at build
        // time; for a runtime blob URL we want it to leave the expression
        // alone.
        const mod = (await import(/* @vite-ignore */ blobUrl)) as PluginModule;
        await mod.init?.(api);
        loaded.push({ url, mod });
      } finally {
        // Defer revocation so the imported module's source map still resolves
        // if the browser opens devtools shortly after.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }
    } catch (err) {
      await api.store.plugins.upsert({
        url,
        enabled: true,
        lastFetched: Date.now(),
        lastError: `init: ${(err as Error).message}`,
      });
      api.events.emit('plugin:error', { url, phase: 'init', error: err });
    }
  }

  return async () => {
    for (const { url, mod } of loaded) {
      try {
        await mod.load?.(api);
      } catch (err) {
        await api.store.plugins.upsert({
          url,
          enabled: true,
          lastFetched: Date.now(),
          lastError: `load: ${(err as Error).message}`,
        });
        api.events.emit('plugin:error', { url, phase: 'load', error: err });
      }
    }
  };
}

/**
 * Fetches a plugin URL and returns its body. Rejects on non-OK responses
 * AND when the response looks like HTML (sniffed via content-type + body
 * prefix) — dev servers and many static hosts return 200 + index.html for
 * unknown paths, which would otherwise dynamic-import as JS and throw a
 * confusing SyntaxError ("Unexpected token '<'").
 */
async function fetchPluginBody(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/html') || /^\s*<(!doctype|html|head|body)/i.test(body)) {
    throw new Error('response is HTML, not a JS module (URL likely 404 → SPA fallback)');
  }
  return body;
}

/**
 * Non-blocking refresh: re-fetch a plugin's URL and update its cached body
 * if the upstream version differs. Failures are intentionally swallowed —
 * the current boot already loaded successfully from cache, and a stale or
 * unreachable upstream shouldn't surface a user-facing error every boot.
 * The Plugin Manager can still trigger an explicit re-install for upgrades.
 */
function backgroundRefresh(api: HostApi, url: string, currentBody: string): Promise<void> {
  return (async () => {
    try {
      const fresh = await fetchPluginBody(url);
      if (fresh === currentBody) return;
      await api.store.plugins.upsert({
        url,
        enabled: true,
        lastFetched: Date.now(),
        cachedBody: fresh,
      });
    } catch {
      // Stale/unreachable upstream — keep the cached body silently.
    }
  })();
}
