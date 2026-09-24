# Technologies & Architecture

A top-level tour of what easyDBAccess is built from and how the pieces fit
together. For the user-facing pitch see [`../../README.md`](../../README.md);
for the user guide see [`../help/INDEX.md`](../help/INDEX.md); for design
rationale on a specific feature see the dated notes in `.claude/plans/`.

## What it is

easyDBAccess is a **local-first, plugin-extensible, multi-table database
app**. The same TypeScript renderer ships in two skins:

- A **browser app** (Vite-served SPA) that stores a workspace as a real
  SQLite file (`.edb`) in the `opfs-sahpool` VFS via sqlite-wasm.
- An **Electron desktop app** that stores the same format on disk through
  the main-process `node:sqlite` store.

There is no backend of our own. Multi-device sync goes through GitHub Gists
(see [`SYNCH.md`](./SYNCH.md)); URL-based data ingestion is a direct browser
fetch, subject to the target site's CORS headers.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript everywhere — renderer, Electron main, plugin host |
| UI | [Lit](https://lit.dev/) web components (no virtual DOM, plugin-friendly) |
| Renderer build | [Vite](https://vitejs.dev/) (dev server on port `5190`) |
| Browser storage | SQLite via [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm) in a Web Worker, in the `opfs-sahpool` VFS, writing a real `.edb` file — see [`EDB.md`](./EDB.md) |
| Desktop storage | The **same** store, bound to the built-in **`node:sqlite`** in the Electron main process — no native binding to rebuild per platform. The renderer reaches it over IPC; the workspace is a real `.db`/`.edb` file the user opens and saves, in the same format a browser writes. |
| Multi-device sync | GitHub Gists (`gist-sync` plugin) — no backend of ours; see [`SYNCH.md`](./SYNCH.md) |
| Desktop shell | Electron 43 with contextIsolation, sandbox, no nodeIntegration (43 is also what makes `node:sqlite` available unflagged) |
| Windows | in-repo panel shell (`window-mgr/panel-shell/`) for draggable in-app panels |
| Icons | `material-icons` |
| Reactivity | A `changed` broadcast per collection in the browser worker; a `store:changed` IPC broadcast under Electron |
| Testing | Vitest (unit) + Playwright (e2e) |
| Tooling | npm workspaces, `tsc -b` project references, Prettier, ESLint |
| Packaging | `electron-builder` (via PowerShell wrappers in repo root) |

## Repository layout

The repo is an **npm-workspaces monorepo** with three packages plus example
plugins:

```
easyDBAccess/
├── packages/
│   ├── shared/      types, plugin-api contract, SQL mapping   (pure TS, zero deps)
│   ├── renderer/    Lit chrome + sqlite-wasm store + plugin host (browser + Electron renderer)
│   └── electron/    desktop shell (BrowserWindow + preload) AND desktop
│                    storage (node:sqlite store, .db file operations)
├── plugins-examples/  reference plugins loaded by URL
├── docs/
│   ├── tech/          architecture notes (this file, SYNCH.md, etc.)
│   └── help/          user guide + screenshots
├── test/              every test suite
│   ├── renderer/      Vitest units, mirroring packages/renderer/src/
│   ├── electron/      Vitest units, mirroring packages/electron/src/
│   ├── shared/        Vitest units, mirroring packages/shared/src/
│   └── e2e/           Playwright specs + fixtures
└── .claude/plans/     authoritative design docs
```

Each package keeps its own `CLAUDE.md` with package-specific gotchas.

## The two runtime shapes

The same renderer code runs in two deployment modes; only the storage
transport changes. Neither talks to a backend of ours — see "The sync
model" below for how a workspace still moves between devices.

| Mode | Renderer | Local storage |
|---|---|---|
| **Browser** | Lit + Vite bundle | `data-store-bridge.ts` over `postMessage` → a sqlite-wasm worker, database in the `opfs-sahpool` VFS, in a user-chosen `.edb` file |
| **Electron** | Same Lit bundle in renderer process | `data-store-bridge.ts` over IPC → main-process `node:sqlite` store, in a user-chosen `.db`/`.edb` file |

## Architecture diagram

```
Browser                       Electron renderer + main
┌───────────────────────┐    ┌────────────────┐    ┌──────────────────────┐
│ Lit chrome            │    │ Lit chrome     │    │ node:sqlite store    │
│ Plugin runtime        │    │ Plugin runtime │    │  → a user-chosen .db │
│ Plugins .js           │    │ Plugins .js    │    │    (main process)    │
│                       │    │                │    │                      │
│ data-store-bridge.ts  │    │ data-store-    │IPC→│                      │
│   │ postMessage       │    │ bridge.ts      │    │                      │
│   ▼                   │    └────────────────┘    └──────────────────────┘
│ sqlite-wasm worker    │
│  → a user-saved .edb  │
│  + an OPFS mirror     │
└───────────────────────┘

Multi-device sync is Gist Sync (GitHub) or settling two local .edb copies —
neither goes through a server of ours. See SYNCH.md.
```

`data-store-bridge.ts` appears twice on purpose. It is one `DataStore` over an
async message bridge, and the two transports — `ipcRenderer` and `postMessage` —
satisfy the same interface, so the browser's file mode needed no second adapter.

## The plugin model (the load-bearing decision)

[`packages/shared/src/plugin-api.ts`](../../packages/shared/src/plugin-api.ts)
is the single source of truth for what plugins can do.

- A plugin is a **single ES module `.js` file**.
- Distribution is **by URL**: users add a plugin URL through the Plugin
  Manager dialog. The host fetches it, caches the body in localStorage,
  wraps it in a Blob URL, and dynamic-`import()`s it.
- Lifecycle: `init(api)` runs at startup; `load(api)` runs once
  `app:ready` fires.
- The `api` object exposes everything a plugin can do:
  - `store` — typed `DataCollection<T>` wrappers (no raw RxDB).
  - `events` — typed bus (`app:ready`, `table:created`, `drop:files`, …).
  - `ui` — slot registries for header/footer/table buttons, cell/row/table
    renderers, importers, exporters, drop handlers, URL sources.
  - `windows` — panel-shell-backed window manager.
  - `backend.fetch` — a direct browser fetch, subject to the target site's
    CORS headers (there is no proxy to escape that).
- Plugins **may monkey-patch `api.*` methods** to override defaults — this
  is contractual, not a bug.
- **Built-in features ARE plugins** (CSV import, default table renderer,
  cell renderers, sync UI). They live under
  [`packages/renderer/src/plugins/`](../../packages/renderer/src/plugins/) and
  are static-imported by the loader; URL-loaded plugins follow the exact
  same contract. This dogfoods the API so it cannot rot.

The renderer hot-installs catalog plugins without a reload by re-emitting
`app:ready`; components that depend on registries re-snapshot on that event.

## The data layer

Collections are declared as the Dexie schema in
[`packages/renderer/src/db/dexie-db.ts`](../../packages/renderer/src/db/dexie-db.ts),
typed by [`packages/shared/src/types.ts`](../../packages/shared/src/types.ts):

| Collection | Shape |
|---|---|
| `workspaces` | `{ id, name, createdAt, pluginUrls, title? }` |
| `tables` | `{ id, workspaceId, name, columns, sort/filter state, windowGeometry, … }` |
| `rows` | `{ id, tableId, data }` — **one** table, `tableId`-scoped views |
| `settings` | `{ key, value }` — the workspace layer of the settings model |
| `plugins` | `{ url, enabled, lastFetched, cachedBody, lastError }` |
| `viewTemplates` / `viewInstances` | the View system's templates and per-table bindings |

Plugins never see Dexie. They get the `DataStore` wrapper
([`data-store-dexie.ts`](../../packages/renderer/src/db/data-store-dexie.ts)),
which exposes the minimal `DataCollection<T>` shape from `plugin-api.ts`.
That indirection is what made the Electron swap possible: there
[`data-store-bridge.ts`](../../packages/renderer/src/db/data-store-bridge.ts)
satisfies the identical contract over IPC against a `node:sqlite` store, and
nothing above it changed.

Adding a new collection touches **four** places in lockstep — the type, the
Dexie schema, the Dexie wrapper, and the IPC store + its SQLite counterpart.
See [`STORAGE.md`](./STORAGE.md) for the full picture and
`packages/shared/CLAUDE.md` for the checklist.

## The sync model

There is no sync server. A workspace moves between devices two ways, both
client-only — see [`SYNCH.md`](./SYNCH.md) for the full detail:

- **Gist Sync** — the `gist-sync` plugin pushes/pulls a workspace (or one
  table) to a private GitHub Gist, straight from the browser to GitHub's
  REST API. Manual, whole-object, no merge — push or pull asks before it
  would delete something the other side lacks.
- **Local `.edb` sync** — settling two copies of the same workspace file
  table by table and row by row, by comparing each row's `updatedAt`. See
  [`EDB.md`](./EDB.md#settling-two-copies-table-by-table-and-row-by-row).

Row-level replication with automatic conflict resolution across the network
is not built — a `packages/server` Hono backend attempted a version of this
(whole-workspace JSON blob, ETag concurrency) and was removed once Gist Sync
covered the need with no backend to run.

## Build, dev, and packaging

All commands run from the repo root:

| Command | Result |
|---|---|
| `npm run dev:renderer` | Vite dev server at `http://localhost:5190` |
| `npm run dev:electron` | Boots Vite + Electron with live reload |
| `npm run build` | Builds every workspace that has a `build` script |
| `npm run typecheck` | `tsc -b` across all project references, then `test/tsconfig.json` |
| `npm run test` | One Vitest run over `test/` |
| `npm run test:e2e` | Playwright specs in `test/e2e/` — one Chromium project against the browser build. There is also a separate Electron Playwright config for `test/e2e/desktop/` (see [`TESTING.md`](./TESTING.md)) |
| `npm run package:electron` | Produces an installer via `electron-builder` |

Renderer is shipped via Vite; shared/electron compile with `tsc -b` project
references; Electron is the only `commonjs` package (the rest are ESM).

## Cross-cutting conventions

A handful of rules that touch every layer:

- **TypeScript is strict**: `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `exactOptionalPropertyTypes`. Lit lifecycle methods need `override`.
- **`useDefineForClassFields: false` + `experimentalDecorators: true`** in
  the renderer's tsconfig — required by Lit's `@property` / `@state`. Other
  packages keep TypeScript defaults.
- **No `dexie` import outside [`packages/renderer/src/db/`](../../packages/renderer/src/db/)**.
  Plugins use `DataStore`; bypassing it would have broken the Electron
  IPC/SQLite path, which is exactly the swap that proves the seam works.
- **A Dexie version bump is only needed for indexes.** Adding or removing an
  *indexed* field needs a new `version(N).stores({...})` block; adding a plain
  JSON field on an existing record needs nothing. Rewriting existing records
  (not just re-indexing them) needs an `.upgrade(tx => …)` callback in that
  block.
- **The SQLite side reconciles columns additively** — `ADD COLUMN` only, never
  `RENAME`/`DROP`, because `ColumnSpec` has no stable id. See `STORAGE.md`.
- **Electron security defaults** (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`) are non-negotiable; anything
  the renderer needs from main goes through `preload.ts` via
  `contextBridge`.

## Status

Phases 1–6 are complete: skeleton, shared types, SQLite storage, the plugin
host, the built-in plugin roster, and the in-repo panel shell. Storage is
complete too — inside Electron the renderer runs on a main-process
`node:sqlite` store and the workspace is a `.db`/`.edb` file the user opens
and saves. A standalone Hono server existed for a time as an experiment in
server-mediated sync and URL proxying, and was removed — Gist Sync and a
direct `backend.fetch` cover those needs with no backend to run.

Still ahead:

- Live multi-device replication beyond Gist Sync's manual whole-object
  push/pull.
- Routing `api.backend.saveFile` through Electron's native save dialog.
- Migration from v1 minniDBMax `localStorage`.
- Polish.

Progress lives in `TODO.md` at the repo root (untracked — it's a local
working file, not part of the repo).
