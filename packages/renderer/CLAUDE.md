# @easydb/renderer

Lit web components + Dexie + Vite. The identical bundle runs in the browser
(`npm run dev:renderer`, port 5190) and inside the Electron renderer process.

## Directory layout

| Dir | Role |
|---|---|
| `src/chrome/` | App-shell, panel chrome (`panel-footer`, `panel-search`), workspace selector, table list, filter popover/combobox, material-icon-css helper. No business logic — just lays out registered slot contents. |
| `src/db/` | Dexie setup (`dexie-db.ts`) and the `DataStore` wrapper (`data-store-dexie.ts`) that hides Dexie from plugins. |
| `src/dialogs/` | Promise-returning host dialogs (`host-dialogs.ts` — alert/prompt/confirm/choice), `toast-host.ts`, `new-table-dialog`, `csv-paste-dialog`, `plugin-manager-dialog`, `draggable.ts` helper. |
| `src/events/` | The typed event bus (`AppEvents` from shared). |
| `src/plugin-host/` | `loader.ts` (built-in plugin list + lifecycle), `url-loader.ts` (URL-fetched plugins with localStorage cache), `registries.ts` (slot lists), `api-factory.ts` (`HostApi` constructor). |
| `src/plugins/` | Built-in plugins. **Each one IS a plugin** — same contract as URL-loaded modules. Current roster: `new-table-button`, `plugin-manager-button`, `csv-import`, `json-import`, `csv-export`, `dump-export`, `sql-export`, `gist-sync`, `server-sync` (+ `server-sync-core`), `auto-sync`, `cell-color`, `cell-image`, `import-data`, `views`. (The URL-loadable demo plugins under `public/plugins/` — `header-clock`, `cell-image-url`, `cell-email` — are separate from these bundled built-ins.) |
| `src/views/` | The **View system**: `view-render.ts` (pure token-substitution + filter/sort helpers) and the `<view-window>` element that renders one `ViewInstance` read-only. A View Template (`viewTemplates`, workspace-global) is header/row/footer HTML; blank row HTML ⇒ a read-only columns table, else the row HTML repeats per row with `$TOKEN` → column substitution. A View Instance (`viewInstances`, per-table) snapshots the table's sort/filter/visible-columns + the token→column map and opens in its own jsPanel window. Managed via the footer "Views" button → `dialogs/views-dialog.ts`. **Window management is core** — see `window-mgr/view-window-manager.ts`; the `views` plugin only seeds templates and adds the button. |
| `src/table/` | `<data-table>` element. Cell rendering looks up `registries.cellRenderers` first, falls back to the built-in switch. |
| `src/window-mgr/` | Core window management (behaviour, geometry, persistence, boot-restore) for ALL panels — plugins never touch jsPanel directly. `jspanel-manager.ts` opens a jsPanel per Table (geometry on `Table.windowGeometry`) and owns the canvas pan/zoom; `view-window-manager.ts` opens a jsPanel per open `ViewInstance` (geometry on `ViewInstance.windowGeometry`, driven by the `open` flag), mirroring it; `maximize-fill.ts` is the shared counter-transform that keeps a maximized panel filling the visible area through canvas pan/zoom; `panzoom.ts` drives the transform. |
| `src/main.ts` | App entry. Imports the shell + filter popover and lets `app-context.ts` lazy-init on first `getContext()`. |
| `src/app-context.ts` | Singleton that wires store + events + registries + HostApi, then drives `init()` / `load()` on built-ins and URL plugins. |
| `public/plugins/` | Static plugin assets served at `/plugins/*`. `catalog.json` lists what the Plugin Manager dialog offers for one-click install. |

## Plugin host lifecycle

`app-context.ts:init()` runs once on first `getContext()`:

1. Open Dexie → wrap in `DataStore`.
2. Resolve workspace (URL `?space=` → existing → create `default`).
3. Build `HostApi` from store + events + registries.
4. `loadBuiltinPlugins(api)` — runs every `init()` synchronously, returns a
   function that runs every `load()`. Optional built-ins
   (`meta.optional === true`) are skipped if the user disabled them via
   `plugins[builtin:<name>].enabled === false`.
5. `loadUrlPlugins(api)` — iterates `workspace.pluginUrls`, fetches each,
   wraps in a Blob URL, dynamic-imports, calls `init()`.
6. `queueMicrotask` → emit `app:ready` → run all queued `load()`s.

The `app:ready` event re-fires when a plugin is hot-installed from the Plugin
Manager. Components that snapshot registries (app-shell, panel-footer,
data-table) re-snapshot on that event — see "Hot-loading" below.

## Hot-loading plugins

