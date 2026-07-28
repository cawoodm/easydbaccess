# Technologies & Architecture

A top-level tour of what easyDBAccess is built from and how the pieces fit
together. For the user-facing pitch see [`../../README.md`](../../README.md);
for the user guide see [`../help/INDEX.md`](../help/INDEX.md); for the full
design rationale and phased roadmap see
[`../../.claude/plans/2026-05-21-rewrite-architecture.md`](../../.claude/plans/2026-05-21-rewrite-architecture.md).

## What it is

easyDBAccess is a **local-first, plugin-extensible, multi-table database
app**. The same TypeScript renderer ships in two skins:

- A **browser app** (Vite-served SPA) that stores everything in IndexedDB.
- An **Electron desktop app** that swaps IndexedDB for an on-disk SQLite
  file and embeds the sync server in-process.

A small companion **Hono server** handles things the browser sandbox cannot:
multi-device sync, URL-based data ingestion (CORS-blocked APIs), and a
plugin registry.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript everywhere — renderer, server, Electron main, plugin host |
| UI | [Lit](https://lit.dev/) web components (no virtual DOM, plugin-friendly) |
| Renderer build | [Vite](https://vitejs.dev/) (dev server on port `5190`) |
| State / DB | [RxDB](https://rxdb.info/) — schema-validated reactive collections |
| Browser storage | IndexedDB via the RxDB **Dexie** adapter |
| Desktop storage | SQLite via `better-sqlite3` (Phase 8) |
| Backend | [Hono](https://hono.dev/) on `@hono/node-server`, ESM, Node ≥ 24 |
| Desktop shell | Electron 33 with contextIsolation, sandbox, no nodeIntegration |
| Windows | jsPanel4 for draggable in-app panels |
| Icons | `material-icons` |
| Reactivity | RxJS (transitively via RxDB) |
| Testing | Vitest (unit) + Playwright (e2e) |
| Tooling | npm workspaces, `tsc -b` project references, Prettier, ESLint |
| Packaging | `electron-builder` (via PowerShell wrappers in repo root) |

## Repository layout

The repo is an **npm-workspaces monorepo** with four packages plus example
plugins:

```
easyDBAccess/
├── packages/
│   ├── shared/      types, RxDB schemas, plugin-api contract  (pure TS, zero deps)
│   ├── renderer/    Lit chrome + RxDB + plugin host           (browser + Electron renderer)
│   ├── server/      Hono app, sync routes, storage adapters   (standalone + in-process)
│   └── electron/    desktop shell (BrowserWindow + preload)
├── plugins-examples/  reference plugins loaded by URL
├── docs/
│   ├── tech/          architecture notes (this file, SYNCH.md, etc.)
│   └── help/          user guide + screenshots
├── e2e/               Playwright suites
└── .claude/plans/     authoritative design docs
```

Each package keeps its own `CLAUDE.md` with package-specific gotchas.

## The three runtime shapes

The same renderer code runs in three deployment modes; only the storage
adapter and sync target change.

| Mode | Renderer | Local storage | Backend | Sync target |
|---|---|---|---|---|
| **Browser** | Lit + Vite bundle | RxDB-Dexie (IndexedDB) | none locally | optional remote Hono |
| **Electron** | Same Lit bundle in renderer process | RxDB-IPC → main-process RxDB-SQLite *(Phase 8)* | Hono **in-process** in main | optional remote Hono |
| **Hosted Hono** | n/a | filesystem (one JSON per workspace) or SQLite | Hono | central peer for multi-device |

The **same** Hono code in [`packages/server`](../../packages/server) runs both
inside Electron's main process and as a remote peer — `createServer({ store,
fetchFn, ... })` is the single entry point, parameterized by a
`StoreAdapter`.

## Architecture diagram

```
Browser                Electron renderer        Electron main / Node server
┌────────────────┐    ┌────────────────┐       ┌──────────────────────┐
│ Lit chrome     │    │ Lit chrome     │       │ better-sqlite3       │
│ RxDB (Dexie)   │─HTTP→ RxDB (IPC)    │─IPC──→│ RxDB-storage         │
│ Plugin runtime │    │ Plugin runtime │       │ Hono server:         │
│ Plugins .js    │    │ Plugins .js    │       │  /sync (pull/push)   │
└────────────────┘    └────────────────┘       │  /fetch (URL proxy)  │
                                               │  /plugins/registry   │
                                               └──────────────────────┘
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
  - `windows` — jsPanel-backed window manager.
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

RxDB collections, defined in
[`packages/shared/src/schemas.ts`](../../packages/shared/src/schemas.ts):

| Collection | Shape |
|---|---|
| `workspace` | `{ id, name, createdAt, pluginUrls }` |
| `table` | `{ id, workspaceId, name, code, columns, view, windowGeometry }` |
| `rows` | `{ id, tableId, data, _attachments? }` — **one** collection, `tableId`-scoped views |
| `setting` | `{ key, value }` |
| `plugin` | `{ url, enabled, lastFetched, cachedBody }` |

The renderer talks to RxDB directly in
[`packages/renderer/src/db/rx-db.ts`](../../packages/renderer/src/db/rx-db.ts),
but plugins never see RxDB — they get the
[`DataStore`](../../packages/renderer/src/db/data-store.ts) wrapper, which
exposes the minimal `DataCollection<T>` shape from `plugin-api.ts`. That
indirection is what makes the storage layer swappable (Dexie → IPC →
SQLite).

Adding a new collection requires touching **four** files in lockstep —
schema, type, RxDB registration, plugin-facing wrapper. See
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

The original architecture also calls for RxDB's HTTP replication protocol
with last-write-wins conflict resolution; that lands when multi-device sync
goes live (Phase 7).

## Build, dev, and packaging

All commands run from the repo root:

| Command | Result |
|---|---|
| `npm run dev:renderer` | Vite dev server at `http://localhost:5190` |
| `npm run dev:server` | `tsx watch` Hono server on `http://localhost:3000` |
| `npm run dev:electron` | Boots Vite + Electron with live reload |
| `npm run build` | Builds every workspace that has a `build` script |
| `npm run typecheck` | `tsc -b` across all project references |
| `npm run test` | Vitest unit suites in every package |
| `npm run test:e2e` | Playwright browser + Electron suites |
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
- **No `rxdb` import outside [`packages/renderer/src/db/`](../../packages/renderer/src/db/)**.
  Plugins use `DataStore`; bypassing it breaks the IPC/SQLite swap path.
- **Indexed numeric fields** in RxDB schemas need `multipleOf`, `minimum`,
  `maximum` — `updatedAt` uses `{ multipleOf: 1, minimum: 0, maximum:
  9999999999999 }`; copy that for new indexed timestamps.
- **Schema migrations are mandatory**: bumping `version` requires a
  matching `migrationStrategies[N]` entry, even an identity function.
- **Electron security defaults** (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`) are non-negotiable; anything
  the renderer needs from main goes through `preload.ts` via
  `contextBridge`.

## Status

Phases 1–2 (skeleton, shared types, RxDB + Dexie, basic `<data-table>`) are
complete. Browser app + standalone Hono sync server are working today.
Electron with native SQLite storage and the URL-loaded plugin manager are
the next milestones. Progress lives in [`../../TODO.md`](../../TODO.md) and
the phase-tracking section of the architecture plan.
