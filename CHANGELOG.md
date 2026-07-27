# CHANGELOG

## 27 Jul 2026 (v0.0.139)

- Closing a table window now hides it (keeping its data) instead of deleting — reopen it from the Ctrl+K palette ("Go to <table>"). A new trash button in each table's button bar permanently deletes the table and its rows (with confirmation).

## 27 Jul 2026 (v0.0.138)

- Gist sync now carries every workspace setting (no more excluded prefixes); keep pushed gists private if a setting still holds a raw token. Settings → General gained a Download secrets.txt button.

## 27 Jul 2026 (v0.0.137)

- The table info (ⓘ) dialog now explains whether a table is Connected (live backend — rows fetched on demand) or Imported (a local snapshot, with a link to its origin); the ⓘ button also shows for such tables even without other metadata.

## 27 Jul 2026 (v0.0.136)

- Command palette (Ctrl+K): manage windows (minimize/restore/maximize/cascade/tile/close all), go to a table, run any action, plus Search/Plugins/Changelog/Docs. Plugins can register commands.

## 27 Jul 2026 (v0.0.134)

- Column filters gained operators: `!text` (does not contain), `NULL` (blank cells), `!NULL` (has a value); `!true` now also shows empty cells. The filter dropdown adds a *(Blanks)* entry and a **hide** checkbox to negate your pick.

## 27 Jul 2026 (v0.0.133)

- Gist sync now syncs remote (backend-backed, e.g. Datasette) tables by definition only — their live rows are never pushed, and a pulled remote table reconnects to its backend instead of importing stale rows.

## 27 Jul 2026 (v0.0.132)

- New `html` cell renderer: set a column's renderer to "html" to show its value as unescaped HTML inline; click the cell to open the full HTML in its own window.

## 27 Jul 2026 (v0.0.131)

- Gist Push and Pull now offer a scope choice — Everything, Data only (tables + rows), or Settings only (views + settings).

## 26 Jul 2026 (v0.0.130)

- Removed the Gist plugin's own credentials dialog — configure Gist in Settings → Gist Sync; push/pull with no credentials now points you there.

## 26 Jul 2026 (v0.0.129)

- Connecting a Datasette table whose name clashes with a different existing table now prompts Overwrite / Rename / Skip instead of silently duplicating; table-name checks are case-insensitive across import and connect.

## 26 Jul 2026 (v0.0.125)

- Settings is now a fixed (always-on) plugin; the Plugin Manager hides fixed plugins unless the "Fixed" filter is on, and the "Installed" filter now lists bundled built-ins.

## 26 Jul 2026 (v0.0.123)

- JSON dump export/import now round-trips view templates & instances (re-pointed by table name) plus per-table window geometry/title/filters; windows restack on import.

## 26 Jul 2026 (v0.0.117)

- Gist pull restores full per-table state (window position/size/stacking, sort, filters, view, label column) and window z-order; front-rank z is now unique so layering survives round-trips.

## 26 Jul 2026 (v0.0.115)

- The version number in the header is now a link to the changelog on GitHub.
- Plugin Manager can now filter plugins by type (importer, exporter, cell-renderer, sync, source, ui); every plugin declares its type.

## 26 Jul 2026 (v0.0.109)

- Workspace title is now editable in Settings → General and shown in the header instead of "easyDBAccess".
- Every dialog now confirms its primary action on Ctrl+Enter; Esc still closes. Fixed 5 dialogs missing the wiring, including Settings.
- New views auto-map `$DATE`/`$URL`/`$DESCRIPTION` tokens to matching columns by type/renderer/name, and can cap the rows shown (TOP N) via a "Show at most" field.
- Settings dialog: tabbed General + per-plugin tabs, two-layer workspace/user storage, secrets store with `${secret}` refs and drag-in `secrets.txt` import.
- Escape cancels an in-progress cell edit without committing.
- Added Vitest coverage for JSON detection, type inference, and CSV parsing.
- Extracted window-geometry sanitizing into its own tested module.
- Progress indicator added for large JSON imports.
- Drafted a settings-dialog concept with per-plugin tabs.
- Fixed column resize; added a dedicated drag grip; left-aligned headers.
- Moved sort/filter icons to the right edge of column headers.
- Datasette connect validates the table URL before creating a table.
- Plugin catalog resolves registry URLs against the app's deploy base.
- Gist pull handles GitHub-truncated files, reports per-table errors, warns on size.
- Added a full project documentation set under `docs/`.

