# CHANGELOG

## 28 Jul 2026

- v0.0.163 Docs split in two: `docs/help/` is a screenshot-illustrated user guide, `docs/tech/` holds the existing developer/architecture notes.
- v0.0.162 Safe mode: `?safemode` boots with no plugins, `?safemode1` without URL plugins. Plugin Manager now filters by enabled/disabled.
- v0.0.159 New favicon, and the workspace title now shows in the browser tab.
- v0.0.158 Typing a URL into a cell now turns it into a link as soon as you click away. Script-rendered and image cells gained a pencil on the right to edit their stored value.
- v0.0.157 Choice dialogs now show the first option as the blue default button, focus it on open, and accept Enter to pick it.
- v0.0.156 Any column can now be dragged down to 10px, including link columns that refused to shrink. Chopped text and URLs end in an ellipsis.
- v0.0.155 Maximized windows now follow a browser resize, fill the panel with no gap above the footer, and show a pointer cursor. Double-click a titlebar to maximize or restore.
- v0.0.152 A `^` prefix in a column filter matches only from the start of the cell (`^S`). The suggestion list no longer covers the rows: it hides when nothing matches and closes on blur.
- v0.0.151 Drag-and-drop and Import now read `.tsv` and `.tab` files. A tab-separated file keeps its tabs even when its cells contain commas.
- v0.0.150 Column filters got a tri-state checkbox per value: gray off, green include, red exclude. Pick as many values as you like.

## 27 Jul 2026

- v0.0.149 Editing a built-in view template now turns it into a normal template (no more duplicate "built-in" clones), and every template has a Delete button.
- v0.0.148 The Settings dialog won't close while a secret field holds a raw value — it must be empty or a `${secret:name}` reference, so secrets are never saved or synced in plain text.
- v0.0.147 Views gained a Readonly option (default off): a readonly grid view shows values without editors — no date picker, disabled checkboxes — while normal views stay editable.
- v0.0.146 Import now offers Copy vs Reference. A Reference is a live, read-only table (Datasette table/database or CSV/JSON URL) that's never stored or synced. A Copy's Refresh keeps columns you added while refreshing the rest.
- v0.0.143 Two HTML cell renderers: `html-preview` shows a truncated plain-text preview (edit in a dialog, popup icon to view rendered HTML), and `html` renders full HTML in-cell with inline editing. Both editable.
- v0.0.142 The column editor's live preview now hides columns marked hidden, matching the actual table.
- v0.0.139 Closing a table window now hides it (keeping its data) instead of deleting — reopen it from the Ctrl+K palette ("Go to `<table>`"). A new trash button in each table's button bar permanently deletes the table and its rows (with confirmation).
- v0.0.138 Gist sync now carries every workspace setting (no more excluded prefixes); keep pushed gists private if a setting still holds a raw token. Settings → General gained a Download secrets.txt button.
- v0.0.137 The table info (ⓘ) dialog now explains whether a table is Connected (live backend — rows fetched on demand) or Imported (a local snapshot, with a link to its origin); the ⓘ button also shows for such tables even without other metadata.
- v0.0.136 Command palette (Ctrl+K): manage windows (minimize/restore/maximize/cascade/tile/close all), go to a table, run any action, plus Search/Plugins/Changelog/Docs. Plugins can register commands.
- v0.0.134 Column filters gained operators: `!text` (does not contain), `NULL` (blank cells), `!NULL` (has a value); `!true` now also shows empty cells. The filter dropdown adds a _(Blanks)_ entry and a **hide** checkbox to negate your pick.
- v0.0.133 Gist sync now syncs remote (backend-backed, e.g. Datasette) tables by definition only — their live rows are never pushed, and a pulled remote table reconnects to its backend instead of importing stale rows.
- v0.0.132 New `html` cell renderer: set a column's renderer to "html" to show its value as unescaped HTML inline; click the cell to open the full HTML in its own window.
- v0.0.131 Gist Push and Pull now offer a scope choice — Everything, Data only (tables + rows), or Settings only (views + settings).

