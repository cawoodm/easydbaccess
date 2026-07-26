# Instructions

- Read instructions in .claude\CLAUDE.md
- Read and write only to this central TODO.md at C:\projects\Marc\easyDBAccess\TODO.md (not your worktree version)
- Run a loop to process one task at a time:
  - Read an unmarked TODO from the Backlog below, don't take a task marked 🕜
  - Move it to in-progress and mark it with 🕜
  - If you are not already on a worktree, create a todos branch and worktree and switch to that
  - Begin implementing and ask questions if anything is unclear
  - Once a task is implemented, show the user the full dev URL link (with http://), ask the user if they are happy explaining what was done and how to test it
  - Once the user accepts it, mark as done ✅ and move to DONE
  - Commit (Don't put TODO or claim in the commit message, just the original task text)
  - Bump version using scripts/
  - Write a CHANGELOG.md entry
  - merge into main
  - Always update your worktrees TODO and the file C:\projects\Marc\easyDBAccess\TODO.md so I can watch live changes

Status keys: `bug` = broken, `feature` = missing, `polish` = works but UX
gap, `perf` = correctness OK but slow. Leading `✅` = done.
`✅✅` = done with e2e test coverage.

## Backlog

- When connecting datasette add options for "virtual" and "no persist" recommended for big tables. Virtual means we don't load all data - we only load at most 2 visible pages in the UI, the sorting and filtering is done on the server and we eject the entire table from memory each time the user sorts or filters. Paging is server side. The "no persist" option means we don't save the data to our local store and we don't push/synch it either. Surface these settings in the column editor.

## In progress

- 🕜 When clicking on the version in the header launch the CHANGELOG.md URL on github
- 🕜 feature: Gist push/pull should sync the entire workspace, not just tables — include view templates, view instances, and settings (currently `gist-sync.ts` only serializes `api.store.tables` + rows; `viewTemplates`/`viewInstances`/`settings` are never pushed or pulled, so views and plugin config don't survive a Gist round-trip to another device)

## DONE

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
