# Offline

The hosted browser build is a PWA. Open
`https://cawoodm.github.io/easydbaccess/` once with a connection and it keeps
working with none: it loads from its own cache, opens the workspace out of OPFS,
and reads and writes rows exactly as before.

The desktop build was always offline — its page is `file:` and its database is a
file on disk. Nothing here applies to it, and two independent guards keep the
service worker out of it.

## Two halves

**Loading with no network** is the service worker. Without one, a reload with no
connection fails before any app code runs, however local the data is.

**Behaving with no network** is everything else: no request may hang, no failure
may be reported as "Failed to fetch", and nothing may keep doing expensive work
for a request that cannot succeed.

Both were missing. The data layer was already local-first.

## The service worker

| File                            | Role                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/sw-template.js`        | The worker's source. Two placeholders: `__CACHE_NAME__`, `__PRECACHE__`.             |
| `scripts/generate-sw.mjs`       | Decides what to precache, stamps the cache name, writes `dist/sw.js`.                |
| `vite.config.ts`                | The `gen-service-worker` plugin that runs the generator.                             |
| `src/pwa/register-sw.ts`        | The page's half: registration, the update prompt, the kill switch.                   |
| `public/manifest.webmanifest`   | Makes the app installable.                                                           |

### Why hand-rolled and not `vite-plugin-pwa`

Every asset Vite emits already carries a content hash. The only unhashed files —
`index.html`, the manifest, the favicon, `plugins/*` — are rewritten on every
deploy. So a per-deploy cache name is a complete revisioning scheme, and
revisioning is the hard thing Workbox exists to do. What is left is about 100
lines of readable JS, in the same shape as `generate-plugin-catalog.mjs` and
`generate-tips.mjs`, against a dependency tree with its own bundler in it.

### What is cached, and what is not

| Request                                  | Behaviour                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Navigation (any query string)            | Serve the cached `index.html`, network as fallback                              |
| Same-origin GET listed in the precache   | Cache-first, no revalidation — the URL carries a content hash, so it is the version |
| Same-origin GET not in the precache      | Untouched. Sourcemaps and the dead `.woff` copies stay network-only              |
| Cross-origin                             | Never intercepted                                                               |
| Non-GET                                  | Never intercepted                                                               |

The precache is the whole app: `index.html`, every `assets/*` chunk and
stylesheet (including the lazily-imported charts, Leaflet and dialogs), the
sqlite-wasm `.wasm`, the Material Icons `.woff2` files, the manifest, the favicon
and `plugins/*`. It excludes `*.map` (devtools-only, roughly two thirds of
`dist/` by size) and `*.woff` (every `@font-face` lists `woff2` first, so the
`.woff` copies are never requested).

Cross-origin is deliberate. Map tiles, the GitHub Gist API, the sync server and
remote plugin URLs must keep failing honestly — caching opaque responses is
unbounded against a storage quota shared with the OPFS database, which is the one
thing that must never be evicted.

### Updates: prompt, never silent

The worker never calls `skipWaiting()` on install and never calls
`clients.claim()`. A new build downloads in the background and waits; the page
shows a small "A new version is ready" bar and the user picks the moment.

This is not caution for its own sake. The app lazy-imports content-hashed chunks
long after boot — charts, Leaflet, the export dialog and several others. A worker
that took over a running page would hand it a cache that no longer holds the
hashes that page is about to ask for, and the origin no longer serves them either
because each deploy replaces the whole artifact. Opening a map would then fail
silently in a tab that looks fine. On top of that the page owns an exclusive
`opfs-sahpool` SQLite session and may be holding unsaved changes.

The cost is that a user who never reloads stays one version behind. That is
strictly better than half a bundle over a live database.

### Base paths

Nothing is configured per deploy slot:

- Manifest members resolve against the **manifest's** URL, so `"scope": "./"` is
  correct at `/easydbaccess/`, at a `/easydbaccess3/` branch preview and at the
  root alike.
- `id` is deliberately absent from the manifest. `id` resolves against the
  **origin**, so a literal `"./"` would collide across every slot on
  `cawoodm.github.io`. Omitted, it defaults to `start_url`, which is
  manifest-relative — each slot gets its own app identity for free.
- The precache entries and the registration scope both come from Vite's `base`
  (`import.meta.env.BASE_URL` on the page).

### When there is no worker

- **Dev.** `apply: 'build'` in the Vite plugin, and `import.meta.env.PROD` in
  `register-sw.ts`. A precache would serve yesterday's bundle — the exact pain
  the `EASYDB_HMR` machinery exists to avoid.
- **Electron.** The generator bails when `base` is `./` (that is
  `build:electron`), and the page bails when `location.protocol` is not
  `http:`/`https:`. A worker cannot register under `file:` anyway.

### `?nosw=1` — the escape hatch

A service worker that shipped broken can keep serving itself. `?nosw=1`
unregisters every worker, deletes every `easydb-precache-*` cache and reloads
without the flag. Same idea as `?safemode` one layer up.

## Behaving with no network

`packages/renderer/src/util/net.ts` is the single place that answers "the network
did not work, now what". Three rules, in order of how much they matter.

**1. A timeout is the guarantee.** A bare `fetch` never gives up. `app-context.ts`
awaits `loadUrlPlugins` on the critical boot path and every chrome component
awaits `getContext()`, so one request that never settled — a captive portal, a
black-holed DNS — left an empty shell with no tables, no error and no way out.
Every bounded request goes through `fetchWithTimeout` (8s default). The uncached
plugin phase additionally shares **one 10s budget** across all plugins, so ten
unreachable URLs cost ten seconds, not ten timeouts in series.

Deliberately exempt: `api.backend.fetch`. Imports pull multi-hundred-megabyte
files through it, and a blanket deadline would break them. Its callers own their
own deadlines — as `plugins/server-sync.ts` and `plugins/auto-sync.ts` do, both
of which raise the limit for a request carrying a whole workspace.

**2. `navigator.onLine` is only a hint.** `true` means there is a network
interface, not that the internet is reachable. `isOffline()` may skip work that
certainly cannot succeed and may improve a message; it is never the only
protection. `false`, on the other hand, is reliable.

**3. Say "offline", not "Failed to fetch".** `describeNetworkError` is the one
wording, so the user reads one explanation rather than the browser's.

### What each place does

| Place                                | Offline behaviour                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `plugin-host/url-loader.ts`          | A cached plugin body loads with no request at all. An uncached one fails inside the shared budget, records `lastError`, and does **not** toast — a 404 or broken JS still does |
| `plugin-host/plugin-catalog.ts`      | Bounded; `new-plugins` already swallows the failure                                            |
| `plugins/auto-sync.ts`               | Skips the whole tick, before serializing the workspace                                         |
| `plugins/server-sync.ts`             | Says so **before** the destructive pull confirm, not after it                                  |
| `dialogs/plugin-manager-dialog.ts`   | Inline "Catalog unavailable" line, worded for offline                                          |
| `import/fetch-source.ts`, `plugins/url-source.ts` | Lead with the offline fact instead of guessing at CORS               |
| `viz/elements/point-map.ts`          | Points still plot; the tile banner says the background needs a connection                      |
| `chrome/app-shell.ts`                | A `cloud_off` chip in the header                                                               |

The chip is what makes the rest coherent: once the chrome says offline, a failed
sync or a blank map tile needs no further explanation of its own.

## Deliberately not done

- **A map-tile cache.** Third-party raster tiles are opaque responses: unbounded,
  unmeasurable against a quota shared with the OPFS database, and needing an LRU
  the worker otherwise does not. The tile-error banner and the repointable tile
  URL setting already answer the air-gapped case.
- **Background Sync for `auto-sync`.** Chromium-only, needs a persisted outbox,
  and the ETag conflict protocol assumes a live prompt.
- **PNG and maskable icons.** The manifest ships SVG-only, which Chromium accepts
  as installable. What that costs: no maskable icon on Android, and iOS ignores
  manifest icons entirely (it wants an `apple-touch-icon` PNG). Adding a
  rasterizer dependency for four files that change roughly never is not worth it
  — export them by hand from `favicon.svg` when someone wants them.

## Verifying

Unit and e2e:

```bash
npm run typecheck
npm run test                                   # incl. test/renderer/util/net.test.ts,
                                               #      test/renderer/pwa/generate-sw.test.ts,
                                               #      test/renderer/plugin-host/url-loader.test.ts
npx playwright test test/e2e/100-offline.spec.ts
```

The e2e suite runs against the **dev server**, which has no worker by design, so
it covers the degradation half only. The precache itself is covered by the unit
tests on the generator plus the manual pass below.

Manual, against a real build (`vite preview` will not do — it serves at `/` while
the scope is `/easydbaccess/`):

```bash
cd packages/renderer && npx vite build --base /easydbaccess/
mkdir -p ../../.preview/easydbaccess && cp -r dist/* ../../.preview/easydbaccess/
npx http-server ../../.preview -p 4173 -c-1
# open http://localhost:4173/easydbaccess/   (localhost is a secure context)
```

1. Application → Service Workers: one worker, **activated**, scope
   `/easydbaccess/`.
2. Application → Cache Storage: one `easydb-precache-v…`, no `.map`, no `.woff`.
3. Network → **Offline** → hard reload. The shell paints, the database opens,
   tables list, the grid renders, the offline chip is in the header.
4. Still offline: a map draws its points with the tile banner; a chart opens from
   the cached lazy chunk.
5. Application → Manifest: no errors, Install offered.
6. Rebuild with a bumped version and reload once online: the update bar appears,
   the old worker is still `activated` and the new one `waiting` until Reload is
   pressed.
7. `?nosw=1`: registration and caches gone, page reloads working.