## 26 Jul 2026

- v0.0.130 Removed the Gist plugin's own credentials dialog — configure Gist in Settings → Gist Sync; push/pull with no credentials now points you there.
- v0.0.129 Connecting a Datasette table whose name clashes with a different existing table now prompts Overwrite / Rename / Skip instead of silently duplicating; table-name checks are case-insensitive across import and connect.
- v0.0.125 Settings is now a fixed (always-on) plugin; the Plugin Manager hides fixed plugins unless the "Fixed" filter is on, and the "Installed" filter now lists bundled built-ins.
- v0.0.123 JSON dump export/import now round-trips view templates & instances (re-pointed by table name) plus per-table window geometry/title/filters; windows restack on import.
- v0.0.117 Gist pull restores full per-table state (window position/size/stacking, sort, filters, view, label column) and window z-order; front-rank z is now unique so layering survives round-trips.
- v0.0.115 The version number in the header is now a link to the changelog on GitHub.
- v0.0.115 Plugin Manager can now filter plugins by type (importer, exporter, cell-renderer, sync, source, ui); every plugin declares its type.
- v0.0.109 Workspace title is now editable in Settings → General and shown in the header instead of "easyDBAccess".
- v0.0.109 Every dialog now confirms its primary action on Ctrl+Enter; Esc still closes. Fixed 5 dialogs missing the wiring, including Settings.
- v0.0.109 New views auto-map `$DATE`/`$URL`/`$DESCRIPTION` tokens to matching columns by type/renderer/name, and can cap the rows shown (TOP N) via a "Show at most" field.
- v0.0.109 Settings dialog: tabbed General + per-plugin tabs, two-layer workspace/user storage, secrets store with `${secret}` refs and drag-in `secrets.txt` import.
- v0.0.109 Escape cancels an in-progress cell edit without committing.
- v0.0.109 Added Vitest coverage for JSON detection, type inference, and CSV parsing.
- v0.0.109 Extracted window-geometry sanitizing into its own tested module.
- v0.0.109 Progress indicator added for large JSON imports.
- v0.0.109 Drafted a settings-dialog concept with per-plugin tabs.
- v0.0.109 Fixed column resize; added a dedicated drag grip; left-aligned headers.
- v0.0.109 Moved sort/filter icons to the right edge of column headers.
- v0.0.109 Datasette connect validates the table URL before creating a table.
- v0.0.109 Plugin catalog resolves registry URLs against the app's deploy base.
- v0.0.109 Gist pull handles GitHub-truncated files, reports per-table errors, warns on size.
- v0.0.109 Added a full project documentation set under `docs/`.

## 25 Jul 2026

- v0.0.83 Added a search box to view-window headers.
- v0.0.83 CSV/JSON import failures now always surface a real reason, not "Load failed".
- v0.0.83 Slow (>2s) URL imports show a top progress bar.
- v0.0.83 Import dialog gained file upload, per-column hide toggle, and a row limit.
- v0.0.83 Non-CORS GitHub blob/raw URLs auto-convert to raw.githubusercontent.com.
- v0.0.83 View templates can be toggled on/off with an editable grid fallback.
- v0.0.83 Fixed a filter reverting mid-edit when a store write landed during debounce.
- v0.0.83 Datasette metadata drives default sort, column descriptions, units, and an info dialog.
- v0.0.83 Views reconnect automatically to a recreated same-named table.
- v0.0.83 Dialogs go full-screen on phone-sized viewports.
- v0.0.83 Boolean search (AND/OR) with phrase-to-AND-to-OR fallback.
- v0.0.83 Panel titles show a live filtered row count.
- v0.0.83 Datasette imports keep partial rows and can resume after rate-limiting.
- v0.0.83 Global search now applies to view windows too.
- v0.0.83 Import progress bar becomes proportional once the row count is known.

