# @easydb/renderer

Lit web components + sqlite-wasm + Vite. The identical bundle runs in the browser
(`npm run dev:renderer`, port 5190) and inside the Electron renderer process.

## Directory layout

| Dir                  | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/chrome/`        | App-shell, panel chrome (`panel-footer`, `panel-search`), workspace selector, table list, filter popover/combobox, progress bars, material-icon-css helper. No business logic — just lays out registered slot contents. `chrome-settings.ts` is the one exception to "the `settings` plugin registers the fields": the Buttons tab has one field per registered header/footer button, which only the shell can know, so the shell registers that tab from its own snapshot. The dropdown menu moved out to **`@marccawood/lit-menu`** (`AnchoredMenu.open`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/db/`            | `data-store-bridge.ts` — the app's ONLY `DataStore` implementation, a store over an async message bridge. Two transports satisfy it: Electron's IPC to the main-process SQLite store, and `db/edb/` (postMessage to a sqlite-wasm worker) in the browser. `db/edb/substrate.ts` puts the browser's database in the `opfs-sahpool` VFS so every COMMIT is durable; `db/edb/tab-lock.ts` elects the one tab that owns it. Dexie is gone as of v0.0.383.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/dialogs/`       | App dialogs: `new-table-dialog`, `new-record-dialog` (the footer **+**; its rules live in the pure `table/new-record.ts` + `table/validate-value.ts`, which the grid's cell edit shares), `csv-paste-dialog`, `plugin-manager-dialog`, `settings-dialog`, `views-dialog` and the rest. Each one takes its chrome (`dialogChromeStyles`, `ctrlEnterSubmits`, `makeDialogDraggable`) from **`@marccawood/lit-dialogs`**, which also supplies the `host-dialogs` element for alert/prompt/confirm/choice. The toast comes from **`@marccawood/lit-toast`**. Both are published npm packages — see the root CLAUDE.md.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/db/legacy-idb/` | The pre-SQLite browser store, read-only. `read.ts` opens the old `easydb` IndexedDB database with plain IDB (Dexie is not coming back for it), `remap.ts` is the PURE re-id used when a copy has to keep both, and `legacy-store.ts` dresses the result as a `DataStore` so `db/edb/convert.ts` can copy it with no engine of its own. Driven by `plugins/legacy-import.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/events/`        | The typed event bus (`AppEvents` from shared).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/plugin-host/`   | `loader.ts` (built-in plugin list + lifecycle), `url-loader.ts` (URL-fetched plugins with localStorage cache), `registries.ts` (slot lists), `api-factory.ts` (`HostApi` constructor).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/plugins/`       | Built-in plugins. **Each one IS a plugin** — same contract as URL-loaded modules. Current roster: `new-table-button`, `csv-import`, `json-import`, `sql-import` (+ the pure `sql-parse`), `csv-export`, `dump-export`, `sql-export` (+ `projection-sql`), `gist-sync`, `server-sync` (+ `server-sync-core`), `auto-sync`, `cell-color`, `cell-image`, `cell-link`, `cell-date`, `cell-datetime`, `cell-boolean`, `cell-tags`, `cell-markdown` (+ the shared `preview-cell`), `auto-renderer`, `import-data`, `table-copy`, `sql-console` (registers nothing unless `store.sql` exists — see `docs/tech/SQL.md`), `views`, `settings`, `projection` (+ `projection-compute`, `projection-collection`, `projection-create`), `electron-db` + `sqlitefile-source` (both register nothing outside the Electron build), `edb-file` (the `.edb` file commands + the header Save button — registers nothing INSIDE the Electron build, so the two never both appear), `tips`, `new-plugins` (mentions catalog plugins never installed here, once each — see `plugin-host/plugin-catalog.ts`), `validate` (+ the pure `table/validate-rules`, `table/validate-scan`), `commandlets` (+ the pure `commandlet-lang`, `commandlet-run`), `legacy-import` (copies the pre-SQLite IndexedDB store across; registers commands but only ever acts when that database exists — see `db/legacy-idb/`). (The Plugin Manager button is **core**, not a plugin — see `app-shell.ts`. The URL-loadable demo plugins under `public/plugins/` — `header-clock`, `cell-image-url`, `cell-email` — are separate from these bundled built-ins.) |
| `src/views/`         | The **View system**: `view-render.ts` (pure token-substitution + filter/sort helpers) and the `<view-window>` element that renders one `ViewInstance` read-only. A View Template (`viewTemplates`, workspace-global) is header/row/footer HTML; blank row HTML ⇒ a read-only columns table, else the row HTML repeats per row with `$TOKEN` → column substitution. A View Instance (`viewInstances`, per-table) snapshots the table's sort/filter/visible-columns + the token→column map and opens in its own floating panel window. Managed via the footer "Views" button → `dialogs/views-dialog.ts`. **Window management is core** — see `window-mgr/view-window-manager.ts`; the `views` plugin only seeds templates and adds the button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/table/`         | `<data-table>` element. Cell rendering looks up `registries.cellRenderers` first, falls back to the built-in switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/window-mgr/`    | Core window management (behaviour, geometry, persistence, boot-restore) for ALL panels — plugins never touch the window system directly. Windows are floating panels from the in-repo `panel-shell/` module (jsPanel4 was removed in v0.0.221). `table-window-manager.ts` opens one panel per Table (geometry on `Table.windowGeometry`) and starts the canvas pan/zoom, whose handle lives in `shell-viewport.ts` so a plugin can open a panel without importing a manager; `view-window-manager.ts` opens one panel per open `ViewInstance` (geometry on `ViewInstance.windowGeometry`, driven by the `open` flag), mirroring it; maximize-fill is built into the shell; `panzoom.ts` drives the canvas transform.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/main.ts`        | App entry. Imports the shell + filter popover and lets `app-context.ts` lazy-init on first `getContext()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/app-context.ts` | Singleton that wires store + events + registries + HostApi, then drives `init()` / `load()` on built-ins and URL plugins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `public/plugins/`    | Static plugin assets served at `/plugins/*`. `catalog.json` lists what the Plugin Manager dialog offers for one-click install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Plugin host lifecycle

