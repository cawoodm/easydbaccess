import type { HostApi, PluginModule } from '@easydb/shared';

/**
 * Loads third-party plugins by URL.
 *
 * The URL list lives on Workspace.pluginUrls so it syncs across devices.
 * For each URL we:
 *   1. Look up the matching record in the `plugins` RxDB collection (URL
 *      is the primary key) so we can read the cached body, enabled state,
 *      and last error.
 *   2. If `enabled === false`, skip.
 *   3. Otherwise fetch the URL (network) and store the response body in
 *      cachedBody. If the network fetch fails AND we have a cached body
 *      from a previous successful fetch, fall back to that — keeps the
 *      plugin working offline.
 *   4. Wrap the JS body in a Blob URL and dynamic-import it. Dynamic
 *      import of an arbitrary fetched body without going through Blob
 *      URLs is blocked by CSP in many environments; the Blob approach
 *      lets the imported module register a stable URL with the runtime.
 *   5. Call plugin.init(api). The returned object is held so the caller
 *      can then drive plugin.load(api) once the app is ready, matching
 *      the same lifecycle as the built-in plugins.
 *
 * Errors are caught at every step and recorded on the plugin row
 * (lastError) so the Plugin Manager dialog can surface them. The host
 * never aborts boot because of a single plugin failure.
 */
export async function loadUrlPlugins(api: HostApi): Promise<() => Promise<void>> {
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
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        body = await res.text();
      } catch (fetchErr) {
        if (!body) {
          await api.store.plugins.upsert({
            url,
            enabled: rec?.enabled ?? true,
            lastFetched: Date.now(),
            lastError: `fetch: ${(fetchErr as Error).message}`,
          });
          api.events.emit('plugin:error', {
            url,
            phase: 'fetch',
            error: fetchErr,
          });
          continue;
        }
        // Fell through to cached body — log a warning toast.
        api.ui.dialogs.toast(`Using cached plugin (offline): ${url}`, { kind: 'warning' });
      }

      await api.store.plugins.upsert({
        url,
        enabled: true,
        lastFetched: Date.now(),
        cachedBody: body,
      });

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