## 24 Jul 2026

- v0.0.55 Per-table and header search: focus on open, collapse on click-outside.
- v0.0.55 Tables drag anywhere unclamped; right-click drag pans the canvas on desktop.
- v0.0.55 Loading bar shown in the table header while rows load.
- v0.0.55 Link cell renderer truncates to the available column width.
- v0.0.55 Import: overwrite/rename on name collision, one toast, skip redundant table picker.
- v0.0.55 CSV URL import added to the Import dialog.
- v0.0.55 Restores the last-active workspace when opening a new tab.
- v0.0.55 Sort ranks nulls below blanks, floating nulls to the top ascending.
- v0.0.55 Fixed duplicate-slug CSV imports; added a pre-import column editor.
- v0.0.55 Table windows render immediately with progress bars; rows load lazily.
- v0.0.55 Minimized windows fetch nothing until expanded, saving memory and requests.
- v0.0.55 Maximize now fills the window correctly regardless of pan/zoom state.
- v0.0.55 Added the View system: HTML templates + read-only per-table view windows.
- v0.0.55 Fixed a multi-tab DB-upgrade hang; guides blocked tabs to reload.
- v0.0.55 Minimized windows now dock bottom-left, fixed against pan/zoom.
- v0.0.55 View instances gained an editor; minimize/maximize state persists on reload.

## 23 Jul 2026

- v0.0.28 Added a live-write smoke-test script against a real Datasette instance.
- v0.0.28 Phase 2c: live read-write Datasette row collection (the write path).
- v0.0.28 Phase 2b: Connect-to-Datasette dialog for live read-write tables.
- v0.0.28 Authenticate Datasette reads for private instances; fail writes gracefully.
- v0.0.28 Fixed instance connect/import 404s; added a database-selection step.
- v0.0.28 Explain blocked ("Load failed") Datasette fetches with a clear reason.
- v0.0.28 Closing a live (source-backed) table window now removes it properly.
- v0.0.28 Connect dialog reuses an existing live table instead of duplicating it.
- v0.0.28 One shared, deduplicated live collection per connected table.
- v0.0.28 Added a Refresh button to Datasette-backed import and connect tables.
- v0.0.28 Mobile: responsive header, pan/zoom the table canvas.

## 22 Jul 2026

- v0.0.15 Added the datasette-source plugin: import tables from any Datasette instance.
- v0.0.15 Added a row-source routing seam so tables can be backed by live data.
- v0.0.15 Replaced the sample-data button with a URL/source-picker Import dialog.
- v0.0.15 Import supports a whole Datasette instance with a multi-table picker.
- v0.0.15 Fixed Datasette paging and schema handling against real datasette.io responses.
- v0.0.15 Infer Datasette column types from row values when schema lacks them.
- v0.0.15 Support importing an entire Datasette database (all its tables).
- v0.0.15 Give Datasette fetch failures a clear, actionable error message.
- v0.0.15 Version now auto-bumps on every commit; title and header stay in sync.
- v0.0.15 Table picker shows row counts, estimated size, and handles name collisions.
- v0.0.15 Follow Datasette 1.0's `next` cursor when paging results.

## 26 May 2026

- v0.0.8 Added `bulkRemove` to the data-store API; used for cascading deletes.
- v0.0.8 Packaged the renderer for the desktop (Electron) edition.
- v0.0.8 Replaced RxDB with Dexie for local storage.
- v0.0.8 CSV import now matches columns by index, not by header name.
- v0.0.8 cell-link detects email addresses, renders them as mailto: links.
- v0.0.8 Cell image renderer supports data URIs or plain URLs.
- v0.0.8 Gist sync enforces GitHub's 100 MB per-file limit.
- v0.0.8 Column editor: drag-reorder, color picker-only cells, a row-delete bin icon.

## 25 May 2026