`app-context.ts:init()` runs once on first `getContext()`:

1. Build the `DataStore`, two ways: `window.easydb?.store` present (Electron)
   → the bridge store over IPC; else start this tab's SQLite session
   (`db/edb/session.ts`) → the same bridge store over a worker. Nothing
   downstream branches on which one won. A session that will not start is fatal
   and shows a blocking notice — there is no second store to fall back to.
2. Resolve workspace (URL `?space=` → existing → create `default`).
3. Build `HostApi` from store + events + registries.
4. `loadBuiltinPlugins(api)` — runs every `init()` synchronously, returns a
   function that runs every `load()`. A built-in is skipped if the user
   disabled it (`plugins[builtin:<name>].enabled === false`) — unless it is
   `meta.fixed`, which is never skipped.
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

## Storage is hidden from plugins

Plugins receive `DataStore` from `@easydb/shared` and never a transport. When
adding a new collection, three places in lockstep:

1. TS type in `packages/shared/src/types.ts`
2. The plugin-facing wrapper in `src/db/data-store-bridge.ts`
3. `packages/shared/src/edb-store.ts` — a collection the store doesn't know
   about **throws** there, it doesn't degrade quietly

`store.rows(tableId)` returns a _view_, but each logical table really is its own
SQL table, so `tableId` selects WHICH table rather than filtering a column.

Subscriptions re-run on a `changed` broadcast for the collection. Row changes
carry a `scope` — the table id — so a write to one table does not wake the grids
of the others; `changeScopeOf` in `@easydb/shared` is the single rule, and it
reads the scope off what the write RETURNED, because a remove or a patch request
cannot say which table it hit.

`store.sql` is an optional capability, not a collection: present only where the
transport can run raw SQL. See `docs/tech/SQL.md`.

## Row-source routing (`routed-data-store.ts`)