## 25 Jul 2026 (v0.0.83)

- Added a search box to view-window headers.
- CSV/JSON import failures now always surface a real reason, not "Load failed".
- Slow (>2s) URL imports show a top progress bar.
- Import dialog gained file upload, per-column hide toggle, and a row limit.
- Non-CORS GitHub blob/raw URLs auto-convert to raw.githubusercontent.com.
- View templates can be toggled on/off with an editable grid fallback.
- Fixed a filter reverting mid-edit when a store write landed during debounce.
- Datasette metadata drives default sort, column descriptions, units, and an info dialog.
- Views reconnect automatically to a recreated same-named table.
- Dialogs go full-screen on phone-sized viewports.
- Boolean search (AND/OR) with phrase-to-AND-to-OR fallback.
- Panel titles show a live filtered row count.
- Datasette imports keep partial rows and can resume after rate-limiting.
- Global search now applies to view windows too.
- Import progress bar becomes proportional once the row count is known.

## 24 Jul 2026 (v0.0.55)

- Per-table and header search: focus on open, collapse on click-outside.
- Tables drag anywhere unclamped; right-click drag pans the canvas on desktop.
- Loading bar shown in the table header while rows load.
- Link cell renderer truncates to the available column width.
- Import: overwrite/rename on name collision, one toast, skip redundant table picker.
- CSV URL import added to the Import dialog.
- Restores the last-active workspace when opening a new tab.
- Sort ranks nulls below blanks, floating nulls to the top ascending.
- Fixed duplicate-slug CSV imports; added a pre-import column editor.
- Table windows render immediately with progress bars; rows load lazily.
- Minimized windows fetch nothing until expanded, saving memory and requests.
- Maximize now fills the window correctly regardless of pan/zoom state.
- Added the View system: HTML templates + read-only per-table view windows.
- Fixed a multi-tab DB-upgrade hang; guides blocked tabs to reload.
- Minimized windows now dock bottom-left, fixed against pan/zoom.
- View instances gained an editor; minimize/maximize state persists on reload.

## 23 Jul 2026 (v0.0.28)

- Added a live-write smoke-test script against a real Datasette instance.
- Phase 2c: live read-write Datasette row collection (the write path).
- Phase 2b: Connect-to-Datasette dialog for live read-write tables.
- Authenticate Datasette reads for private instances; fail writes gracefully.
- Fixed instance connect/import 404s; added a database-selection step.
- Explain blocked ("Load failed") Datasette fetches with a clear reason.
- Closing a live (source-backed) table window now removes it properly.
- Connect dialog reuses an existing live table instead of duplicating it.
- One shared, deduplicated live collection per connected table.
- Added a Refresh button to Datasette-backed import and connect tables.
- Mobile: responsive header, pan/zoom the table canvas.

## 22 Jul 2026 (v0.0.15)

- Added the datasette-source plugin: import tables from any Datasette instance.
- Added a row-source routing seam so tables can be backed by live data.
- Replaced the sample-data button with a URL/source-picker Import dialog.
- Import supports a whole Datasette instance with a multi-table picker.
- Fixed Datasette paging and schema handling against real datasette.io responses.
- Infer Datasette column types from row values when schema lacks them.
- Support importing an entire Datasette database (all its tables).
- Give Datasette fetch failures a clear, actionable error message.
- Version now auto-bumps on every commit; title and header stay in sync.
- Table picker shows row counts, estimated size, and handles name collisions.
- Follow Datasette 1.0's `next` cursor when paging results.

