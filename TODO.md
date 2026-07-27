# Instructions

- Read instructions in .claude\CLAUDE.md
- Read and write only to this central TODO.md at C:\projects\Marc\easyDBAccess\TODO.md (not your worktree version)
- Run a loop to process one task at a time:
  - Merge in main
  - Read an unmarked TODO from the Backlog below, don't take a task marked 🕜
  - Move it to in-progress and mark it with 🕜
  - If you are not already on a worktree, create a todos[1..9] branch and worktree and switch to that
  - Begin implementing and ask questions if anything is unclear
  - Once a task is implemented, show the user the full dev URL link (with http://), ask the user if they are happy explaining what was done and how to test it in a short summary of one paragraph and 60 words or less
  - Once the user accepts it, mark as done ✅ and move to DONE
  - Commit (Don't put TODO or claim in the commit message, just the original task text)
  - Bump version using scripts/
  - Write a CHANGELOG.md entry
  - merge into main
  - Always update your worktrees TODO and the file C:\projects\Marc\easyDBAccess\TODO.md so I can watch live changes

Status keys: `bug` = broken, `feature` = missing, Leading `✅` = done.
`✅✅` = done with e2e test coverage.

## Backlog

- Close window should no longer delete the table/view but just hide it, it can be recalled from the command palette. Add a delete icon to the table header via a delete-table plugin.
- bug: When I add a field to an imported table and push/pull the dest should have this new field - remember the schema the user adapted, deleted columns, order etc and restore it when refreshing
- Dialogs with choices should make the first choice the default, primary color button and respond to enter
- Desktop client should offer load and save to Sqlite .db file in the File menu
- Feature: Importers are too interwoven, they should be separate plugins with separate dialogs and have the meta.type=='importer'. The core import-data plugin provides a header import button with AnchoredMenu for each of the import plugins (Dump, JSON, CSV, Datasette, SQL, Parquet). Each plugin brings it's own dialog. All importers should support URL or File upload as well as a row limit and an option to edit columns before import. Write a plan for this before implementing anything.

## Parked

- ⏸️ (parked) When connecting datasette add "virtual" tables for big tables (lazy server-side windowed paging). Design written + approved-in-progress: `.claude/plans/2026-07-26-datasette-virtual-tables-design.md` (scoped to virtual only; no-persist dropped).

## In progress

- 🕜 Gist synch should not exclude any settings (today, gist: prefix explicitly excluded) because we have moved secrets to the secrets.txt file, also allow a download of this file from the settings dialog
- 🕜 Add info to the table info dialog about whether the table was imported or connected and what this means

## DONE

- ✅ Feature: Command palette launches when I press Ctrl+K for doing things like managing windows (close all, minimize all etc.) navigating to a table, importing, creating, exporting etc. Plugins should register commands. — core Ctrl+K palette (`command-palette-dialog.ts`) aggregating registered commands + header/footer buttons + per-table "Go to"; built-in Windows commands (min/restore/max/cascade/tile/close all via `window-commands.ts`) and App commands (Search/Plugins/Changelog/Docs); new `api.ui.registerCommand`. Docs in `docs/COMMANDS.md`.

- ✅ Adding a ! prefix to a filter does a NOT (in particular a NULL/empty boolean should appear when I filter !true), the special character NULL filters nulls and !NULL — new pure `matchesColumnFilter` helper (unit-tested) wired into the grid, faceted dropdowns and view windows: `!text` negates a substring match (so `!true` also surfaces null/empty cells), `NULL` matches blank/empty/whitespace cells, `!NULL` matches cells with any value. Filter dropdown gained an italicized *(Blanks)* entry (folds null/empty/whitespace into one row with its count) and a top **hide** checkbox that negates the picked value (pre-checks when the active filter is a `!` negation); a hover tooltip documents the syntax. Browser-verified the dropdown resolves `NULL`/`!NULL`/`!value` correctly.

- ✅ Gist-Synch: Should not push-pull data of remote (e.g. datasette) tables - only the definition (columns) — Gist now treats any table with a live `source` (Datasette or any registered backend, not datasette-specific) as "remote": push writes its columns/layout/`source` but `"rows": []` (never fetches or uploads the live rows), and pull restores the definition + `source` so the table reconnects to its backend instead of wiping/replacing rows. Local tables and `origin`-only import snapshots keep syncing rows as before. No credentials travel (tokens stay in settings). Typecheck + clean-load verified; full round-trip needs a live gist token (user-side).

- ✅ Create a new html cell-renderer which pops up the html in a new window — new built-in `cell-html` plugin registers an `html` cell renderer: a column set to renderer `html` shows its value as real (unescaped) HTML inline, clipped to one line; clicking the cell opens the full HTML in its own draggable/resizable jsPanel window titled with the column label. Read-only, mirrors `cell-link`. Headless-verified (inline render + click-to-popup).

- ✅ Gist-Synch: Add option to push/pull data only and settings only — the Gist footer menu's Push and Pull items now open a scope sub-menu (Everything / Data only (tables + rows) / Settings only (views + settings)). "Data only" writes/reads just the per-table `.table.json` files and leaves the `_easydb.workspace.json` marker untouched; "Settings only" writes/reads just the marker (viewTemplates/viewInstances/settings). Scope-aware toasts on both paths. Browser-verified the two-step menu wiring.

- ✅ Remove gist settings own dialog, we have this in global settings now — dropped the "Settings" item from the Gist footer menu and deleted the connection-string `openSettings`/prompt; gist credentials live only in Settings → Gist Sync now. Push/pull with no credentials toasts and opens the global Settings dialog instead of prompting. (`parseConnectionString` kept for the `#gist=` share-link boot path.)

- ✅ bug: I was able to import simon-blog/entries from datasette.io AND connect it, table names should be unique — Datasette connect now detects a name clash with a different table (e.g. an earlier import snapshot) and prompts Overwrite / Rename / Skip instead of silently creating a duplicate; reconnecting to the same live source still reuses its window silently. Both connect and import name checks are case-insensitive, so names stay unique across every creation path.

- ✅ settings should be a fixed plugin, plugin manager should hide fixed plugins by default, installed filter shows nothing it should show installed plugins — `settings` plugin now `meta.fixed = true` (always-on, no toggle); the Plugin Manager hides `fixed` rows unless the "Fixed" filter is explicitly on; built-ins now carry the `installed` category so the "Installed" filter lists them instead of showing nothing. Browser-verified.

- ✅ bug: when I pull in a json dump I expect the windows to have the geometry and also the views — JSON dump (`serializeWorkspace`) now carries `viewTemplates` + `viewInstances` and richer per-table state (title/filters/labelColumn/info/deletedColumns alongside geometry/sort); `json-import` restores them (instances re-pointed to the freshly-imported table id by name) and dispatches `easydb:restack-windows` so z-order/geometry apply as a batch — matching the gist pull path. Unit-covered (native-dump enrichment) + browser round-trip verified.

- ✅ bug: when I pull in a gist I expect the windows to have the geometry set in the gist — `tableToFile` now syncs full per-table state (view/window geometry/sort/filters/label/deleted-columns/info), restored on pull; z-order restored via an `easydb:restack-windows` event (re-fronts panels by saved z after a bulk pull); made front-rank `z` a monotonic unique counter (Date.now() collisions were tying z and losing stacking order); pull toast no longer shows the gist id. (Minimized restores correctly in a headless 4-table repro of the reported gist; couldn't reproduce the reported minimized swap.)

- ✅ share workspace link should be presented as an html link we can click on in addition to the copy/input — `gist-share-dialog.ts` now renders the link as a clickable, ellipsized `<a target="_blank">` above the existing readonly input + Copy button.

- ✅ plugin-manager-button.ts should not be a plugin but a core feature and a small icon-only secondary button in the top-right (left of settings)
- ✅ feature: Gist push/pull should sync the entire workspace, not just tables — include view templates, view instances, and settings (currently `gist-sync.ts` only serializes `api.store.tables` + rows; `viewTemplates`/`viewInstances`/`settings` are never pushed or pulled, so views and plugin config don't survive a Gist round-trip to another device)

- ✅ When clicking on the version in the header launch the CHANGELOG.md URL on github (version span wrapped in an `<a>` to `github.com/cawoodm/easydbaccess/blob/main/CHANGELOG.md`, opens in a new tab; inner `<span class="version">` kept so the bump script still rewrites it).

- ✅✅ In every dialog, Ctrl+Enter confirms (primary action) and Esc closes — audited all 13 dialogs. `settings-dialog.ts`, `table-info-dialog.ts`, `gist-share-dialog.ts`, `views-dialog.ts` had no form/Ctrl+Enter wiring (Settings' Done button, specifically named, didn't confirm on Ctrl+Enter); `table-select-dialog.ts` had the form but not the keydown hook. Wrapped each in a `<form>` with the primary action as `type="submit"` and `@keydown=${ctrlEnterSubmits}` on the `<dialog>`; fixed several now-in-a-form `<button>`s in `views-dialog.ts`'s list mode that lacked an explicit `type="button"` and would otherwise have submitted the form on click. Esc already closes every dialog via native `<dialog>`/`cancel` handling — no change needed there.

- ✅✅ Allow user to edit title of the workspace in settings and display this in the header instead of easyDBAccess — `Workspace.title` (optional, display-only; `id`/`name` stay technical), a "Workspace title" field on the Settings → General tab, header shows `title || 'easyDBAccess'` live via a `workspaces.subscribe()`. Covered by `e2e/35-workspace-title.spec.ts` (2 tests).

- ✅ When creating a new view, auto map fields (URL-like fields to URL, date-like fields to date, long fields to DESCRIPTION) - also allow a view to specify TOP N rows. (`autoMap` now guesses date/url/description tokens by column type/renderer/name; new optional `ViewInstance.limit` + "Show at most (rows)" input in the view dialog, applied in `recompute()`. Also covers the "limit rows in view" backlog item.)

- ✅ Implement settings dialog (v0.0.106): tabbed dialog (General + one tab per plugin) via `api.ui.registerSettings`; `api.settings` two-layer store (workspace-synced / user device-local) with per-field promote/demote; secrets store with `${secret:name}` interpolation + drag-in `secrets.txt` import (overwrite prompt + toast); header gear button (secondary, icon-only, top-right); server-sync + gist-sync migrated. Merged to main + published.

- ✅ feature: The Gist Synch plugin should register a single footer button not 2 — one "Gist" button (GitHub icon) opens a menu: push / pull / settings / share / view gist. Share generates a `#hash` link with the base64 connection string (loaded on boot into the workspace). Added a per-table gist button (push/pull/view that table's file), a reusable anchored-menu, and consolidated the Export (JSON+SQL) and Sync (push/pull) footer buttons too.

- ✅ feature: plugins registry (`.json`) so users can browse and install plugins. `public/plugins/catalog.json` is now auto-generated from each plugin `.js` module's exported `meta` by `scripts/generate-plugin-catalog.mjs`, wired into `vite.config.ts` (`buildStart`) so it regenerates on every dev-start/build/publish — no more hand-maintenance. (Base-URL fetch fix landed earlier.)
- ✅ Bug: When pulling the Simon workspace the gist pull failed on a truncated file. Fixed: pull fetches GitHub-truncated files via `raw_url`, continues past a failing table and reports which file failed, and shows a progress bar. Push now warns on tables >10 MB (slow/flaky) and >100 MB (rejected) with advice to trim columns/rows or mark no-sync.

- ✅ Bug: when connecting a datasette.io instance which fails with table not found, the table is still created empty. The dialog should automatically check the URL before proceeding (e.g. broken URL https://datasette.io/legislators/officers) (probe the table before creating it via `probeSingleTable`; Connect dialog validates inline + stays open on failure; Test connection probes the real table)
- ✅ Create a concept for a settings dialog with tabs for General and then one tab for each plugin which has registered settings. Plugins should call api.registerSettings with their id, name and a JSON object containing their settings. (concept: `.claude/plans/2026-07-26-settings-dialog-concept.md`)

## Rendering

- ✅ Create an html renderer which outputs the value of a cell without encoding

## Dialogs

- ✅✅ Create an all-purpose choice() dialog which accepts an array of string options (e.g. OK, Ignore, Cancel) and displays them as a vertical list of buttons and returns the string of the button the user clicked
- ✅✅ `window.prompt`; needs a proper dialog - make an all-purpose prompt which can be used by plugins via the api
- ✅✅ `window.alert`; needs a proper dialog - make an all-purpose alert which can be used by plugins via the api

## General

- ✅✅ bug: z-order of windows is not persisted, it should be saved with the geometry
- ✅✅ feature: create new workspace is not implemented (the `+` button opens
- ✅✅ feature: search in table not implemented (per-table local search), search bars should appear as icon and expand into input on focus
- ✅✅ polish: proper jsPanel footer is missing from tables with icon buttons:
  - Export csv (download icon)
  - Import csv (upload icon)
  - Column editor (column icon)

## Data table rendering

- ✅✅ feature: per-column resize handles (drag the right edge of `th`)
- ✅✅ bug: column resize was dead — the draggable `th` started a native drag on
  the gutter and hijacked the pointer. Reorder now lives on a small `.col-grip`
  handle; the `th` is no longer draggable, so resize (table + view instances)
  works and persists, and the sort icon is reachable.
- ✅✅ bug: on wide/many-column tables the drag "barely moved" the column —
  `table-layout: auto` ignores `<col>` widths. First resize now freezes every
  column's width and switches to `table-layout: fixed`, so the drag is exact.
- ✅✅ perf: row virtualization for >1000 rows (currently renders the entire `tbody`)
- ✅✅ feature: column width persistence (`Column.width` field on resize stop)
- ✅✅ feature: null-value cell highlighting (light red background) so empties stand out
- ✅✅ polish: number cells right-aligned (cell only — headers stay left-aligned like every column)
- ✅✅ polish: sort + filter icons pinned to the right edge of each column header
  (flex layout on an inner wrapper; label truncates with ellipsis)
- ✅✅ feature: date cells render in user locale short format when read-only,
  use `<input type=date>` when editing and datetime respectively
- ✅✅ feature: separate `datetime` type (date + time of day); current `date` type
  is date-only
- ✅✅ feature: Change the `×` delete button to a subtle gray icon which darkens on hover
  re-render

## Columns Editor

- ✅✅ feature: drag-to-reorder columns by dragging the `th` itself (currently
  only `▲`/`▼` buttons inside the column editor dialog)
- ✅✅ feature: hide/show columns (`Column.hidden` flag + eye toggle in editor)
- ✅✅ Add max length to column editor
- ✅ Column editor should preview a copy of the top 100 rows of existing data marking red what doesn't validate or parse according to live changes in the editor
  (edit mode in `new-table-dialog.ts`: `renderPreview()` +
  `validateAgainstSpec`, red `violation` class, re-runs live on every edit)

## Cell Editing

- ✅✅ feature: constraint pre-flight scan — when enabling `unique`/`notnull` on
  an existing column, scan rows for violations and block save with details
- ✅✅ feature: enforce `Column.max` on edit and insert (field exists in schema, never read)
- ✅✅ feature: enforce `Column.unique` (field exists, not validated)
- ✅✅ feature: enforce `Column.notnull` (field exists, not validated)
- ✅✅ feature: apply `Column.default` when inserting a row (field exists, currently we just `?? ''`)

## Import / export

- ✅✅ feature: CSV paste textarea (currently only file drop)
- ✅✅ feature: CSV import-mode dialog for existing tables — use common api's choice() dialog for: `Append` /
  `Overwrite rows` / `Cancel` / `Create new table`
- ✅✅ feature: CSV header colon mini-language parser
  `field:label:type:default:max:flags` (the type-from-data inference still
  applies as fallback)
- ✅✅ feature: JSON import-mode dialog — `Overwrite matching tables` / `Replace
entire workspace` / `Cancel` (currently always inserts new tables next to
  existing ones)
- ✅✅ feature: cascade window positions for imported tables that have no
  `elementRect.x/y` (today the v1 importer honors saved positions; tables
  without coords stack)
- ✅✅ feature: validate dump-export shape covers everything the JSON-import
  reader expects, so round-trips are lossless

## Sync (Gist)

- ✅ feature: Gist credentials dialog (proper Lit `<dialog>` replacing `window.prompt`),
  with help text + link to GitHub PAT settings
- ✅ feature: Toast notifications on Push / Pull success and error
  (replace `window.alert`)
- ✅ feature: Pre-push 1 MB-per-file size check + warning before the request
- ✅ polish: surface the gist URL after a successful Push so user can open it
  (the Push toast includes the URL, which `toast-host.ts` linkifies into a
  clickable `<a target=_blank>`)

## Filters

- ✅✅ feature: per-column filter as a dropdown with unique-value picker capped at
  ~500 values (currently substring text input only)
- ✅✅ feature: funnel icon on the column header, active state highlights it blue
- ✅✅ feature: faceted options — the dropdown's value list respects other active
  per-column filters
- ✅✅ polish: filter dropdown anchored under the column header, escapes panel
  clip boundaries (use `document.body` portal pattern)

## Search

- ✅ feature: per-table local search input inside each `<data-table>` (toggle
  icon → expand)
- ✅ feature: global header search should be collapsible (icon → input on focus,
  collapse on blur if empty)
- ✅ polish: clarify precedence — global search AND per-column filters AND
  per-table search ANDed together (`data-table.ts` `filteredRows()` narrows
  sequentially: per-column filters → local search → global search, so a row
  must pass all three)

## Validation & data integrity

- feature: type detection on import — DMY-vs-MDY date inference remembered per
  column; handle `/`, `-`, `.` separators
- feature: datetime parsing with space-or-`T` separator and 24-hour HH:MM:SS
- ✅ feature: inline cell-edit validation — reject and revert on type mismatch
  or constraint violation
- feature: explicit Null distinguishable from empty string in storage

## Window manager (jsPanel)

- ✅✅ bug: z-order of windows is not persisting (above)
- ✅ feature: restore `maximized` and `minimized` status on reload
  (`saveGeometry` persists both flags; `openPanel` re-applies them on boot —
  `jspanel-manager.ts`. Minimized panels mount lazily.)
- ✅✅ feature: panel title shows row count after table name, e.g. `inventory (3)`
- ✅✅ feature: header-drag visual feedback (opacity + drop-target borders) when
  doing column reorder via the table header
- ✅ polish: smallify control re-enabled (the `headerControls` override that
  removed it is gone; `jsPanel.create` uses the default control set)

## UI niceties

- ✅✅ feature: toast notification system (replace `alert()` in plugin flows —
  gist sync, import errors, etc.)
- ✅✅ feature: confirm dialog (replace native `confirm` for row/table delete)
- ✅✅ feature: Material Icons in buttons everywhere (currently text labels —
  `+ New Table`, `Push`, `Pull`, `Dump`, `CSV`, etc.)
- feature: keyboard shortcuts — Enter to import, Esc to cancel cell edit,
  Esc to close dialogs
  - ✅ Esc closes dialogs (native `<dialog>` `cancel` event, wired everywhere)
  - ✅ Enter to import (Ctrl/Cmd+Enter via `ctrlEnterSubmits`, works from any
    field incl. textareas; plain Enter also submits single-line inputs natively)
  - ✅✅ Esc to cancel cell edit (`cancelCellEdit` in `data-table.ts` reverts the
    editor to the stored value + blurs without committing; e2e covered)
- ✅✅ polish: more prominent page-level drag-drop overlay during a drag (today
  the dashed border only appears via CSS; reliable visual cue would help)
- ✅✅ feature: draggable modal dialogs (column editor, new-table dialog) — they
  are currently centered modals, not draggable
- ✅ feature: progress indicator during large imports (Northwind takes ~10s)
  (`json-import.ts` drives the `TopProgress` bar through the parse+insert
  phase, row-weighted, gated at ≥2000 rows so small imports don't flash it;
  the network-fetch bar already covered the download phase)

## Plugin system

- ✅ feature: URL-fetched plugins — Plugin Manager dialog, dynamic `import()` of
  a `Blob` URL built from the cached JS body
- ✅ feature: `cachedBody` field on the `plugin` collection actually used for
  offline-first plugin load
- ✅ feature: `Workspace.pluginUrls` list rendered and editable in the Plugin
  Manager (fields already exist in schema)
- ✅ feature: plugin error UI — surface `plugin:error` events as a panel/toast
  with stack trace and "disable plugin" affordance
- 🕜 feature: Plugin Manager "by type" filter (branch `plugin-registry`, v0.0.107) —
  new `PluginType` in `plugin-api.ts` (`importer` | `exporter` | `cell-renderer` |
  `sync` | `source` | `ui`); all 18 built-ins + 3 demo plugins declare `meta.type`;
  the generator passes it into `catalog.json`. Dialog gains a tri-state "TYPE" chip
  row and a per-row type badge. e2e updated; awaiting merge to main.

## Backend / server

- ✅ feature: removed rxdb entirely; renderer now talks to Dexie directly via
  `dexie-db.ts` + `data-store-dexie.ts`. Plugin API surface is unchanged.
  Subscriptions use `liveQuery`. Local v1 data isn't migrated — users on the
  upgrade path should Dump first.
- ✅✅ feature: `/replicate/:collection/pull` and `/push` actually implement the
  RxDB replication protocol (today both return 501)
- ✅ feature: renderer wires `RxReplicationState` to the server endpoints so
  multi-device sync works end-to-end
- ✅✅ feature: `/fetch` URL proxy actually used by plugins
  (`api.backend.fetch` routes through `${server-sync:url}/fetch` when the
  setting is configured; direct fetch otherwise)
- ✅✅ feature: `/plugins/registry` returns a curated list
  (`PLUGINS_REGISTRY_PATH` env var → JSON file; Plugin Manager dialog
  shows them in a "From server" section)

## Electron

- feature: bundle Hono into the Electron main process (today just opens a
  `BrowserWindow` pointing at the Vite dev URL — renderer still uses Dexie)
- feature: IPC bridge in preload exposes a Dexie-over-IPC storage adapter
  proxying to main-process better-sqlite3
- feature: `better-sqlite3` storage in main process (data goes to a real file
  instead of IndexedDB inside Electron's renderer)
- feature: `electron-builder` packaging exercised end-to-end (config exists,
  never run)
- polish: `window.easydb.platform === 'electron'` branch in the renderer so
  features can light up only on desktop (e.g. native save dialog)

## Tests

- feature: Vitest unit suite — CSV parser (incl. RFC-4180 edge cases), JSON
  parser shape detection (v1 + v2 + nested + array-of-objects), type
  inference, geometry sanitizer, column-editor validation
  - ✅ CSV RFC-4180 edge cases (`csv-import.test.ts`: doubled-quote escaping,
    embedded commas, CRLF, embedded newlines in quoted fields)
  - ✅ JSON shape detection (`json-import.test.ts`: v1/native dump, array-of-
    objects, single-object, nested, invalid inputs)
  - ✅ type inference (exercised via `parseCsv`/`parsedToTables` since the
    inference fns aren't exported)
  - ✅ geometry sanitizer — extracted the pure `sanitizeGeometry` (+ MIN_W/H)
    to `window-mgr/geometry.ts`; `geometry.test.ts` covers null/non-finite/
    below-min/valid-copy/off-screen cases
  - ⬜ column-editor validation unit tests still to add
- feature: Playwright e2e — both `browser` and `electron` projects, covering
  drop-import → sort → filter → export → re-import (full round-trip)
- feature: schema migration test — open a DB written by an older Dexie
  version and confirm the .version(N).upgrade() chain runs cleanly
- feature: lint pipeline (`eslint` config + npm script + CI)

## Architectural follow-ups (not parity, but worth doing)

- ✅ perf: `bulkInsert` already in importers; do a pass for any other tight
  loops calling single `insert` in plugins
- ✅ feature: schema versioning — Dexie `.version(N).stores({...}).upgrade(...)`
  in `dexie-db.ts` (used to be RxDB schema bumps with migrationStrategies)
- feature: undo/redo — needs a revision-history primitive on top of Dexie
  (no longer free now that RxDB is gone)
- ✅ feature: a `header-clock` reference plugin to prove `registerHeaderButton`
  end-to-end and document the trivial-plugin shape
- ✅ feature: a `color-cell` / `image-cell` plugin demonstrating
  `registerCellRenderer` (today these types are rendered in core
  `<data-table>`; move them out to dogfood the API)
- ✅✅ feature: `auto-sync` plugin — silent push + prompted pull every minute
  (optional built-in; reuses server-sync's URL + ETag, drives ticks on a
  60s interval; shared helpers live in `server-sync-core.ts`)
- ✅✅ feature: `sql-export` emits `date` columns as `'YYYYMMDD'` string
  literals (CHAR(8)); `datetime` stays on ISO/TIMESTAMP

## Bugs

- ✅ bug: When importing a .db.json file and choosing the replace option it should delete all existing data first
  (data was being deleted but old jsPanel windows stayed open with stale content
  because the subscription-driven close tripped the user-confirm `onbeforeclose`
  guard — fixed in `jspanel-manager.ts` with an `externallyClosed` flag)
