# The Electron Shell

`packages/electron` is the desktop wrapper: a `BrowserWindow` loading the
exact same renderer bundle the browser uses, **plus** the desktop storage
layer. Inside Electron the renderer does not use Dexie/IndexedDB at all — it
talks over IPC to a `node:sqlite` store in the main process, and the user can
open, save and import `.db` files (see [`STORAGE.md`](./STORAGE.md)). An
in-process sync server is still ahead. See
[`packages/electron/CLAUDE.md`](../../packages/electron/CLAUDE.md) for the
terse contributor-facing version, and the
[storage design](../../.claude/plans/2026-07-31-electron-sqlite-storage.md)
for why the file is laid out the way it is. The user-facing side of the `.db`
operations is [`help/database-files.md`](../help/database-files.md).

"Phase 8" throughout this doc refers to the original rewrite plan's numbering.
That plan file is gone, but the numbering is still how the docs and `CLAUDE.md`
talk about remaining scope.

## What's actually running today

[`src/main.ts`](../../packages/electron/src/main.ts) creates one
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

The prod branch also sets a Content-Security-Policy on the `file://` load via
`onHeadersReceived`. It keeps `script-src 'unsafe-eval'`, because per-column
user scripts run through `new Function`
(`packages/renderer/src/util/column-script.ts`). The consequence is visible:
Electron's "Insecure Content-Security-Policy" warning still prints to the
console in an unpackaged run. It fires on any policy granting `unsafe-eval`
and cannot be silenced without dropping the column-script feature; Electron
suppresses it once the app is packaged.

`app.on('window-all-closed')` quits on every platform except macOS (the
platform convention of leaving the app running with no windows);
`app.on('activate')` recreates the window if the dock icon is clicked with
none open. Beyond that the main process registers the storage and file IPC
handlers described below — still no menu customization, no auto-updater.

**Security defaults, not to be relaxed:** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. Anything the main process ever
needs to expose to the renderer goes through `preload.ts`'s
`contextBridge`, never by turning any of these three off.

## The preload bridge

[`src/preload.ts`](../../packages/electron/src/preload.ts) exposes
`window.easydb = { platform, version, store, db }` — no raw `ipcRenderer`,
and only the specific functions the renderer needs:

- **`store`** — one method per `store:*` IPC channel (`find`, `findOne`,
  `insert`, `bulkInsert`, `upsert`, `patch`, `remove`, `bulkRemove`, `count`,
  `dbPath`) plus `onChanged(cb)`, which subscribes to the main process's
  `store:changed` broadcast. That broadcast is what replaces Dexie's
  `liveQuery`: the main process names the mutated collection, the renderer's
  collection re-runs its query and notifies its subscribers.
- **`db`** — the user-facing file operations: `openDb` / `openDbCommit`,
  `saveDbAs`, `importDb` / `importDbCommit`, `currentDb`. Open and Import are
  two-phase on purpose: the OS dialog has to return before the app can name
  the file (or the colliding table) in its own confirmation prompt, so phase
  one picks and previews with no side effects and phase two commits what the
  user agreed to.

`preload.ts` imports the main-side modules **for their types only**
(`import type`, erased at compile time). Their runtime code calls
`dialog`/`app`/`BrowserWindow`, which don't exist in preload's context —
importing them for real would misbehave at run time instead of failing
typecheck.

## Storage

The store lives in the main process, not the renderer:

| File | Role |
|---|---|
| [`src/sqlite-store.ts`](../../packages/electron/src/sqlite-store.ts) | The store. User tables are real SQL tables; documents (`workspaces`, `settings`, `plugins`, `viewTemplates`, `viewInstances`) live in `_easydb_docs`. |
| [`src/db-files.ts`](../../packages/electron/src/db-files.ts) | Store singleton (open / switch / remembered path) and the Open / Save As dialogs. |
| [`src/db-import.ts`](../../packages/electron/src/db-import.ts) | Imports **any** SQLite file by reading its `sqlite_master` — not only files easyDBAccess wrote. `probeDatabaseFile` classifies a picked file read-only. |