## 26 May 2026 (v0.0.8)

- Added `bulkRemove` to the data-store API; used for cascading deletes.
- Packaged the renderer for the desktop (Electron) edition.
- Replaced RxDB with Dexie for local storage.
- CSV import now matches columns by index, not by header name.
- cell-link detects email addresses, renders them as mailto: links.
- Cell image renderer supports data URIs or plain URLs.
- Gist sync enforces GitHub's 100 MB per-file limit.
- Column editor: drag-reorder, color picker-only cells, a row-delete bin icon.

## 25 May 2026 (v0.0.7)

- Stopped reloading URL plugins unnecessarily.
- Confirmed Gists can exceed 1MB.
- Table titlebar stays visible even when its body is hidden.
- Draggable dialogs, plugin caching, and a more robust URL-loader.

## 24 May 2026 (v0.0.6)

- e2e coverage: columns editor, cell editing, import/export, filters, window manager, UI.
- CI pinned to Node 22 so `node:sqlite` resolves.
- Fixed jspanel4's broken CSS sourcemap warning in Vite.
- Added the auto-sync plugin, SQL export, and release workflow tweaks.
- SQL export writes date columns as 'YYYYMMDD' string literals.
- Switched the release pipeline to Node 24.
- Backend: `/fetch` proxy + `/plugins/registry` routes added.
- filter-combobox replaces the native datalist; cell-link moved to the catalog.
- `column.renderer` separates display from the column's data type.
- Built-in `script` cell renderer for per-column custom rendering.

## 23 May 2026 (v0.0.3)

- Close (×) button added to all dialogs.
- cell-link plugin renders URL/phone strings as clickable links.
- Autocomplete on filter inputs for low-cardinality columns.
- Faceted filter values for drill-down search, matching minniDBMax v1.
- Server-side sync engines added.
- Dynamic plugin loading and a sample-data plugin.
- e2e test harness, per-package CLAUDE.md docs, and a CI workflow.

## 22 May 2026 (v0.0.1)

- Imported v1 minniDBMax dumps; improved `bulkInsert` performance.
- Moved "+ New Table" out of the shell into a plugin.
- Added Northwind sample data for import tests.
- Persist window z-order across reload.
- Added `api.ui.dialogs` primitives: alert / prompt / choice.
- Per-table local search, collapsible UX, moved into the panel titlebar.
- Row count in panel title, subtle delete icon, right-aligned numbers.
- Column constraints enforced: default, max, unique, notnull.
- Added CSV and JSON import-mode dialogs.
- Drag-to-reorder columns, plus hide/show columns.
- Swept Material Icons across chrome, panels, dialogs, and built-in plugins.
- Added toast notifications and a confirm dialog.
- Added a datetime column type, null highlighting, native date inputs.
- Column resize handles with persisted width.
- Constraint pre-flight scan; CSV paste via textarea.
- Live preview of the top 100 rows in the column editor.
- Made all modal dialogs draggable from their header.
- Faceted per-column filter dropdown with value counts.
- Window manager polish: minimize/maximize restore, smallify, import cascade.
- CSV header mini-language: `field:label:type:default:max:flags`.
- Row virtualization for tables with more than 200 rows.
- URL-loaded plugins plus a Plugin Manager dialog.
- Improved CSV date/datetime inference and normalization.
- Moved color/image cell renderers to plugins; added a header-clock demo.

## 21 May 2026 (v0.0.0)

- Initial commit: sortable, filterable data-table with typed cell rendering.
- New Table dialog with a column editor and reorder support.
- Added a per-table CSV export plugin.
- Multi-workspace support via a `?space=` URL parameter.
- Added the Gist sync plugin (Push / Pull).
- Global search across all tables, fixed to filter rows, not hide panels.