- v0.0.7 Stopped reloading URL plugins unnecessarily.
- v0.0.7 Confirmed Gists can exceed 1MB.
- v0.0.7 Table titlebar stays visible even when its body is hidden.
- v0.0.7 Draggable dialogs, plugin caching, and a more robust URL-loader.

## 24 May 2026

- v0.0.6 e2e coverage: columns editor, cell editing, import/export, filters, window manager, UI.
- v0.0.6 CI pinned to Node 22 so `node:sqlite` resolves.
- v0.0.6 Fixed jspanel4's broken CSS sourcemap warning in Vite.
- v0.0.6 Added the auto-sync plugin, SQL export, and release workflow tweaks.
- v0.0.6 SQL export writes date columns as 'YYYYMMDD' string literals.
- v0.0.6 Switched the release pipeline to Node 24.
- v0.0.6 Backend: `/fetch` proxy + `/plugins/registry` routes added.
- v0.0.6 filter-combobox replaces the native datalist; cell-link moved to the catalog.
- v0.0.6 `column.renderer` separates display from the column's data type.
- v0.0.6 Built-in `script` cell renderer for per-column custom rendering.

## 23 May 2026

- v0.0.3 Close (×) button added to all dialogs.
- v0.0.3 cell-link plugin renders URL/phone strings as clickable links.
- v0.0.3 Autocomplete on filter inputs for low-cardinality columns.
- v0.0.3 Faceted filter values for drill-down search, matching minniDBMax v1.
- v0.0.3 Server-side sync engines added.
- v0.0.3 Dynamic plugin loading and a sample-data plugin.
- v0.0.3 e2e test harness, per-package CLAUDE.md docs, and a CI workflow.

## 22 May 2026

- v0.0.1 Imported v1 minniDBMax dumps; improved `bulkInsert` performance.
- v0.0.1 Moved "+ New Table" out of the shell into a plugin.
- v0.0.1 Added Northwind sample data for import tests.
- v0.0.1 Persist window z-order across reload.
- v0.0.1 Added `api.ui.dialogs` primitives: alert / prompt / choice.
- v0.0.1 Per-table local search, collapsible UX, moved into the panel titlebar.
- v0.0.1 Row count in panel title, subtle delete icon, right-aligned numbers.
- v0.0.1 Column constraints enforced: default, max, unique, notnull.
- v0.0.1 Added CSV and JSON import-mode dialogs.
- v0.0.1 Drag-to-reorder columns, plus hide/show columns.
- v0.0.1 Swept Material Icons across chrome, panels, dialogs, and built-in plugins.
- v0.0.1 Added toast notifications and a confirm dialog.
- v0.0.1 Added a datetime column type, null highlighting, native date inputs.
- v0.0.1 Column resize handles with persisted width.
- v0.0.1 Constraint pre-flight scan; CSV paste via textarea.
- v0.0.1 Live preview of the top 100 rows in the column editor.
- v0.0.1 Made all modal dialogs draggable from their header.
- v0.0.1 Faceted per-column filter dropdown with value counts.
- v0.0.1 Window manager polish: minimize/maximize restore, smallify, import cascade.
- v0.0.1 CSV header mini-language: `field:label:type:default:max:flags`.
- v0.0.1 Row virtualization for tables with more than 200 rows.
- v0.0.1 URL-loaded plugins plus a Plugin Manager dialog.
- v0.0.1 Improved CSV date/datetime inference and normalization.
- v0.0.1 Moved color/image cell renderers to plugins; added a header-clock demo.

## 21 May 2026

- v0.0.0 Initial commit: sortable, filterable data-table with typed cell rendering.
- v0.0.0 New Table dialog with a column editor and reorder support.
- v0.0.0 Added a per-table CSV export plugin.
- v0.0.0 Multi-workspace support via a `?space=` URL parameter.
- v0.0.0 Added the Gist sync plugin (Push / Pull).
- v0.0.0 Global search across all tables, fixed to filter rows, not hide panels.
