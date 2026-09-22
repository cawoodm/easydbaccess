import type { HostApi, PluginModule } from '@easydb/shared';
import { fetchWithTimeout, isNetworkFailure, isOffline } from '../util/net.js';
import { SAFE_MODE } from './safe-mode.js';

/**
 * How long the whole uncached phase may take, across every plugin.
 *
 * `app-context.ts` awaits this loader on the critical boot path, so anything
 * that hangs here hangs the app: no tables, no error, no way out. A per-request
 * timeout alone is not enough — ten unreachable plugins would still cost ten
 * timeouts in series. One budget for the lot bounds the worst case.
 */
const BOOT_FETCH_BUDGET_MS = 10_000;

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

  // One deadline for every blocking fetch below — see BOOT_FETCH_BUDGET_MS.
  const budget = AbortSignal.timeout(BOOT_FETCH_BUDGET_MS);

  for (const url of urls) {
    try {
      const rec = await api.store.plugins.findOne(url);
      if (rec && rec.enabled === false) continue;

      let body = rec?.cachedBody ?? '';

      if (body) {
        // Already cached — use it now, refresh in the background for next boot.
        void backgroundRefresh(api, url, body);
      } else {
        // First boot for this URL: fetch synchronously. This is the ONLY path
        // the network can delay — a plugin with a `cachedBody` (the normal
        // case, above) already boots offline with no request at all.
        try {
          // Certainly offline, or the budget is already spent: fail this one
          // now rather than wait for a request that cannot succeed.
          if (isOffline()) throw new TypeError('offline');
          if (budget.aborted) throw budget.reason ?? new Error('boot fetch budget exhausted');
          body = await fetchPluginBody(url, budget);
        } catch (fetchErr) {
          await api.store.plugins.upsert({
            url,
            enabled: rec?.enabled ?? true,
            lastFetched: Date.now(),
            lastError: `fetch: ${(fetchErr as Error).message}`,
          });
          // A network failure at boot is not a plugin fault and must not toast:
          // offline, every uncached plugin fails at once, and the user would
          // get one error per plugin for a condition they already know about.
          // The `lastError` above still records it, and the Plugin Manager —
          // which is where you go to ask why a plugin is missing — still shows
          // it. A 404, bad JS or a throwing `init()` still toasts.
          if (!isNetworkFailure(fetchErr)) {
            api.events.emit('plugin:error', { url, phase: 'fetch', error: fetchErr });
          }
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
 * Fetches a plugin URL and returns its body.
 *
 * Bounded by `fetchWithTimeout` (and, at boot, by the caller's shared budget
 * signal), because a request that never settles is what wedges the whole app.
 *
 * Rejects on non-OK responses AND when the response looks like HTML (sniffed via content-type + body
 * prefix) — dev servers and many static hosts return 200 + index.html for
 * unknown paths, which would otherwise dynamic-import as JS and throw a
 * confusing SyntaxError ("Unexpected token '<'").
 */
async function fetchPluginBody(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchWithTimeout(url, signal ? { signal } : {});
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
    if (isOffline()) return; // nothing to refresh from, and the cache is already serving
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
