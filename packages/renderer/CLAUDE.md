# @easydb/renderer

Lit web components + sqlite-wasm + Vite. The identical bundle runs in the browser
(`npm run dev:renderer`, port 5190) and inside the Electron renderer process.

## Directory layout

| Dir                  | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/chrome/`        | App-shell, panel chrome (`panel-footer`, `panel-search`), workspace selector, table list, filter popover/combobox, progress bars, material-icon-css helper. No business logic — just lays out registered slot contents. `chrome-settings.ts` is the one exception to "the `settings` plugin registers the fields": the Buttons tab has one field per registered header/footer button, which only the shell can know, so the shell registers that tab from its own snapshot. The dropdown menu moved out to **`@marccawood/lit-menu`** (`AnchoredMenu.open`). `filter-picker-shell.ts` is the shared popover chrome a `registerFilterPicker` plugin (e.g. `date-filter`) builds its own funnel dropdown on top of, instead of re-implementing the popover rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/db/`            | `data-store-bridge.ts` — the app's ONLY `DataStore` implementation, a store over an async message bridge. Two transports satisfy it: Electron's IPC to the main-process SQLite store, and `db/edb/` (postMessage to a sqlite-wasm worker) in the browser. `db/edb/substrate.ts` puts the browser's database in the `opfs-sahpool` VFS so every COMMIT is durable; `db/edb/tab-lock.ts` elects the one tab that owns it. Dexie is gone as of v0.0.383. `db/edb/replicate-run.ts` + `db/edb/merge-file.ts` settle this workspace against the copy in its `.edb` table by table and row by row — rules in `@easydb/shared`'s `replicate.ts`, UI in `dialogs/merge-dialog.ts`, and see `docs/tech/EDB.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/dialogs/`       | App dialogs: `new-table-dialog`, `new-record-dialog` (the footer **+**; its rules live in the pure `table/new-record.ts` + `table/validate-value.ts`, which the grid's cell edit shares), `csv-paste-dialog`, `plugin-manager-dialog`, `settings-dialog`, `views-dialog`, `local-data-dialog` (Connect → Local Data: the workspace folder, and which `.edb` files in it this device uses — see `docs/tech/EDB.md`) and the rest. Each one takes its chrome (`dialogChromeStyles`, `ctrlEnterSubmits`, `makeDialogDraggable`) from **`@marccawood/lit-dialogs`**, which also supplies the `host-dialogs` element for alert/prompt/confirm/choice. The toast comes from **`@marccawood/lit-toast`**. Both are published npm packages — see the root CLAUDE.md.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/db/legacy-idb/` | The pre-SQLite browser store, read-only. `read.ts` opens the old `easydb` IndexedDB database with plain IDB (Dexie is not coming back for it), `remap.ts` is the PURE re-id used when a copy has to keep both, and `legacy-store.ts` dresses the result as a `DataStore` so `db/edb/convert.ts` can copy it with no engine of its own. Driven by `plugins/legacy-import.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/events/`        | The typed event bus (`AppEvents` from shared).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/plugin-host/`   | `loader.ts` (built-in plugin list + lifecycle), `url-loader.ts` (URL-fetched plugins with localStorage cache), `registries.ts` (slot lists), `api-factory.ts` (`HostApi` constructor).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/plugins/`       | Built-in plugins. **Each one IS a plugin** — same contract as URL-loaded modules. Current roster: `new-table-button`, `csv-import`, `json-import`, `sql-import` (+ the pure `sql-parse`), `csv-export`, `dump-export`, `sql-export` (+ `projection-sql`), `gist-sync`, `cell-color`, `cell-image`, `cell-link`, `cell-date`, `cell-datetime`, `cell-boolean`, `cell-tags`, `cell-markdown` (+ the shared `preview-cell`), `auto-renderer`, `import-data`, `table-copy`, `sql-console` (registers nothing unless `store.sql` exists — see `docs/tech/SQL.md`), `views` (+ the DOM-free `views-seed`, which reconciles the four built-in templates and must write NOTHING when there is nothing to do — see below), `settings`, `projection` (+ `projection-compute`, `projection-collection`, `projection-create`), `electron-db` (+ `electron-folder`, the workspace folder) and `sqlitefile-source` (all register nothing outside the desktop build), `edb-file` (the `.edb` file commands + the header Save button — registers nothing INSIDE the desktop build, so the two never both appear), `tips`, `new-plugins` (mentions catalog plugins never installed here, once each — see `plugin-host/plugin-catalog.ts`), `validate` (+ the pure `table/validate-rules`, `table/validate-scan`), `run-scripts` (owns the footer's ▶ **Run** button and runs every column's render script over the rows, via the same `table/materialize-script` the script editor's Run uses; `validate` puts its own item on that button's menu through `table/run-actions.ts`, and `dialogs/run-picker-dialog.ts` asks both halves which columns and which rows), `commandlets` (+ the pure `commandlet-lang`, `commandlet-run`, `commandlet-edit`), `edit-record` (double-click a row to open it in the record form — a plugin so the double-click can be given back to the cell editors), `legacy-import` (copies the pre-SQLite IndexedDB store across; registers commands but only ever acts when that database exists — see `db/legacy-idb/`). `viz-record` (the `record` visualization — one row of the grid, tokens that are column names, editable with `$input.field`; offers the record WINDOW and shares the row double-click with `edit-record`), `date-filter` (a `registerFilterPicker` for `date` columns — presets plus a from/to range, built on `chrome/filter-picker-shell.ts`) + the pure `date-presets` (parses the `date-filter:presets` setting into labelled rows). (The Plugin Manager button is **core**, not a plugin — see `app-shell.ts`. The URL-loadable demo plugins under `public/plugins/` — `header-clock`, `cell-image-url`, `cell-email` — are separate from these bundled built-ins.) |
| `src/views/`         | The **View system**: `view-render.ts` (pure token-substitution + filter/sort helpers) and the `<view-window>` element that renders one `ViewInstance` read-only. A View Template (`viewTemplates`, workspace-global) is header/row/footer HTML; blank row HTML ⇒ a read-only columns table, else the row HTML repeats per row with `$TOKEN` → column substitution. A View Instance (`viewInstances`, per-table) snapshots the table's sort/filter/visible-columns + the token→column map and opens in its own floating panel window. Managed via the footer "Views" button → `dialogs/views-dialog.ts`. **Window management is core** — see `window-mgr/view-window-manager.ts`; the `views` plugin only seeds templates and adds the button.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/table/`         | `<data-table>` element. Cell rendering looks up `registries.cellRenderers` first, falls back to the built-in switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/window-mgr/`    | Core window management (behaviour, geometry, persistence, boot-restore) for ALL panels — plugins never touch the window system directly. Windows are floating panels from the in-repo `panel-shell/` module (jsPanel4 was removed in v0.0.221). `table-window-manager.ts` opens one panel per Table (geometry on `Table.windowGeometry`) and starts the canvas pan/zoom, whose handle lives in `shell-viewport.ts` so a plugin can open a panel without importing a manager; `view-window-manager.ts` opens one panel per open `ViewInstance` (geometry on `ViewInstance.windowGeometry`, driven by the `open` flag), mirroring it; maximize-fill is built into the shell; `panzoom.ts` drives the canvas transform.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/pwa/`           | `register-sw.ts` — the page's half of the service worker that makes the hosted build load with no internet: registration scoped to `import.meta.env.BASE_URL`, the "a new version is ready" bar (prompt, never a silent takeover), and the `?nosw=1` kill switch. Self-gating on `import.meta.env.PROD` and on `location.protocol`, so dev and the Electron `file:` page fall straight through. The worker itself is generated at build time — see the Vite quirks below and `docs/tech/OFFLINE.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/main.ts`        | App entry. Imports the shell + filter popover, registers the service worker, and lets `app-context.ts` lazy-init on first `getContext()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/app-context.ts` | Singleton that wires store + events + registries + HostApi, then drives `init()` / `load()` on built-ins and URL plugins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `public/plugins/`    | Static plugin assets served at `/plugins/*`. `catalog.json` lists what the Plugin Manager dialog offers for one-click install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

## A boot must not write

Every write the store takes is broadcast, and `edb-file.ts` turns that broadcast
into "unsaved changes" — the red dot on the header Save button. So anything that
runs on every load has to be READ-ONLY when it has nothing to do, or a plain
reload comes back claiming there is work to save.

This has cost one bug already. `plugins/views-seed.ts` re-recorded the
`views:seeded:<slug>:<workspace>` mark for each of its four built-in templates on
every load, whether or not it was already recorded. Four no-op upserts, and a
freshly saved workspace came back dirty from a refresh. Nothing else in a plain
boot writes at all, which is what made those four the whole bug.

If you add something that runs at load: read before you write, and re-write only
what actually changed. `test/renderer/plugins/views-seed.test.ts` holds that rule
down for the seeder by counting writes.

## Which protocols may be links: one rule, three readers

`util/url-schemes.ts` is the only answer to "may this be a link". Three places
ask it and none may hold its own copy: `safeUrl` in `util/sanitize-html.ts`
(markdown, HTML cells, view templates), `detectLink` in `plugins/link-detect.ts`
(the Link renderer and `auto-renderer`'s column guess), and the bare-URL pass in
`util/markdown.ts`. They disagreed once — the sanitizer kept an allow-list of
http/https/mailto/tel while the Link renderer allowed any scheme that does not
execute — and the visible bug was a `file:///` path that was a link in one column
and plain text in another.

Since v0.0.452 the rule is a SETTING, `links:protocols`: a list is an
allow-list, the same list behind `!` is a deny-list, default
`!javascript,vbscript,data`. Two consequences worth knowing before touching it:

- **The policy is module state, set once at boot.** Every reader is a sync pure
  function called mid-paint, and `api.settings.get` is async. `util/link-settings.ts`
  resolves it and re-resolves on `easydb:settings-changed`; a test that changes it
  must put it back (`setProtocolPolicy(null)`).
- **It is device-local (`scope: 'user'`), not workspace.** On the workspace layer
  it would travel inside a shared `.edb`, so opening someone else's workspace
  could widen your own rules.

A `file:///` link is refused by the BROWSER, not by us, and it answers by opening
a blank tab (`about:blank#blocked`) with no explanation. `util/file-link-guard.ts`
is one capture-phase listener on `document` that catches the click first and puts
the path on the clipboard. It covers all four renderers at once because
`composedPath()` reaches into their shadow roots, and it stands aside in the
desktop build, whose own page is `file:`.

## A record pane is a visualization, and its tokens are field names

`plugins/viz-record.ts` draws ONE row beside the grid. Two things about it are
load-bearing and neither is obvious:

- **A token IS a column name.** A view template's `$TOKEN` is a mapping key —
  `ViewInstance.mapping` says which column it reads — because one global
  template serves many tables. A record layout is written against one table, so
  `views/record-html.ts` hands `substituteRow` an IDENTITY mapping and the token
  becomes the field. **Nothing in `view-render.ts` changed**: every prefix,
  every renderer slot and every `$input` control behaves exactly as in a view.
  Do not add a second token grammar here.
- **Selecting is not filtering.** `table/current-row.ts` is a separate seam from
  `table/pane-actions.ts`. A record pane COULD have read `rows[0]` and let the
  double-click narrow the host grid to one row — no new module — but that throws
  away the filter the user is working in every time they look at a record.

`table/current-row.ts` is the twin of `table/visible-rows.ts`: push for updates,
pull for the first value, a plain registry so it is testable with no DOM. One
extra rule — **a registered provider's answer wins, `null` included**. The grid
is the only thing that knows whether the remembered row is still on screen, so
its `null` is a veto and the pane falls back to the first visible row.

### Three plugins want the double-click. They are asked in order.

`plugins/edit-record.ts` owns the listener and hands the gesture on:

1. a **docked pane** — `currentRowWanted(key)` (`table/current-row.ts`),
2. the **record window** — `openRecordPopup()` (`plugins/record-popup.ts`),
3. the **record form**, which needs nothing else loaded.

Both hand-offs are registries holding one function, for the same reason: no two
of the three plugins may import each other, so each can be switched off alone.
`plugins/record-popup.ts` is deliberately three lines of state with no store and
no DOM — `plugins/record-window.ts` is what it opens, loaded on demand, and that
module has no business in the graph of a document-wide listener.

The window is `<viz-record>` again, given one row, with the table's own record
layout (`recordLayoutFor`) or a generated editable card. Its panel id is
`easydb-record-<tableId>-<rowId>`, which is what makes it **one window per row**
rather than one per double-click, and nothing about it is persisted.

**`commandlet-run.ts` reaches `current-row.ts` and `record-popup.ts` through
DYNAMIC imports**, on purpose. That module is pulled in by the document-wide
click handler every cell link goes through; a static import there made
`89-commandlets.spec.ts` fail in the full file while passing alone.

## `_` — what a row knows about itself

Everything user-authored is handed `row.data`, never the `Row`: a column
script's `row` IS the data object, a cell renderer's `.row` is the data object,
a template token is a key of it. So the record's own id — the one thing needed
to link back to it — was the one thing user code could not see.

`views/row-meta.ts` adds one key:

```
script / renderer:   row._.rowId   row._.tableId   row._.updatedAt   row._.updated
template:            $_.rowId      $_.tableId      $_.updatedAt      $_.updated
```

Four rules, each of which has a failure mode behind it:

- **`withRowMeta` is memoized per `Row`** (a `WeakMap`). A cell renderer takes
  `.row` as a Lit property and redraws when the reference changes, so a fresh
  object per call would redraw every renderer in the grid on every render.
- **`row.data` is spread AFTER `_`**, so a table that really has a column called
  `_` keeps it. Shadowing a user's own column would break a working script with
  nothing on screen to say why.
- **It is never written back.** A patch is built from the stored `Row`
  (`patchFor`, `commitCell`), so `_` cannot become a column.
- **`$_.KEY` is the FIRST alternative in `TOKEN_RE`**, or the general form would
  read it as the token `_` plus the literal text `.rowId`. It is not returned by
  `extractTokens`: metadata is not a column, so it must never appear in the
  mapping dialog asking to be pointed at one. Nothing existing can break, because
  the general form never resolved `_` to anything.

Every place that hands a row to user code goes through it — `view-render`,
`data-table`, `viz-record`, `view-window`, `viz-panel`, `column-preview`,
`materialize-script`, `export-rows`, `column-preview-table`. A new one must too,
or a script will behave differently depending on where it runs.

**`record/<table>/<rowId>` is what accepts it.** The metadata would be visible
and useless without a verb that takes an id — every other way of naming a record
goes through `keyColumnOf`, which is a convention, not a uniqueness guarantee.
See `docs/tech/COMMANDLETS.md`.

## The script editor answers two questions the column editor already could

Both are in `dialogs/script-editor-dialog.ts`, and both exist because the
information was already on screen two inches away:

- **Is this script broken?** `checkScriptOnRows` (in `table/column-preview.ts`,
  beside the preview that runs the same scripts) tries the text on the rows the
  columns editor is previewing, on every keystroke. The COUNT is the diagnosis
  and the warning says it: all of them is a wrong script, one of them is a row
  with a surprise in it. A compile error counts with no rows at all; a runtime
  error on an empty object does not — `row.first.trim()` throwing on `{}` says
  nothing about a table where `first` is always filled in.
- **Can I run it yet?** A column typed but not saved has nowhere to write, and
  the old answer was "close, save, reopen, press Run". The columns editor now
  passes a `commit` callback: it patches the script onto the draft column and
  runs its OWN save — the whole draft, not one column, because a second write
  path would grow its own rules about renames and constraints and drift from the
  first. `adoptSaved` then re-bases the draft on what was written, so the dialog
  can stay open without trying to apply the same renames twice.

## A workspace is an id and a title, and only the id identifies

`id` IS the file name (`sales` ⇄ `sales.edb`): unique, not editable, what
`?space=` routes on and what keys every setting, view and table. `title` is free
text the user edits, may repeat, and nothing is derived from it — every screen
falls back to the id when there is none (`workspaceLabel`).

There was a third field until v0.0.506. `name` was minted from the same slug as
the id and shown wherever a title was absent, and nothing kept the three in step:
the list said "PowerPlants", the file said `powerplants.edb`, and deleting it
asked about "Simon". What used to turn on `name` turns on `id` now —
`workspaceLabel`'s fallback, `folderConflicts`' matching, the delete prompt's
qualifier — and `FolderClash` lost its second id, because both sides of a clash
are the same id by construction.

Two consequences worth knowing before touching this:

- **The rule is enforced by the STORE** (`@easydb/shared`'s
  `EdbStore.guardWorkspaceWrite`), not here. A workspace write with a
  non-canonical id, or into a `.edb` named after a different workspace, throws.
  `mayCreateWorkspaceIn` in `space-resolve.ts` is still checked at boot and in
  New workspace — it asks the same question earlier, where there is a better
  answer than an exception.
- **What the user types at New workspace becomes the TITLE**, and the id is its
  slug: "Power Plants" → `power-plants.edb`, titled "Power Plants". The typed text
  used to become `name`, which is why the list showed it.

## One folder feature, two builds

Connect ▸ Local Data, the workspace selector's list of other files, and New
workspace ▸ Advanced are ONE feature with two implementations. Do not let them
drift into two.

The thing that makes this cheap is `db/edb/folder-index.ts`: the selector never
reads a folder, it reads a device-local CACHE of one in `localStorage`, which is
plain data. The browser fills it from a `FileSystemDirectoryHandle`
(`plugins/edb-file.ts`); the desktop fills it from the main process
(`plugins/electron-folder.ts`). `dialogs/local-data-dialog.ts` is shared, and it
may not test for a browser API to decide what it can do — the desktop would fail
that test while being perfectly able. It asks its `LocalDataActions` instead.

Exactly three questions differ, and all three go through
`db/file-workspaces.ts`:

| Question                    | Browser                                   | Desktop                                                   |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Which file is open?         | `session.ts`'s `localStorage` marker      | the main process's path, cached by `setBackendActiveFile` |
| How is another opened?      | adopt the handle, reload with `?space=`   | `openDbCommit`, and the main process reloads              |
| Where does a new `.edb` go? | the folder handle, written by sqlite-wasm | the folder path, written by `node:sqlite`                 |

`setBackendActiveFile` is deliberately NOT `session.ts`'s marker. That marker
also tells the browser's boot which database in the OPFS pool to open and
whether a workspace may be created in it (`mayCreateWorkspaceIn`) — a desktop
file name in it would answer a question the desktop never asks.

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
it, searches, opens a view, opens a record for editing or runs a registered
command, from a link in a cell, a `#hash`, `?cmdlet=`, or the palette. Grammar in
`plugins/commandlet-lang.ts` (pure), effects in `plugins/commandlet-run.ts`,
entry points in `plugins/commandlets.ts`. Full reference:
`docs/tech/COMMANDLETS.md`.

`edit/<table>/<key>` opens `dialogs/new-record-dialog.ts` over an existing row —
the SAME form as the table's **+** button, in one of three modes (new / edit /
read-only view). The form reads `Table.readonly` itself, so no caller can talk it
into editing a read-only table. `plugins/edit-record.ts` opens the same form on a
double-click, and is a plugin precisely so that double-click can be given back to
the cell editors by switching it off.

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
startup tip is suppressed under `?test=1` so it can't block the e2e suite's
first click; `?tips=1` forces it back on.

## Vite quirks

- Dynamic blob imports need `/* @vite-ignore */` — Vite tries to statically
  resolve all `import()` expressions otherwise.
- **`gen-service-worker` writes `dist/sw.js`** from `scripts/sw-template.js` +
  `scripts/generate-sw.mjs`. Three gates, each load-bearing: `apply: 'build'`
  (a precache in dev would serve yesterday's bundle), `closeBundle` rather than
  `writeBundle` (Vite copies `public/` in AFTER the rollup bundle is written, so
  it is the first hook that can see the manifest, the favicon and `plugins/*` —
  which is also why the list comes from walking the outDir, not from the rollup
  bundle object), and a bail when `base` is `./` (that is `build:electron`,
  whose page is `file:`, where a worker cannot register). See
  `docs/tech/OFFLINE.md`.
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
