# The Electron Shell

`packages/electron` is the desktop wrapper. Today it is deliberately minimal
— a `BrowserWindow` loading the exact same renderer bundle the browser uses,
still backed by Dexie/IndexedDB inside the renderer process (see
[`STORAGE.md`](./STORAGE.md)) — with the bigger integration work (an
in-process sync server, a SQLite-backed storage adapter, native file
dialogs) planned but not yet wired. This page covers what exists today and
exactly what's still ahead; see
[`packages/electron/CLAUDE.md`](../packages/electron/CLAUDE.md) for the
terse contributor-facing version and the
[rewrite plan](../.claude/plans/2026-05-21-rewrite-architecture.md) (Phase 8)
for the original design rationale.

## What's actually running today

[`src/main.ts`](../packages/electron/src/main.ts) creates one
`BrowserWindow` and loads either the Vite dev server or a built renderer,
switching on whether `EASYDB_RENDERER_URL` is set:

- **Dev** (`EASYDB_RENDERER_URL` present) — loads that URL directly and
  opens DevTools detached.
- **Prod** (unset) — loads `packages/electron/frontend/index.html`, a
  renderer build produced specifically for Electron with `base=./` so its
  asset paths resolve under `file://`. This is a **separate build output**
  from `packages/renderer/dist/` (the gh-pages build, built with
  `--base /easydbaccess/`) precisely so packaging the desktop app can never
  silently clobber — or be clobbered by — the browser build, or vice versa.

`app.on('window-all-closed')` quits on every platform except macOS (the
platform convention of leaving the app running with no windows);
`app.on('activate')` recreates the window if the dock icon is clicked with
none open. That's the entire main-process surface today — no IPC handlers,
no menu customization, no auto-updater.

**Security defaults, not to be relaxed:** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. Anything the main process ever
needs to expose to the renderer goes through `preload.ts`'s
`contextBridge`, never by turning any of these three off.

## The preload bridge — currently a version stamp

[`src/preload.ts`](../packages/electron/src/preload.ts) exposes exactly one
thing today: `window.easydb = { platform: 'electron', version }`. That's
enough for the renderer to *detect* it's running inside Electron (useful
once there's an Electron-specific code path to branch into — see Phase 8
below) but nothing yet routes through it. The file's own comment marks it
as the landing spot for the IPC storage adapter and native
save/open-file handlers once those exist.

## Why this package is CommonJS

`@easydb/electron` is `"type": "commonjs"` — the only package in the
monorepo that isn't ESM. Electron's main process is happiest on CJS, and
`electron-builder` packages that shape more predictably. Source is written
in ordinary ESM-style TS import syntax; `tsc` compiles it down to CJS.
Don't switch this to `"module"` without separately verifying
`electron-builder` still finds and packages the compiled entry point.

## Dev workflow

`npm run dev:electron` runs [`scripts/dev.cjs`](../packages/electron/scripts/dev.cjs),
which:

1. Probes `EASYDB_RENDERER_URL` (default `http://localhost:5190`); if
   nothing answers, spawns `npm run dev:renderer` from the repo root and
   polls until it's reachable (30s timeout).
2. Runs `tsc -b` inside `packages/electron` so `dist/main.js` +
   `dist/preload.js` exist and are current.
3. Resolves the Electron binary path via `require('electron')` (a Node
   trick — `electron` the npm package, required from plain Node rather than
   run as `electron .`, resolves to the path of the actual Electron
   executable) and spawns it pointed at the dev renderer URL.
4. Tears down whichever Vite process *it* started (not a pre-existing one
   the developer was already running) when Electron exits, and forwards
   `SIGINT`/`SIGTERM` the same way.

This is what makes `dev:electron` usable standalone — a developer doesn't
need `dev:renderer` running in a second terminal first; the script starts
one for them and cleans up after itself, but leaves an already-running dev
server alone.

## Packaging

`package-electron.ps1` (repo root) is the packaging entry point:

```powershell
./package-electron.ps1              # build only
./package-electron.ps1 -Installer   # build + electron-builder installer
```

Build order matters — shared and server are built first (Electron pulls
both as workspace dependencies, `@easydb/server` in anticipation of Phase 8
even though nothing imports it yet), then the renderer is built via the
Electron-specific `build:electron` script (→ `packages/electron/frontend/`,
`base=./`), then `packages/electron` itself (`tsc`).
[`electron-builder.json`](../packages/electron/electron-builder.json)
bundles `dist/**/*` (compiled main/preload), `frontend/**/*` (the renderer
build), and `../server/dist/**/*` (again, pre-staged for Phase 8) into
platform installers — NSIS on Windows, a `.dmg` on macOS, an AppImage on
Linux — output to `packages/electron/dist-installer/`.

One documented friction point: `-Installer` runs `electron-builder`, which
internally does `npm install --omit=dev` inside `packages/electron` to
prune dev dependencies before packaging — inside an npm-workspaces
monorepo, this can prune hoisted dependencies at the repo root and trip
Windows file locks. The script's own comment warns: only pass `-Installer`
when you're prepared to run a plain `npm install` afterward to restore the
workspace.

## What's deliberately not wired yet (Phase 8)

Everything below is planned, not present. Don't "fix" the current
BrowserWindow-only shell into partially implementing one of these without
reading the architecture plan first — each is a coordinated change across
the renderer and this package, not a local patch:

- **Hono in-process.** The main process will call `createServer(...)` from
  `@easydb/server` (see [`SERVER.md`](./SERVER.md)) directly and mount it
  on a localhost port, instead of the renderer talking to a separately
  spawned Node process — the same exported `Hono` app, just given a
  different `StoreAdapter`.
- **A `better-sqlite3`-backed `StoreAdapter`.** The server package
  currently ships `fs` and `sqlite` (via Node's built-in `node:sqlite`)
  adapters (`SERVER.md`); Electron's in-process server needs a
  `better-sqlite3` implementation of the same `StoreAdapter` interface —
  chosen for Electron specifically because it's a synchronous, native
  binding well-suited to bundling inside a desktop app.
- **Dexie-over-IPC storage adapter.** The renderer's `DataStore` (see
  `STORAGE.md`) swaps from Dexie/IndexedDB to an implementation that
  proxies every call over IPC to a main-process store — the plugin-facing
  `DataCollection<T>` contract stays byte-for-byte identical, so no plugin
  code changes; only `db/data-store-dexie.ts` gets a sibling
  implementation, selected at boot when `window.easydb?.platform ===
  'electron'`. Per `packages/electron/CLAUDE.md`, this branch belongs in
  `app-context.ts`, not scattered `window.easydb` checks throughout the
  renderer.
- **Native save/open dialogs.** `api.backend.saveFile` (see `PLUGINS.md`'s
  exporter plugins, all of which call it) currently falls back to a
  browser `<a download>` even inside Electron; it will route through
  `dialog.showSaveDialog` once the IPC bridge exists.

The consistent pattern for landing any of these: implement the main-process
side in `src/main.ts` (or split into `src/ipc/` if it grows), expose only
the minimal surface needed through `preload.ts`'s `contextBridge` — never
raw Electron APIs — and make the renderer's `app-context.ts` the single
place that decides which adapter to construct, so plugins and the rest of
the renderer stay oblivious to which environment they're running in.