A table may carry an optional `source: TableSource` descriptor (in
`@easydb/shared`). When present, `createRoutedDataStore` — a thin decorator
`app-context.ts` wraps around the bridge store — routes `rows(tableId)` to the
`RowCollectionProvider` a plugin registered via `api.registerRowSource(...)`
for `source.type`, instead of the local SQL collection. Everything else on
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
  "type": "ui", // PluginType — powers the Plugin Manager "by type" filter
  "description": "...",
  "url": "./header-clock.js", // resolved against the catalog URL
}
```

Give the module a `meta.type` (`importer` | `exporter` | `cell-renderer` |
`sync` | `source` | `ui`) so it lands in the Plugin Manager's type filter; the
generator passes it straight through to the catalog.

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
3. Nothing more, if it should be user-toggleable: that is the default. The
   Plugin Manager surfaces a checkbox for it and `loader.ts` checks
   `plugins[builtin:<name>].enabled` before calling `init`. Set
   `meta.fixed = true` only for a plugin the app cannot be recovered without.

## Commandlets

`goto/bible?Book=Matthew` — one URL-shaped string that focuses a table, filters
it, searches, opens a view or runs a registered command, from a link in a cell, a
`#hash`, `?cmdlet=`, or the palette. Grammar in `plugins/commandlet-lang.ts`
(pure), effects in `plugins/commandlet-run.ts`, entry points in
`plugins/commandlets.ts`. Full reference: `docs/tech/COMMANDLETS.md`.

Two core seams exist only for it, and both have a reason a plugin cannot work
around:

- `window-mgr/windows-ready.ts` — `app:ready` fires from a microtask inside
  `app-context.init()`, but the window managers are started later by
  `chrome/table-list.ts`. A boot commandlet that waits on `app:ready` reveals a
  panel that does not exist yet. It is a promise, not an event, so a late waiter
  still resolves.
- `easydb:set-search` in `app-shell.ts` — the header box owns the global query,
  so a `search/…` commandlet tells the box rather than broadcasting
  `easydb:global-search` behind its back, which would narrow rows while the
  field still looked empty.

## Startup tips are generated

`src/plugins/tips.json` is **generated — do not hand-edit it.** The source is
`docs/help/tips.md`, where every top-level `- ` bullet is one tip;
`scripts/generate-tips.mjs` compiles it, driven by the `gen-tips` Vite plugin
(`buildStart`, plus a dev watcher on the markdown). Run it by hand with
`node scripts/generate-tips.mjs`.

A tip's id is a slug of its own text, so **editing a tip shows it again** — the
`tips` plugin keeps the ids it has already shown in the device-local setting
`tips:seen`. "Don't show again" writes `plugins[builtin:tips].enabled = false`,
the same record the Plugin Manager toggles, **and clears `tips:seen`** so
switching the plugin back on there replays the tips instead of showing nothing.
The palette command `tips:show` ("Show tip") opens the dialog on demand and,
unlike the startup tip, starts over at the first tip when all are seen. The
startup tip is suppressed under
`?test=1` (as `auto-sync` suppresses its timer) so it can't block the e2e
suite's first click; `?tips=1` forces it back on.

## Vite quirks

- Dynamic blob imports need `/* @vite-ignore */` — Vite tries to statically
  resolve all `import()` expressions otherwise.
- Dev port is **5190** (not the default 5173) to avoid colliding with the
  legacy `minniDBMax`.
- **`EASYDB_HMR=auto|ask|off`** picks what a source change does in dev, default
  `auto`. Nothing in this app calls `import.meta.hot.accept`, so `auto` always
  means a full page reload — and a reload here is not free: boot WRITES to the
  database (the workspace record, the seeded view templates), which the store's
  change broadcast turns into "unsaved changes", so the page comes back with a
  red dot on Save, no open dialogs and no window layout. `ask` keeps the
  watcher but sends the page a note instead of an update, and
  `src/dev/hmr-prompt.ts` offers a Reload button. `off` disconnects the dev
  client entirely. See the `hmr-ask-first` plugin in `vite.config.ts`.