The Plugin Manager dialog's "Available from this host" section installs a
catalog plugin without a page reload. The flow mirrors `url-loader.ts`:
fetch → cache body → patch `workspace.pluginUrls` → Blob URL → dynamic
`import()` → `init()` + `load()` → re-emit `app:ready`. Components that
listen for `app:ready` re-snapshot their registry slices, so new
header/footer/table buttons and cell renderers appear immediately.

This works because slot registries (`headerButtons`, etc.) are append-only
arrays — adding never invalidates existing entries. Removing a plugin still
requires a reload because the registry contract has no `unregister` story.

## Dexie is hidden from plugins

Plugins must never import from `dexie`. They receive `DataStore` from
`@easydb/shared`, which is satisfied by `data-store-dexie.ts`. When adding a
new collection:

1. TS type in `packages/shared/src/types.ts`
2. Dexie schema + typed accessor in `src/db/dexie-db.ts`
3. Plugin-facing wrapper in `src/db/data-store-dexie.ts`

`store.rows(tableId)` returns a *view* over the single `rows` Dexie table —
`tableId` is auto-injected on insert and used as the `where('tableId').equals(...)`
filter on queries. There is **not** one Dexie table per logical row table.

Subscriptions use Dexie's `liveQuery` — the closure re-runs whenever any
write hits the underlying table. Chrome callers always consume the full
result set, so the broader re-run granularity is harmless.

## Row-source routing (`routed-data-store.ts`)

A table may carry an optional `source: TableSource` descriptor (in
`@easydb/shared`). When present, `createRoutedDataStore` — a thin decorator
`app-context.ts` wraps around the Dexie store — routes `rows(tableId)` to the
`RowCollectionProvider` a plugin registered via `api.registerRowSource(...)`
for `source.type`, instead of the local Dexie collection. Everything else on
the store passes straight through.

**The routing is a strict no-op for local tables.** A table with no `source`,
a `source.type` with no registered provider, or one not yet in the sync-primed
`tableCache`, all resolve to `base.rows(tableId)` — identical to the
un-decorated store. `data-table.ts` and every other `store.rows(...)` caller
are untouched. This is the one contained core seam for the live-Datasette
connector (design: the `eda-datasette-integration` plan); the actual remote
`DataCollection` provider is a later phase.

## Lit + decorator gotcha

`tsconfig.json` sets `"useDefineForClassFields": false` and
`"experimentalDecorators": true`. Lit's `@property` / `@state` need this; the
shared, server, and electron packages keep TS defaults. Don't touch this
config without rewriting every Lit component to use `declare`.

Lifecycle methods (`connectedCallback`, `disconnectedCallback`, `updated`,
`render`, `static styles`) need `override` because `noImplicitOverride` is
on in `tsconfig.base.json`.

## The `public/plugins/` catalog

`public/plugins/catalog.json` is **generated — do not hand-edit it.**
`scripts/generate-plugin-catalog.mjs` scans `public/plugins/*.js`, reads each
module's exported `meta`, and rewrites the catalog. It runs automatically on
every dev-start and build via the `gen-plugin-catalog` Vite plugin in
`vite.config.ts` (`buildStart`), and can be run manually with
`node scripts/generate-plugin-catalog.mjs`. To add a catalog plugin, just drop
a self-contained `.js` (exporting `meta`) into `public/plugins/` — the catalog
follows. Give the module `meta.title` for a nice display name (else the id is
title-cased). `public/plugins/catalog.json` is what the Plugin Manager fetches
on open. Each generated entry:

```jsonc
{
  "id": "header-clock",
  "name": "Header Clock",
  "description": "...",
  "url": "./header-clock.js"   // resolved against the catalog URL
}
```

Vite serves `public/` at root, so the resolved absolute URL becomes
`http://localhost:5190/plugins/header-clock.js` in dev (or the GH-pages
equivalent in prod). That URL goes into `workspace.pluginUrls` so it
re-loads on every boot via `url-loader.ts`.

Plugin `.js` files in `public/plugins/` are loaded via Blob URL dynamic
import — they **cannot** use bare imports like `import x from 'lit'`.
Self-contained ES modules only.

## Adding a built-in plugin

1. Drop a `src/plugins/<name>.ts` exporting `meta`, `init(api)`, optionally `load(api)`.
2. Import + add to the `builtins` array in `src/plugin-host/loader.ts`.
3. If user-toggleable: set `meta.optional = true`. The dialog's "Optional
   built-ins" section will surface a checkbox, and `loader.ts` will check
   `plugins[builtin:<name>].enabled` before calling `init`.

## Vite quirks

- Dynamic blob imports need `/* @vite-ignore */` — Vite tries to statically
  resolve all `import()` expressions otherwise.
- Dev port is **5190** (not the default 5173) to avoid colliding with the
  legacy `minniDBMax`.
