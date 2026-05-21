# minniDBMax v2 — Greenfield Rewrite Plan

## Context

`minniDBMax` (v0.0.29 at `C:\projects\Marc\minniDBMax`) is a browser-only,
spreadsheet-like local database with multi-table workspaces, drag-drop CSV/JSON
import, jsPanel windows, and optional GitHub Gist sync. The current code has
served as a working prototype but suffers from:

- `src/data-table.ts` is ~76 KB / 2000+ lines and conflates rendering, state,
  events, editing, virtualization, drag-to-reorder, and column editing.
- localStorage 5 MB cap and Gist 1 MB cap make it unusable for larger data sets.
- No real backend → no URL importers, no server-side fetch (CORS-blocked APIs
  cannot be ingested), no multi-device sync beyond manual push/pull.
- No plugin system → every new format, renderer, or feature requires editing
  the core.
- No desktop story — browser-only, with all the storage/CORS limits that implies.

**Goal:** Rebuild the app from scratch as a modular, plugin-extensible,
local-first TypeScript app that runs **both as a web app and as an Electron
desktop app**, with a small, loosely-coupled Node backend that handles
multi-device sync and URL-based data imports.

The existing repo at `C:\projects\Marc\minniDBMax` is the reference for
*functionality* only. The rewrite lives in a fresh location and shares no code.

## Architecture Overview

```
Browser                Electron renderer        Electron main / Node server
┌────────────────┐    ┌────────────────┐       ┌──────────────────────┐
│ Lit chrome     │    │ Lit chrome     │       │ better-sqlite3       │
│ RxDB (Dexie)   │─HTTP→ RxDB (IPC)    │─IPC──→│ RxDB-storage         │
│ Plugin runtime │    │ Plugin runtime │       │ Hono server:         │
│ Plugins .js    │    │ Plugins .js    │       │  - /replicate (pull/push)│
└────────────────┘    └────────────────┘       │  - /fetch (URL proxy)│
                                                │  - /plugins (registry)│
                                                └──────────────────────┘
                                                            ↑
                                  multi-device sync via HTTP (RxDB replication
                                  protocol) to a hosted instance of the same
                                  Hono server.
```

### Modes of operation

| Mode | Renderer | DB storage | Backend | Sync target |
|---|---|---|---|---|
| **Browser** | Lit + Vite | RxDB-Dexie (IndexedDB) | none locally | HTTP → remote Hono |
| **Electron** | Lit + Vite (in renderer) | RxDB-IPC → main-process RxDB-SQLite | Hono runs **in-process** on main | optional HTTP → remote Hono |
| **Hosted Hono** | n/a | RxDB-SQLite (better-sqlite3) | Hono | central peer for multi-device |

The same Hono code runs in two places: bundled inside Electron's main process
(for local persistence + URL fetch), and deployed remotely (for multi-device
sync). Renderer code is identical in both modes; only the storage adapter
swaps via a build flag.

## Tech Stack

