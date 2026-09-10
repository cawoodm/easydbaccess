/* eslint-disable */
// scripts/sw-template.js — SOURCE of the service worker, not the shipped file.
//
// `scripts/generate-sw.mjs` reads this at build time, substitutes the two
// placeholders below and writes the result to `dist/sw.js`. Keeping the worker
// as a real file (rather than a template literal inside the generator) is what
// makes it readable in a diff, greppable, and editable without escaping.
//
//   __CACHE_NAME__  a string literal, e.g. "easydb-precache-v0.0.461-a1b2c3d4"
//   __PRECACHE__    a JSON array of scope-absolute PATHS, e.g.
//                   ["/easydbaccess/index.html", "/easydbaccess/assets/index-ab12.js"]
//                   Paths, not full URLs, because the origin is not known at
//                   build time — the same `dist/` is served from localhost in
//                   the preview and from cawoodm.github.io in production.
//
// Design notes that are load-bearing — see docs/tech/OFFLINE.md for the why:
//
//  * NO `skipWaiting()`, NO `clients.claim()`. The app lazy-imports chunks by
//    content-hashed name (charts, Leaflet, several dialogs) long after boot. A
//    worker that took over a running page would serve it a cache that no longer
//    holds the hashes that page is about to ask for, over a live OPFS database
//    with unsaved changes. The page asks the user to reload instead.
//  * Cross-origin requests are never intercepted. Map tiles, the GitHub Gist
//    API, the sync server and remote plugin URLs must keep failing honestly.
//  * Non-GET is never intercepted.
//  * Any unexpected error falls through to the network, so a bug in here
//    degrades to "no service worker" and never to a bricked app.

const CACHE = __CACHE_NAME__;
const PRECACHE = __PRECACHE__;

/** The document every navigation resolves to — this is a single-page app. */
const SHELL = new URL('index.html', self.registration.scope).toString();

/** Fast membership test for the cache-first branch. */
const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  // No skipWaiting: a new worker waits until every tab running the old build
  // has gone, or until the page explicitly tells it to take over.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload` bypasses the HTTP cache, so a precache entry can never be
      // populated from a stale intermediary copy.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('easydb-precache-') && n !== CACHE).map((n) => caches.delete(n)));
    })(),
  );
});

// The page's "Update available — Reload" button answers here. Only then does
// this worker take over, and only because the page is about to reload anyway.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // A navigation is always the shell. Match the shell URL rather than the
  // request, because `?space=notes`, `?test=1` and `?safemode` all address the
  // same document and matching on the request would miss every one of them.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const hit = await caches.match(SHELL);
          if (hit) return hit;
        } catch {
          /* fall through to the network */
        }
        return fetch(request);
      })(),
    );
    return;
  }

  // Everything under `assets/` carries a content hash, so the URL IS the
  // version: a cache hit can never be stale, and revalidating it is wasted
  // work. Anything not precached (sourcemaps, the dead .woff copies) is left
  // to the network exactly as before. Compared by path — see __PRECACHE__.
  if (!PRECACHED.has(url.pathname)) return;

  event.respondWith(
    (async () => {
      try {
        const hit = await caches.match(url.pathname);
        if (hit) return hit;
      } catch {
        /* fall through to the network */
      }
      return fetch(request);
    })(),
  );
});
