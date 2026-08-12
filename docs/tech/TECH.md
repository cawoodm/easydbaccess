# Technologies & Architecture

A top-level tour of what easyDBAccess is built from and how the pieces fit
together. For the user-facing pitch see [`../../README.md`](../../README.md);
for the user guide see [`../help/INDEX.md`](../help/INDEX.md); for design
rationale on a specific feature see the dated notes in `.claude/plans/`.

## What it is

easyDBAccess is a **local-first, plugin-extensible, multi-table database
app**. The same TypeScript renderer ships in two skins:

- A **browser app** (Vite-served SPA) that stores everything in IndexedDB.
- An **Electron desktop app** that swaps IndexedDB for an on-disk SQLite
  file. (Embedding the sync server in the same process is designed but not
  yet wired — see the runtime-shapes table below.)

A small companion **Hono server** handles things the browser sandbox cannot:
multi-device sync, URL-based data ingestion (CORS-blocked APIs), and a
plugin registry.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript everywhere — renderer, server, Electron main, plugin host |
| UI | [Lit](https://lit.dev/) web components (no virtual DOM, plugin-friendly) |
| Renderer build | [Vite](https://vitejs.dev/) (dev server on port `5190`) |
| Browser storage | IndexedDB via [Dexie](https://dexie.org/) — `liveQuery` reactivity and explicit versioned migrations |
| Desktop storage | SQLite via the built-in **`node:sqlite`** in the Electron main process — no native binding to rebuild per platform. The renderer reaches it over IPC; the workspace is a real `.db` file the user opens and saves. |
| Backend | [Hono](https://hono.dev/) on `@hono/node-server`, ESM, Node ≥ 24 |
| Desktop shell | Electron 43 with contextIsolation, sandbox, no nodeIntegration (43 is also what makes `node:sqlite` available unflagged) |
| Windows | in-repo panel shell (`window-mgr/panel-shell/`) for draggable in-app panels |
| Icons | `material-icons` |
| Reactivity | Dexie `liveQuery` in the browser; a `store:changed` IPC broadcast under Electron |
| Testing | Vitest (unit) + Playwright (e2e) |
| Tooling | npm workspaces, `tsc -b` project references, Prettier, ESLint |
| Packaging | `electron-builder` (via PowerShell wrappers in repo root) |

## Repository layout

The repo is an **npm-workspaces monorepo** with four packages plus example
plugins:

```
easyDBAccess/
├── packages/
│   ├── shared/      types, plugin-api contract, SQL mapping   (pure TS, zero deps)
│   ├── renderer/    Lit chrome + Dexie + plugin host          (browser + Electron renderer)
│   ├── server/      Hono app, sync routes, storage adapters   (standalone + in-process)
│   └── electron/    desktop shell (BrowserWindow + preload) AND desktop
│                    storage (node:sqlite store, .db file operations)
├── plugins-examples/  reference plugins loaded by URL
├── docs/
│   ├── tech/          architecture notes (this file, SYNCH.md, etc.)
│   └── help/          user guide + screenshots
├── test/              every test suite
│   ├── renderer/      Vitest units, mirroring packages/renderer/src/
│   ├── server/        Vitest HTTP suites for the Hono app
│   └── e2e/           Playwright specs + fixtures
└── .claude/plans/     authoritative design docs
```

Each package keeps its own `CLAUDE.md` with package-specific gotchas.

## The three runtime shapes

The same renderer code runs in three deployment modes; only the storage
adapter and sync target change.

| Mode | Renderer | Local storage | Backend | Sync target |
|---|---|---|---|---|
| **Browser** | Lit + Vite bundle | Dexie (IndexedDB) | none locally | optional remote Hono |
| **Electron** | Same Lit bundle in renderer process | `data-store-bridge.ts` over IPC → main-process `node:sqlite` store, in a user-chosen `.db` file **(landed)** | Hono in-process *(not wired yet)* | optional remote Hono |
| **Hosted Hono** | n/a | filesystem (one JSON per workspace) or SQLite | Hono | central peer for multi-device |

The **same** Hono code in [`packages/server`](../../packages/server) runs both
inside Electron's main process and as a remote peer — `createServer({ store,
fetchFn, ... })` is the single entry point, parameterized by a
`StoreAdapter`.

## Architecture diagram

```
Browser                Electron renderer        Electron main / Node server
┌────────────────┐    ┌────────────────┐       ┌──────────────────────┐
│ Lit chrome     │    │ Lit chrome     │       │ node:sqlite store    │
│ Dexie          │─HTTP→ data-store-   │─IPC──→│  → a user-chosen .db │
│ (IndexedDB)    │    │ ipc.ts         │       │ Hono server:         │
│ Plugin runtime │    │ Plugin runtime │       │  /sync (pull/push)   │
│ Plugins .js    │    │ Plugins .js    │       │  /fetch (URL proxy)  │
└────────────────┘    └────────────────┘       │  /plugins/registry   │
                                               └──────────────────────┘
                          (the Hono half does not run in Electron's main
                           process yet — only the store does)
                                                          ↑
                              multi-device sync via HTTP to a hosted instance
                              of the same Hono server.
```

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
  - `backend.fetch` — URL proxy through the Hono server (escapes the CORS
    cage when one is available).
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

The server stores **one JSON document per workspace** and does not inspect
its shape — merge semantics live entirely in the client. Concurrency is
managed by **ETag-based optimistic locking** (`If-Match` on PUT, `412` on
conflict).

| Route | Purpose |
|---|---|
| `GET /sync/:workspaceId` | Pull blob, returns `ETag` header |
| `PUT /sync/:workspaceId` | Push blob, `If-Match` enforces concurrency |
| `GET /sync/:workspaceId/stream` | SSE live-change notifications |
| `POST /fetch` | URL proxy with allowlist + byte cap |
| `GET /plugins/registry` | Stub for future curated plugin catalog |
| `GET /health` | Liveness + version |

Storage adapters implementing `StoreAdapter` swap freely:

- `fs-store.ts` — one JSON file per workspace (default).
- `sqlite-store.ts` — one SQLite DB per workspace, single-row blob table.

A new backend (Postgres, S3, …) is a single `StoreAdapter` implementation,
roughly 80 lines. See [`SYNCH.md`](./SYNCH.md) for the full protocol.

Row-level replication with last-write-wins conflict resolution is still
ahead (Phase 7); today `/sync` moves the whole workspace as one blob.

## Build, dev, and packaging

All commands run from the repo root:

| Command | Result |
|---|---|
| `npm run dev:renderer` | Vite dev server at `http://localhost:5190` |
| `npm run dev:server` | `tsx watch` Hono server on `http://localhost:3000` |
| `npm run dev:electron` | Boots Vite + Electron with live reload |
| `npm run build` | Builds every workspace that has a `build` script |
| `npm run typecheck` | `tsc -b` across all project references, then `test/tsconfig.json` |
| `npm run test` | One Vitest run over `test/` |
| `npm run test:e2e` | Playwright specs in `test/e2e/` — one Chromium project against the browser build. There is no Electron Playwright project; desktop-only code is covered by Vitest instead (see [`TESTING.md`](./TESTING.md)) |
| `npm run package:electron` | Produces an installer via `electron-builder` |

Renderer is shipped via Vite; shared/server/electron compile with `tsc -b`
project references; Electron is the only `commonjs` package (the rest are
ESM).

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

Phases 1–6 are complete: skeleton, shared types, Dexie storage, the plugin
host, the built-in plugin roster, the in-repo panel shell, and the standalone
Hono server (`/sync`, `/fetch`, `/plugins/registry`). Phase 8's **storage**
half is complete too — inside Electron the renderer runs on a main-process
`node:sqlite` store and the workspace is a `.db` file the user opens and
saves.

Still ahead:

- **Phase 7** — live multi-device replication beyond the whole-workspace blob.
- **Phase 8, the rest** — Hono in the Electron main process, and routing
  `api.backend.saveFile` through the native save dialog.
- **Phase 9** — migration from v1 minniDBMax `localStorage`.
- **Phase 10** — polish.

Progress lives in `TODO.md` at the repo root (untracked — it's a local
working file, not part of the repo).