- **Language:** TypeScript everywhere (renderer, main, server, plugin host).
- **UI library:** [Lit](https://lit.dev/) — minimal web components, no virtual
  DOM, perfect for the plugin model (plugins register `customElements` with
  zero framework dependency).
- **Build:** Vite for the renderer; `tsc` + `esbuild` for main/server bundles.
- **State / DB / sync:** [RxDB](https://rxdb.info/) — schema-validated,
  reactive queries, multiple storage adapters out of the box (Dexie for
  browser, SQLite via `better-sqlite3` for Node, IPC for Electron), built-in
  HTTP push/pull replication protocol.
- **Backend framework:** [Hono](https://hono.dev/) — tiny, fast, TS-native.
  Runs on Node (via `@hono/node-server`) and inside Electron's main process.
- **Persistence:** IndexedDB (browser), SQLite file (Electron + server).
- **Desktop shell:** Electron with a thin main process that hosts Hono + RxDB
  and exposes IPC to the renderer.
- **Testing:** Vitest (unit) + Playwright (e2e, both browser and Electron).
- **Lint/format:** ESLint + Prettier.

## Repository Layout

A monorepo (npm workspaces — keep it simple, no Turborepo/Nx unless needed
later):

```
minnidbmax2/
├── package.json                 # workspaces root
├── packages/
│   ├── shared/                  # types, schemas, plugin api contract
│   │   ├── src/types.ts
│   │   ├── src/schemas.ts       # RxDB collection schemas (Table, Row, Plugin, Setting)
│   │   └── src/plugin-api.ts    # the host API type plugins receive
│   ├── renderer/                # Lit chrome — runs in browser AND in Electron renderer
│   │   ├── index.html
│   │   ├── src/main.ts
│   │   ├── src/db/              # RxDB setup, storage adapter selection
│   │   ├── src/chrome/          # <app-shell>, <app-header>, <app-footer>, <workspace-selector>
│   │   ├── src/table/           # <data-table>, <data-row>, <data-cell> — broken up by concern
│   │   ├── src/window-mgr/      # replacement for jsPanel: <app-window> custom element
│   │   ├── src/dialogs/         # <column-editor>, <plugin-manager>, <import-dialog>
│   │   ├── src/events/          # typed event bus
│   │   ├── src/plugin-host/     # plugin loader, lifecycle, api factory, slot registry
│   │   └── src/importers/       # built-in CSV/JSON importers (themselves implemented as plugins)
│   ├── server/                  # Hono — runs in Electron main AND as standalone Node
│   │   ├── src/index.ts         # createServer({ storage, fetchFn })
│   │   ├── src/routes/replicate.ts
│   │   ├── src/routes/fetch.ts  # URL proxy, allowlist + size limits
│   │   └── src/routes/plugins.ts # plugin registry (list, host)
│   └── electron/
│       ├── src/main.ts          # boots Hono in-process, creates BrowserWindow
│       ├── src/preload.ts       # IPC bridge for RxDB
│       └── electron-builder.json
└── plugins-examples/            # reference plugins shipped as URLs to load
    ├── csv-import.js
    ├── markdown-export.js
    └── kanban-view.js
```

## Plugin System (the contract)

This is the highest-leverage decision; everything else hangs off it.

**Distribution:** a plugin is a single ES module `.js` file. Users add a
plugin by URL through a Plugin Manager dialog. The URL list is persisted in
the user's RxDB store (so it syncs across devices) and the fetched JS body
is cached in localStorage for offline reuse.

**Lifecycle:** the plugin host imports each enabled plugin (`import(url)`)
and invokes:

```ts
plugin.init(api)   // called once at startup, BEFORE the app is ready
plugin.load(api)   // called once the app shell, DB and current workspace are ready
```

**The `api` object** (defined in `packages/shared/src/plugin-api.ts`) is the
single contract:

```ts
interface HostApi {
  // Data layer
  store: {
    workspaces(): RxCollection<Workspace>
    tables(): RxCollection<Table>
    rows(tableId: string): RxCollection<Row>
    settings: RxCollection<Setting>
  }
  // Typed event bus
  events: {
    on<K extends keyof AppEvents>(name: K, fn: (e: AppEvents[K]) => void): Unsubscribe
    emit<K extends keyof AppEvents>(name: K, payload: AppEvents[K]): void
  }
  // Slot registries — plugins call these to inject UI
  ui: {
    registerHeaderButton(spec: ButtonSpec): Unregister
    registerFooterButton(spec: ButtonSpec): Unregister
    registerTableButton(spec: TableButtonSpec): Unregister
    registerCellRenderer(typeName: string, tag: string): Unregister  // tag = customElements name
    registerRowRenderer(viewName: string, tag: string): Unregister
    registerTableRenderer(viewName: string, tag: string): Unregister
    registerImporter(spec: ImporterSpec): Unregister     // CSV, JSON, etc.
    registerExporter(spec: ExporterSpec): Unregister
    registerDropHandler(fn: DropHandler): Unregister     // intercept drag-drop
    registerUrlSource(spec: UrlSourceSpec): Unregister   // "import from URL X"
  }
  // Window manager
  windows: {
    open(spec: WindowSpec): WindowHandle
    list(): WindowHandle[]
  }
  // Backend access (URL fetch goes through here so it works in both modes)
  backend: {
    fetch(url: string, opts?: FetchOpts): Promise<Response>
  }
}
```

**Monkey-patching contract:** plugins MAY reassign methods on `api.*` to
override default behavior. The host treats the `api` object as a mutable
namespace. Plugins are responsible for calling the original via a captured
reference. (The host documents this; it does not police it.)

**Events** (initial set, grown over time):
`app:ready`, `workspace:changed`, `table:created`, `table:deleted`,
`table:rendered`, `row:created`, `row:updated`, `row:deleted`,
`drop:files`, `import:before`, `import:after`, `export:before`,
`plugin:error`.

**Built-in features ARE plugins.** CSV import, JSON import, the default table
view, the color/image cell renderers all ship as plugins bundled at build
time and registered by default. This dogfoods the plugin API and makes it
genuinely capable.

## Data Model

RxDB collections, defined in `packages/shared/src/schemas.ts`:

- **`workspace`** — `{ id, name, createdAt, pluginUrls: string[] }`
- **`table`** — `{ id, workspaceId, name, code, columns: ColumnSpec[], view: string, windowGeometry }`
- **`row`** — `{ id, tableId, data: Record<string, unknown>, _attachments? }`
  (one row collection per table; RxDB supports dynamic collection creation)
- **`setting`** — `{ key, value }` (theme, last-opened workspace, etc.)
- **`plugin`** — `{ url, enabled, lastFetched, cachedBody }`

`ColumnSpec` keeps the spirit of today's `field:label:type:default:max:flags`
mini-language but as a typed object: `{ field, label, type, default?, max?, unique?, notnull? }`.

## Sync Model

RxDB's built-in **HTTP replication protocol** (pull/push with checkpoints).
The Hono server implements two endpoints per collection:

- `POST /replicate/:collection/pull` — returns docs since checkpoint
- `POST /replicate/:collection/push` — accepts changed docs, returns conflicts

Conflict policy: **last-write-wins by updatedAt**, with the loser archived in
a `conflict` collection so the user can inspect/restore. This is simpler than
manual CRDT merges and fits the "single user, multi-device" use case.

Live replication: WebSocket upgrade on the same endpoint for change pushes
(RxDB supports this natively via the same replication primitive).

## Build, Package & Run

- `npm run dev` — Vite dev server for renderer + `tsx watch` for server.
  Browser opens to `http://localhost:5173`; sync points at `http://localhost:3000`.
- `npm run dev:electron` — boots Electron with Vite HMR in the renderer.
- `npm run build` — produces `packages/renderer/dist`, `packages/server/dist`,
  and an Electron installer via `electron-builder`.
- `npm run test` — Vitest unit suites in every package.
- `npm run e2e` — Playwright suites against browser + Electron.

## Implementation Phases

A separate plan should expand each phase into work items, but the rough cut:

1. **Skeleton & shared types.** Workspaces config, `packages/shared` with
   collection schemas and the `HostApi` contract.
2. **DB layer in renderer.** RxDB with Dexie storage adapter; create/read/update
   workspaces and a single table; minimal `<data-table>` Lit component.
3. **Plugin host.** Plugin manager dialog, URL load → localStorage cache → dynamic
   import → `init`/`load` lifecycle, slot registries, typed event bus.
4. **Reimplement core features as plugins.** CSV importer, JSON importer,
   default table renderer, color/image cell renderers, Dump exporter.
5. **Window manager.** Replace jsPanel with a `<app-window>` custom element
   (drag/resize/min/max via Pointer Events; geometry persisted on `table`).
6. **Hono server (standalone).** `/fetch` URL proxy with allowlist + size cap,
   `/replicate/*` endpoints, plugin registry.
7. **Multi-device sync wiring.** RxDB replication enabled against the Hono
   server; conflict UI.
8. **Electron shell.** Bundle Hono into main process, IPC bridge for RxDB,
   `better-sqlite3` storage adapter, `electron-builder` packaging.
9. **Cutover.** Provide a one-shot migration tool that reads the old
   `localStorage` keys from a v1 instance and ingests them as workspaces.
10. **Polish.** Undo/redo (RxDB has a revision history primitive), global
    search, dark mode, docs.

## Files to Create (representative, not exhaustive)

The whole codebase is greenfield. Key files that establish the architecture
(create these first, in order):

- `packages/shared/src/types.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/plugin-api.ts` — **single source of truth for the
  plugin contract; everything else is downstream of this file**
- `packages/renderer/src/db/index.ts` — RxDB factory with adapter swap
- `packages/renderer/src/plugin-host/loader.ts` — URL → cache → import
- `packages/renderer/src/plugin-host/api-factory.ts` — builds the `HostApi`
  passed to each plugin
- `packages/renderer/src/chrome/app-shell.ts`
- `packages/renderer/src/table/data-table.ts` — **must stay focused**;
  split rendering, state, virtualization, editing into sibling files
- `packages/server/src/index.ts` — `createServer({ storage, fetchFn })`
- `packages/server/src/routes/replicate.ts`
- `packages/server/src/routes/fetch.ts`
- `packages/electron/src/main.ts`
- `packages/electron/src/preload.ts`
- Reference plugins: `plugins-examples/csv-import.js`,
  `markdown-export.js`, `kanban-view.js`

## Verification

End-to-end checks to confirm the rewrite is functionally complete:

1. **Browser mode**
   - `npm run dev` and visit `http://localhost:5173`.
   - Drag a CSV onto the drop zone → table appears in a window → edit a cell
     → reload page → edit persists (IndexedDB).
   - Use Plugin Manager to add a plugin by URL → it loads on next refresh
     and (e.g.) adds a header button.
   - Import data from a URL via a `urlSource` plugin → row appears.
2. **Multi-device sync**
   - Start the standalone Hono server (`npm run dev:server`).
   - Open the app in two different browsers pointing at the same server →
     edits in browser A appear in browser B within ~1 s.
   - Disconnect browser B, edit both → reconnect → conflict surfaces and is
     resolved by last-write-wins, loser archived.
3. **Electron mode**
   - `npm run dev:electron` boots the desktop app.
   - Same CSV drop / edit / persist flow, with data in `~/.minnidbmax2/db.sqlite`.
   - Add a plugin → works identically.
   - Configure remote Hono URL in settings → desktop syncs with browser instance.
4. **Plugin API stability**
   - The reference plugins under `plugins-examples/` cover every extension
     point (header/footer/table buttons, cell/row/table renderers, importer,
     exporter, URL source, drop handler). They must all load without error
     and behave correctly. These are the executable spec for `HostApi`.
5. **Tests**
   - `npm run test` (Vitest) green across all packages.
   - `npm run e2e` (Playwright) green for both browser and Electron projects.

---

## Phase 3, Slice 1: CSV importer plugin via drag-and-drop

### Context

Phases 1–2 are complete (skeleton, shared types, RxDB + Dexie, basic
`<app-shell>` + `<data-table>` reactive on IndexedDB). The app currently
has no way to ingest data; the user must script `store.tables.insert` /
`store.rows(id).insert` calls from the console. Replicating the
flagship minniDBMax feature — drop a `.csv` onto the page and get a
fully-typed table — is the first slice of Phase 3 (plugin host) and Phase 4
(reimplement built-ins as plugins) collapsed into one delivery, chosen because
it forces the smallest end-to-end plugin path to exist.

Two goals from a single feature:
1. Stand up the **minimum plugin host** (registries + api factory + loader)
   so future features can plug in instead of growing the core.
2. Prove the host by implementing CSV import as a plugin that uses **only**
   `HostApi` — no direct RxDB imports, no DOM access outside `api.ui`.

### Architecture for this slice

**Built-in plugin loading is static import for now.** The CSV plugin lives
at `packages/renderer/src/plugins/csv-import.ts` and the loader imports it
as a module on startup. URL-fetched plugins (Plugin Manager dialog, Blob
URL import, `cachedBody` offline-first) are deliberately deferred to a
later slice — the goal here is the host shape, not the delivery mechanism.
The `plugin` RxDB collection still backs both paths, so this slice doesn't
paint itself into a corner.

**Drop dispatch** lives on `<app-shell>` (host-level `dragover`/`drop`
listeners). On drop, the shell:
- calls `event.preventDefault()` on `dragover` so drop is allowed;
- on `drop`, emits `drop:files` on the typed event bus, then iterates
  registered `DropHandler`s in registration order, awaiting each, and
  stops at the first one that returns truthy.
The shell does not know anything about CSV — that lives entirely in the
plugin.

**The CSV plugin** registers both:
- `api.ui.registerDropHandler(...)` — claims drops whose files match
  `.csv` / `text/csv`. Iterates files, calls the same parser, creates a
  `Table` per file.
- `api.ui.registerImporter({ id: 'csv', accept: ['.csv','text/csv'], parse })`
  — exposes the parser to other call sites (e.g. a future Import dialog).

**Parser:** RFC-4180-ish — auto-detect separator (`,`, `;`, `\t`), strip
quotes, handle escaped quotes (`""`). Header row → column field names
(snake-cased) and labels. Type inference per column: scan the column's
values; if all parseable as finite numbers → `number`; else if all match
`/^(true|false|yes|no|0|1)$/i` → `boolean`; else if all parse as `Date` →
`date`; else `string`. Empty cells are ignored for type inference.

### Files to create

- `packages/renderer/src/plugin-host/registries.ts` — mutable lists for
  drop handlers, header/footer/table buttons, importers, exporters, URL
  sources; `Map`s for cell/row/table renderer tag names. `createUiRegistry`
  returns an object that satisfies `UiRegistry` and writes to these lists,
  returning `Unregister` for each.
- `packages/renderer/src/plugin-host/api-factory.ts` — `createHostApi({
  store, events, registries, workspaceId, selfUrl })` returns a `HostApi`.
  `windows` is a minimal stub for this slice (logs + returns no-op handle);
  the real implementation lands in Phase 5.
- `packages/renderer/src/plugin-host/loader.ts` — exports
  `loadBuiltinPlugins(api)` which imports the built-in modules statically
  (`import * as csv from '../plugins/csv-import.js'`), awaits each
  `init(api)`, returns a function that calls `load(api)` on all of them
  once the app fires `app:ready`.
- `packages/renderer/src/plugins/csv-import.ts` — the plugin. Uses only
  `@easydb/shared` types and the `api` object. No `rxdb` import. No
  `document` access except through `api.ui`. Exports `meta`, `init`,
  `load` matching `PluginModule`.
- `packages/renderer/src/dialogs/new-table-dialog.ts` — Lit
  `<new-table-dialog>` custom element that replaces the `prompt()`-based
  table-creation flow. Form fields: table name; a dynamic list of column
  rows (field, label, type-`<select>`); **+ Add column** / **× remove**.
  Defaults to two rows (`name:Name:string`, `note:Note:string`). Submits
  by calling `ctx.store.tables.insert(...)` directly (no plugin contract
  needed — this is core UI). Built on the native `<dialog>` element with
  `showModal()` and a top-level escape/cancel.

### Files to modify

- `packages/renderer/src/app-context.ts` — build registries, build api,
  load built-ins during init, return both `api` and `registries` on the
  context so the shell can read the drop-handler list.
- `packages/renderer/src/chrome/app-shell.ts` — add host-level
  `dragover`/`drop` listeners in `connectedCallback`; dispatch through
  `ctx.registries.dropHandlers` after emitting `drop:files`. Replace the
  `prompt()`-based `newTable()` method with opening the
  `<new-table-dialog>` (instantiate once, append to shadow root, call
  `.open()`).
- `packages/renderer/src/chrome/table-list.ts` — empty-state message
  mentions drag-and-drop in addition to **+ New Table**.

### Verification

In the browser at `http://localhost:5190/`:

1. Reload — console shows no errors. Inspect `window`-side via
   `evaluate_script` to confirm `getContext()` resolves and the CSV
   plugin's `meta.name === 'csv-import'` is present in
   `ctx.registries.importers` and `ctx.registries.dropHandlers.length >= 1`.
2. Synthesize a drop: construct a `File` containing
   `name,age,active\nAlice,30,true\nBob,25,false\n`, wrap in
   `DataTransfer`, dispatch a `DragEvent('drop', { dataTransfer })` at
   `document.querySelector('app-shell')`. A new table appears in the
   table-list within a tick.
3. Inspect the dropped table: columns `name:string`, `age:number`,
   `active:boolean` (proves type inference). Two rows visible with
   correctly coerced values (number 30, boolean true).
4. Click **+ New Table** in the header — the `<new-table-dialog>` opens
   (no `prompt()`). Enter a table name, add/remove column rows, choose
   types from the dropdown, submit; the table appears in the list with
   the chosen columns.
5. Reload — both tables and their rows persist via IndexedDB.
6. Static checks: `npx tsc -b` clean. `grep -r "from 'rxdb'"
   packages/renderer/src/plugins/` returns nothing (proves the plugin
   doesn't bypass the abstraction).

### Out of scope for this slice (do later)

- URL-fetched plugins, Plugin Manager dialog, `cachedBody` offline cache.
- Visual drag-over overlay (the empty-state hint is enough for now).
- CSV header colon-mini-language (`field:label:type:default:max:flags`)
  — the slice infers types from data; mini-language parsing is its own
  follow-up so the plugin doesn't grow two responsibilities at once.
- JSON importer, dump exporter, other importers/renderers — separate
  slices, same pattern.
- Window manager — the table-list still renders inline cards; jsPanel-style
  windows are Phase 5.
