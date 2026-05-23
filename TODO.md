# TODO

Feature-parity gap against `minniDBMax v0.0.29`, plus known bugs in
`easyDBAccess`. Existing bullets first, then grouped additions.

Status keys: `bug` = broken, `feature` = missing, `polish` = works but UX
gap, `perf` = correctness OK but slow. Leading `✅` = done.
`✅✅` = done with e2e test coverage.

## Dialogs
* ✅✅ Create an all-purpose choice() dialog which accepts an array of string options (e.g. OK, Ignore, Cancel) and displays them as a vertical list of buttons and returns the string of the button the user clicked
* ✅✅ `window.prompt`; needs a proper dialog) - make an all-purpose prompt which can be used by plugins via the api 
* ✅✅ `window.alert`; needs a proper dialog - make an all-purpose alert which can be used by plugins via the api

## General
* ✅✅ bug: z-order of windows is not persisted, it should be saved with the geometry
* ✅✅ feature: create new workspace is not implemented (the `+` button opens
* ✅✅ feature: search in table not implemented (per-table local search), search bars should appear as icon and expand into input on focus
* ✅✅ polish: proper jsPanel footer is missing from tables with icon buttons:
  * Export csv (download icon)
  * Import csv (upload icon)
  * Column editor (column icon)

## Data table rendering

* ✅✅ feature: per-column resize handles (drag the right edge of `th`)
* ✅✅ perf: row virtualization for >1000 rows (currently renders the entire `tbody`)
* ✅✅ feature: column width persistence (`Column.width` field on resize stop)
* ✅✅ feature: null-value cell highlighting (light red background) so empties stand out
* ✅✅ polish: number cells right-aligned (header and cell)
* ✅✅ feature: date cells render in user locale short format when read-only,
  use `<input type=date>` when editing and datetime respectively
* ✅✅ feature: separate `datetime` type (date + time of day); current `date` type
  is date-only
* ✅✅ feature: Change the `×` delete button to a subtle gray icon which darkens on hover
  re-render

## Columns Editor

* ✅ feature: drag-to-reorder columns by dragging the `th` itself (currently
  only `▲`/`▼` buttons inside the column editor dialog)
* ✅ feature: hide/show columns (`Column.hidden` flag + eye toggle in editor)
* ✅ Add max length to column editor
* Column editor should preview a copy of the top 100 rows of existing data marking red what doesn't validate or parse according to live changes in the editor

## Cell Editing
* ✅ feature: constraint pre-flight scan — when enabling `unique`/`notnull` on
  an existing column, scan rows for violations and block save with details
* ✅ feature: enforce `Column.max` on edit and insert (field exists in schema, never read)
* ✅ feature: enforce `Column.unique` (field exists, not validated)
* ✅ feature: enforce `Column.notnull` (field exists, not validated)
* ✅ feature: apply `Column.default` when inserting a row (field exists, currently we just `?? ''`)

## Import / export

* ✅ feature: CSV paste textarea (currently only file drop)
* ✅ feature: CSV import-mode dialog for existing tables — use common api's choice() dialog for: `Append` /
  `Overwrite rows` / `Cancel` / `Create new table`
* ✅ feature: CSV header colon mini-language parser
  `field:label:type:default:max:flags` (the type-from-data inference still
  applies as fallback)
* ✅ feature: JSON import-mode dialog — `Overwrite matching tables` / `Replace
  entire workspace` / `Cancel` (currently always inserts new tables next to
  existing ones)
* ✅ feature: cascade window positions for imported tables that have no
  `elementRect.x/y` (today the v1 importer honors saved positions; tables
  without coords stack)
* ✅ feature: validate dump-export shape covers everything the JSON-import
  reader expects, so round-trips are lossless

## Sync (Gist)

* ✅ feature: Gist credentials dialog (proper Lit `<dialog>` replacing `window.prompt`),
  with help text + link to GitHub PAT settings
* ✅ feature: Toast notifications on Push / Pull success and error
  (replace `window.alert`)
* ✅ feature: Pre-push 1 MB-per-file size check + warning before the request
* polish: surface the gist URL after a successful Push so user can open it

## Filters

* ✅ feature: per-column filter as a dropdown with unique-value picker capped at
  ~500 values (currently substring text input only)
* ✅ feature: funnel icon on the column header, active state highlights it blue
* ✅ feature: faceted options — the dropdown's value list respects other active
  per-column filters
* ✅ polish: filter dropdown anchored under the column header, escapes panel
  clip boundaries (use `document.body` portal pattern)

## Search

* ✅ feature: per-table local search input inside each `<data-table>` (toggle
  icon → expand)
* ✅ feature: global header search should be collapsible (icon → input on focus,
  collapse on blur if empty)
* polish: clarify precedence — global search AND per-column filters AND
  per-table search ANDed together

## Validation & data integrity

* feature: type detection on import — DMY-vs-MDY date inference remembered per
  column; handle `/`, `-`, `.` separators
* feature: datetime parsing with space-or-`T` separator and 24-hour HH:MM:SS
* ✅ feature: inline cell-edit validation — reject and revert on type mismatch
  or constraint violation
* feature: explicit Null distinguishable from empty string in storage

## Window manager (jsPanel)

* ✅✅ bug: z-order of windows is not persisting (above)
* feature: restore `maximized` and `minimized` status on reload (today the
  geometry restores but the panel always opens "normalized")
* ✅ feature: panel title shows row count after table name, e.g. `inventory (3)`
* ✅ feature: header-drag visual feedback (opacity + drop-target borders) when
  doing column reorder via the table header
* polish: smallify control is currently removed; consider re-enabling

## UI niceties

* ✅ feature: toast notification system (replace `alert()` in plugin flows —
  gist sync, import errors, etc.)
* ✅ feature: confirm dialog (replace native `confirm` for row/table delete)
* ✅ feature: Material Icons in buttons everywhere (currently text labels —
  `+ New Table`, `Push`, `Pull`, `Dump`, `CSV`, etc.)
* feature: keyboard shortcuts — Enter to import, Esc to cancel cell edit,
  Esc to close dialogs
* ✅ polish: more prominent page-level drag-drop overlay during a drag (today
  the dashed border only appears via CSS; reliable visual cue would help)
* ✅ feature: draggable modal dialogs (column editor, new-table dialog) — they
  are currently centered modals, not draggable
* feature: progress indicator during large imports (Northwind takes ~10s)

## Plugin system

* ✅ feature: URL-fetched plugins — Plugin Manager dialog, dynamic `import()` of
  a `Blob` URL built from the cached JS body
* ✅ feature: `cachedBody` field on the `plugin` collection actually used for
  offline-first plugin load
* ✅ feature: `Workspace.pluginUrls` list rendered and editable in the Plugin
  Manager (fields already exist in schema)
* ✅ feature: plugin error UI — surface `plugin:error` events as a panel/toast
  with stack trace and "disable plugin" affordance

## Backend / server

* ✅✅ feature: `/replicate/:collection/pull` and `/push` actually implement the
  RxDB replication protocol (today both return 501)
* ✅ feature: renderer wires `RxReplicationState` to the server endpoints so
  multi-device sync works end-to-end
* feature: `/fetch` URL proxy actually used by plugins (today they call
  `globalThis.fetch` directly; CORS-blocked APIs can't be imported)
* feature: `/plugins/registry` returns a curated list (today an empty stub)

## Electron

* feature: bundle Hono into the Electron main process (today just opens a
  `BrowserWindow` pointing at the Vite dev URL — renderer still uses Dexie)
* feature: IPC bridge in preload exposes the RxDB-IPC storage adapter
* feature: `better-sqlite3` storage in main process (data goes to a real file
  instead of IndexedDB inside Electron's renderer)
* feature: `electron-builder` packaging exercised end-to-end (config exists,
  never run)
* polish: `window.easydb.platform === 'electron'` branch in the renderer so
  features can light up only on desktop (e.g. native save dialog)

## Tests

* feature: Vitest unit suite — CSV parser (incl. RFC-4180 edge cases), JSON
  parser shape detection (v1 + v2 + nested + array-of-objects), type
  inference, geometry sanitizer, column-editor validation
* feature: Playwright e2e — both `browser` and `electron` projects, covering
  drop-import → sort → filter → export → re-import (full round-trip)
* feature: schema migration test — open a DB written by an older schema
  version and confirm RxDB migrates cleanly
* feature: lint pipeline (`eslint` config + npm script + CI)

## Architectural follow-ups (not parity, but worth doing)

* ✅ perf: `bulkInsert` already in importers; do a pass for any other tight
  loops calling single `insert` in plugins
* ✅ feature: schema versioning — bump `version` field in `schemas.ts` with a
  migration when adding required fields (RxDB enforces this)
* feature: undo/redo (RxDB has a revision-history primitive)
* ✅ feature: a `header-clock` reference plugin to prove `registerHeaderButton`
  end-to-end and document the trivial-plugin shape
* ✅ feature: a `color-cell` / `image-cell` plugin demonstrating
  `registerCellRenderer` (today these types are rendered in core
  `<data-table>`; move them out to dogfood the API)
