// packages/renderer/src/pwa/register-sw.ts
//
// Registers the service worker that makes the hosted build load with no
// internet, and offers the reload when a new build is ready.
//
// The worker itself is generated at build time — `scripts/sw-template.js` +
// `scripts/generate-sw.mjs`, wired in as the `gen-service-worker` plugin in
// `vite.config.ts`. This module is only the page's half. Full picture:
// docs/tech/OFFLINE.md.
//
// Four gates before anything is registered, each for its own reason:
//
//  1. `import.meta.env.PROD` — a precache in dev would fight the dev server and
//     serve yesterday's bundle, which is the exact pain the `EASYDB_HMR`
//     machinery exists to avoid. This also makes the branch statically dead in
//     a dev build, so nothing here loads there.
//  2. `serviceWorker` in `navigator` — absent in some embedded webviews.
//  3. The page is `http:`/`https:` — the desktop build's own page is `file:`,
//     where a worker cannot register at all. The build-time gate in
//     `vite.config.ts` already skips emitting one for Electron; this is the
//     second, independent guard, the same shape as `util/file-link-guard.ts`'s
//     desktop stand-aside.
//  4. `?nosw=1` — the escape hatch. A service worker that shipped broken can
//     otherwise keep serving itself, so there has to be one URL that takes it
//     off the device. Named after `?safemode` (`plugin-host/safe-mode.ts`),
//     which exists for the same reason one layer up.
//
// The update policy is PROMPT, never silent takeover. See the update bar below.

import { isDirty } from '../chrome/dirty-guard.js';

/** Query parameter that unregisters the worker and drops its caches. */
const KILL_PARAM = 'nosw';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  if (new URLSearchParams(location.search).get(KILL_PARAM) === '1') {
    void uninstall();
    return;
  }

  // On `load`, not immediately: the worker's install fetches the whole
  // precache, and racing that against the app's own boot requests only makes
  // the first paint slower.
  globalThis.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        // BASE_URL is `/easydbaccess/` in the CI build and `/easydbaccess3/` in
        // a branch preview, so every deploy slot scopes itself with nothing to
        // configure — the same mechanism `plugin-host/plugin-catalog.ts` uses
        // to find its own catalog.
        scope: import.meta.env.BASE_URL,
        // Without this, `sw.js` itself can be served from the HTTP cache, which
        // pins a user to an old worker for up to 24 hours.
        updateViaCache: 'none',
      })
      .then(watchForUpdate)
      .catch((err: unknown) => {
        // Never fatal: the app works without a worker, it just needs the
        // network to load next time.
        // eslint-disable-next-line no-console
        console.warn('[pwa] service worker registration failed', err);
      });
  });
}

/** Take the worker and its caches off this device, then reload without the flag. */
async function uninstall(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('easydb-precache-')).map((n) => caches.delete(n)));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[pwa] uninstall failed', err);
  }
  const url = new URL(location.href);
  url.searchParams.delete(KILL_PARAM);
  location.replace(url.toString());
}

/**
 * Notice a new build and offer the reload.
 *
 * Three ways a waiting worker shows up, and all three have to be covered or the
 * user silently never sees the update: one was already waiting when this page
 * loaded; one finishes installing while the page is open; or another tab
 * activated it and this page's controller changed underneath us.
 */
function watchForUpdate(reg: ServiceWorkerRegistration): void {
  if (reg.waiting && navigator.serviceWorker.controller) offerReload(reg);

  reg.addEventListener('updatefound', () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // `controller` is null on the very first install — that is this build
      // being cached for the first time, not an update, and prompting for it
      // would be nonsense.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) offerReload(reg);
    });
  });
}

let reloading = false;

/**
 * The "a new version is ready" bar.
 *
 * Why a prompt and never `skipWaiting()` on install: this app lazy-imports
 * content-hashed chunks (charts, Leaflet, several dialogs) long after boot, so
 * a worker that took over a running page would hand it a cache that no longer
 * holds the hashes that page is about to ask for — and the old build is gone
 * from the origin too, because each deploy replaces the whole artifact. Opening
 * a map would then fail silently in a tab that looks fine. The page also owns
 * an exclusive OPFS SQLite session and may be holding unsaved changes. So the
 * user chooses the moment.
 *
 * Built from bare DOM in its own shadow root, like `dev/hmr-prompt.ts` and for
 * the same reason: the one thing this bar must survive is the app being in a
 * bad state, and a bar made of app parts would not be there to press.
 */
function offerReload(reg: ServiceWorkerRegistration): void {
  if (document.getElementById('easydb-update-bar')) return;

  const host = document.createElement('div');
  host.id = 'easydb-update-bar';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .bar {
      position: fixed;
      inset-block-end: 16px;
      inset-inline-end: 16px;
      z-index: 2147483647;
      display: flex;
      gap: 12px;
      align-items: center;
      max-width: min(420px, calc(100vw - 32px));
      padding: 10px 12px;
      border: 1px solid #3b82f6;
      border-radius: 8px;
      background: #1f2937;
      box-shadow: 0 6px 20px rgb(0 0 0 / 35%);
      color: #f9fafb;
      font: 13px/1.4 system-ui, sans-serif;
    }
    .text { flex: 1; min-width: 0; }
    .note { display: block; color: #fbbf24; font-size: 11px; }
    button {
      flex: none;
      padding: 5px 10px;
      border: 1px solid transparent;
      border-radius: 5px;
      font: inherit;
      cursor: pointer;
    }
    .reload { background: #3b82f6; color: white; font-weight: 600; }
    .later { border-color: #4b5563; background: transparent; color: #d1d5db; }
  `;

  const bar = document.createElement('div');
  bar.className = 'bar';

  const text = document.createElement('div');
  text.className = 'text';
  const label = document.createElement('strong');
  label.textContent = 'A new version is ready';
  text.append(label);
  if (isDirty()) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = 'You have unsaved changes — save them first.';
    text.append(note);
  }

  const reload = document.createElement('button');
  reload.className = 'reload';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => {
    reloading = true;
    // The new worker only takes over when told to, and the page reloads on the
    // `controllerchange` that follows — so the document that comes back is
    // served entirely by the new cache, never half by each.
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    // If there is no waiting worker (it activated between the prompt and the
    // click), a plain reload is already correct.
    if (!reg.waiting) location.reload();
  });

  const later = document.createElement('button');
  later.className = 'later';
  later.textContent = 'Later';
  later.title = 'Keep using this version. The update is already downloaded and applies on your next reload.';
  later.addEventListener('click', () => host.remove());

  bar.append(text, reload, later);
  root.append(style, bar);
  document.body.append(host);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
}