**Open takes only our own files; Import takes any.** Opening a database is not
a read-only act — the store's constructor creates `_easydb_docs` and
`_easydb_tables` — so Open on a stranger's `.db` would add two tables to it and
show an empty workspace. `pickDatabaseToOpen` therefore probes first and
reports `kind`: `easydb` opens after the usual confirmation, `foreign` is
offered as an import of the same file, and `unreadable` (not a SQLite database
at all) is reported as such. Nothing is written until the user has agreed to
one of those.

The renderer side is [`db/data-store-ipc.ts`](../../packages/renderer/src/db/data-store-ipc.ts),
selected in `app-context.ts` when `window.easydb?.store` exists. The
plugin-facing `DataCollection<T>` contract is identical either way, so no
plugin knows the difference — and `renderer/src/plugins/electron-db.ts` (the
Database footer button) registers nothing at all when the bridge is absent,
which is how the browser build stays untouched.

`packages/shared/src/sql-mapping.ts` holds the type↔SQL mapping used by
**both** this store and the server's `sqlite-store.ts`, so a `.db` written by
either has the same shape. Full layout and the three rules that must not be
broken (`sql_table` assigned once, additive-only column reconciliation,
`_extra` overflow) are in
[`packages/electron/CLAUDE.md`](../../packages/electron/CLAUDE.md) and the
[design note](../../.claude/plans/2026-07-31-electron-sqlite-storage.md).

## Why this package is CommonJS

`@easydb/electron` is `"type": "commonjs"` — the only package in the
monorepo that isn't ESM. Electron's main process is happiest on CJS, and
`electron-builder` packages that shape more predictably. Source is written
in ordinary ESM-style TS import syntax; `tsc` compiles it down to CJS.
Don't switch this to `"module"` without separately verifying
`electron-builder` still finds and packages the compiled entry point.

## Dev workflow

`npm run dev:electron` runs [`scripts/dev.cjs`](../../packages/electron/scripts/dev.cjs),
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
both as workspace dependencies; `@easydb/shared` is imported for real, by
`sqlite-store.ts` and `db-import.ts`, while `@easydb/server` is still only
pre-staged), then the renderer is built via the
Electron-specific `build:electron` script (→ `packages/electron/frontend/`,
`base=./`), then `packages/electron` itself (`tsc`).
[`electron-builder.json`](../../packages/electron/electron-builder.json)
bundles `dist/**/*` (compiled main/preload), `frontend/**/*` (the renderer
build), and `../server/dist/**/*` (again, pre-staged) into
platform installers — NSIS on Windows, a `.dmg` on macOS, an AppImage on
Linux — output to `packages/electron/dist-installer/`.

One documented friction point: `-Installer` runs `electron-builder`, which
internally does `npm install --omit=dev` inside `packages/electron` to
prune dev dependencies before packaging — inside an npm-workspaces
monorepo, this can prune hoisted dependencies at the repo root and trip
Windows file locks. The script's own comment warns: only pass `-Installer`
when you're prepared to run a plain `npm install` afterward to restore the
workspace.

## What's deliberately not wired yet

Two Phase 8 items remain. Each is a coordinated change across the renderer and
this package, not a local patch:

- **Hono in-process.** The main process will call `createServer(...)` from
  `@easydb/server` (see [`SERVER.md`](./SERVER.md)) directly and mount it
  on a localhost port, instead of the renderer talking to a separately
  spawned Node process — the same exported `Hono` app, given a `StoreAdapter`
  over the same SQLite file. `@easydb/server` is already a dependency and is
  already pre-staged into the installer; nothing imports it yet.
- **Native save dialog for exports.** `api.backend.saveFile` (see
  `PLUGINS.md`'s exporter plugins, all of which call it) still falls back to
  a browser `<a download>` even inside Electron. `dialog.showSaveDialog` is
  already in use for the `.db` operations, so routing `saveFile` through the
  same bridge is the leftover.

The plan called for a `better-sqlite3` `StoreAdapter`; it was not needed.
Electron 43 ships Node 24, where `node:sqlite` is available unflagged, so the
store uses the built-in and the desktop app carries no native binding to
rebuild per platform.

The consistent pattern for landing either remaining item: implement the
main-process side in `src/main.ts` (or split into `src/ipc/` if it grows),
expose only the minimal surface needed through `preload.ts`'s
`contextBridge` — never raw Electron APIs — and keep the environment branch in
the renderer's `app-context.ts` (or a plugin's own `init` guard), so plugins
and the rest of the renderer stay oblivious to which environment they're
running in.
