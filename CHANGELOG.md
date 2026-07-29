# CHANGELOG

## 29 Jul 2026

- 📝 New `docs/tech/MEMORY.md`: every table loads fully into memory today — no windowed/paged loading yet (v0.0.171)

## 28 Jul 2026

- 🪲 `?safemode` now opens the Plugin Manager and marks the plugins it skipped, so nothing reads as enabled while it is off (v0.0.170)
- ✨ Plugin Manager filters: one tri-state Enabled chip, no separate Available chip, and fixed plugins are no longer hidden (v0.0.170)
- 🪲 A minimized view window no longer loads or holds its data. It loads when you expand it (v0.0.169)
- ✨ Table export gained a third choice, Structure Only: CSV writes just the headers, JSON the definition and settings, SQL only the CREATE (v0.0.168)
- ✨ The HTML preview popup keeps line breaks and literal `<` characters when the value is plain text, instead of mangling them as markup (v0.0.168)
- ✨ Each table's Export button offers CSV, JSON (`.table.json`) or SQL, then asks whether to export the visible data or everything (v0.0.168)
- 📝 Docs split in two: `docs/help/` is a screenshot-illustrated user guide, `docs/tech/` holds the developer notes (v0.0.163)
- 🪲 Safe mode: `?safemode` boots with no plugins, `?safemode1` without URL plugins; Plugin Manager filters by state (v0.0.162)
- ✨ New favicon, and the workspace title now shows in the browser tab (v0.0.159)
- 🪲 Typing a URL into a cell now turns it into a link as soon as you click away; script/image cells gained a pencil to edit (v0.0.158)
- ✨ Choice dialogs show the first option as the blue default button, focused on open; Enter picks it (v0.0.157)
- 🪲 Any column can now be dragged down to 10px, including link columns that refused to shrink; text/URLs end in an ellipsis (v0.0.156)
- 🪲 Maximized windows now follow a browser resize, fill the panel with no gap, and show a pointer cursor; double-click toggles it (v0.0.155)
- ✨ A `^` prefix in a column filter matches from the start of the cell (`^S`); the suggestion list hides when empty (v0.0.152)
- ✨ Drag-and-drop and Import now read `.tsv`/`.tab` files; tabs are kept even when cells contain commas (v0.0.151)
- ✨ Column filters got a tri-state checkbox per value: gray off, green include, red exclude — pick as many as you like (v0.0.150)

## 27 Jul 2026

- 🪲 Editing a built-in view template now turns it into a normal template (no more duplicate clones); every template gets Delete (v0.0.149)
- 🪲 The Settings dialog won't close while a secret field holds a raw value — must be empty or a `${secret:name}` reference (v0.0.148)
- 🪲 Views gained a Readonly option: a readonly view shows values without editors — no date picker, disabled checkboxes (v0.0.147)
- 🪶 Import now offers Copy vs Reference: a Reference is live and never stored/synced; a Copy's Refresh keeps your columns (v0.0.146)
- 🪶 Two HTML cell renderers: `html-preview` (truncated, popup for full) and `html` (renders in-cell); both editable (v0.0.143)
- 🪲 The column editor's live preview now hides columns marked hidden, matching the actual table (v0.0.142)
- 🪶 Closing a table window now hides it instead of deleting — reopen via Ctrl+K; a new trash button permanently deletes it (v0.0.139)
- 🪶 Gist sync now carries every workspace setting (no more excluded prefixes); Settings gained a Download secrets.txt button (v0.0.138)
- 🪶 The table info (ⓘ) dialog now explains whether a table is Connected (live) or Imported (snapshot, with a link to its origin) (v0.0.137)
- 🪶 Command palette (Ctrl+K): manage windows, jump to a table, run any action, plus Search/Plugins/Docs (v0.0.136)
- 🪶 Column filters gained operators: `!text`, `NULL`, `!NULL`; the dropdown adds a _(Blanks)_ entry and a hide checkbox to negate (v0.0.134)
- 🪲 Gist sync now syncs remote (backend-backed) tables by definition only — rows are never pushed, and a pull reconnects instead (v0.0.133)
- 🪶 New `html` cell renderer: shows a value as unescaped HTML inline; click a cell to open the full HTML in its own window (v0.0.132)
- 🪶 Gist Push and Pull now offer a scope choice — Everything, Data only (tables + rows), or Settings only (views + settings) (v0.0.131)

## 26 Jul 2026

- ✨ Removed the Gist plugin's own credentials dialog — configure Gist in Settings → Gist Sync instead (v0.0.130)
- 🪲 A Datasette name clash now prompts Overwrite / Rename / Skip instead of silently duplicating; checks are case-insensitive (v0.0.129)
- 🪲 Settings is now a fixed (always-on) plugin; Plugin Manager hides fixed plugins unless filtered, "Installed" lists built-ins (v0.0.125)
- 🪲 JSON dump export/import now round-trips view templates & instances plus per-table window geometry/title/filters (v0.0.123)
- 🪲 Gist pull restores full per-table state (position/size/stacking, sort, filters, view) and z-order; front-rank z is now unique (v0.0.117)
- ✨ The version number in the header is now a link to the changelog on GitHub (v0.0.115)
- 🪶 Plugin Manager can now filter plugins by type (importer, exporter, cell-renderer, sync, source, ui) (v0.0.115)
- 🪶 Workspace title is now editable in Settings → General and shown in the header instead of "easyDBAccess" (v0.0.109)
- 🪲 Every dialog now confirms its primary action on Ctrl+Enter; Esc still closes — fixed 5 dialogs missing the wiring (v0.0.109)
- 🪶 New views auto-map `$DATE`/`$URL`/`$DESCRIPTION` tokens to matching columns, and can cap rows via "Show at most" (v0.0.109)
- 🪶 Settings dialog: tabbed General + per-plugin tabs, two-layer workspace/user storage, secrets store with `${secret}` refs (v0.0.109)
- ✨ Escape cancels an in-progress cell edit without committing (v0.0.109)
- 🧪 Added Vitest coverage for JSON detection, type inference, and CSV parsing (v0.0.109)
- 🔧 Extracted window-geometry sanitizing into its own tested module (v0.0.109)
- ✨ Progress indicator added for large JSON imports (v0.0.109)
- 📝 Drafted a settings-dialog concept with per-plugin tabs (v0.0.109)
- 🪲 Fixed column resize; added a dedicated drag grip; left-aligned headers (v0.0.109)
- ✨ Moved sort/filter icons to the right edge of column headers (v0.0.109)
- 🪲 Datasette connect validates the table URL before creating a table (v0.0.109)
- 🪲 Plugin catalog resolves registry URLs against the app's deploy base (v0.0.109)
- 🪲 Gist pull handles GitHub-truncated files, reports per-table errors, warns on size (v0.0.109)
- 📝 Added a full project documentation set under `docs/` (v0.0.109)

## 25 Jul 2026

- ✨ Added a search box to view-window headers (v0.0.83)
- 🪲 CSV/JSON import failures now always surface a real reason, not "Load failed" (v0.0.83)
- ✨ Slow (>2s) URL imports show a top progress bar (v0.0.83)
- 🪶 Import dialog gained file upload, a per-column hide toggle, and a row limit (v0.0.83)
- ✨ Non-CORS GitHub blob/raw URLs auto-convert to raw.githubusercontent.com (v0.0.83)
- 🪶 View templates can be toggled on/off with an editable grid fallback (v0.0.83)
- 🪲 Fixed a filter reverting mid-edit when a store write landed during debounce (v0.0.83)
- 🪶 Datasette metadata now drives default sort, column descriptions, units, and an info dialog (v0.0.83)
- 🪲 Views reconnect automatically to a recreated same-named table (v0.0.83)
- ✨ Dialogs go full-screen on phone-sized viewports (v0.0.83)
- 🪶 Boolean search (AND/OR) with phrase-to-AND-to-OR fallback (v0.0.83)
- ✨ Panel titles show a live filtered row count (v0.0.83)
- 🪲 Datasette imports keep partial rows and can resume after rate-limiting (v0.0.83)
- ✨ Global search now applies to view windows too (v0.0.83)
- ✨ Import progress bar becomes proportional once the row count is known (v0.0.83)

## 24 Jul 2026

- 🪶 Per-table and header search: focus on open, collapse on click-outside (v0.0.55)
- 🪶 Tables drag anywhere unclamped; right-click drag pans the canvas on desktop (v0.0.55)
- ✨ Loading bar shown in the table header while rows load (v0.0.55)
- 🪲 Link cell renderer truncates to the available column width (v0.0.55)
- 🪶 Import: overwrite/rename on name collision, one toast, skip redundant table picker (v0.0.55)
- 🪶 CSV URL import added to the Import dialog (v0.0.55)
- ✨ Restores the last-active workspace when opening a new tab (v0.0.55)
- 🪲 Sort ranks nulls below blanks, floating nulls to the top ascending (v0.0.55)
- 🪲 Fixed duplicate-slug CSV imports; added a pre-import column editor (v0.0.55)
- ⚡ Table windows render immediately with progress bars; rows load lazily (v0.0.55)
- ⚡ Minimized windows fetch nothing until expanded, saving memory and requests (v0.0.55)
- 🪲 Maximize now fills the window correctly regardless of pan/zoom state (v0.0.55)
- 🪶 Added the View system: HTML templates + read-only per-table view windows (v0.0.55)
- 🪲 Fixed a multi-tab DB-upgrade hang; guides blocked tabs to reload (v0.0.55)
- ✨ Minimized windows now dock bottom-left, fixed against pan/zoom (v0.0.55)
- 🪶 View instances gained an editor; minimize/maximize state persists on reload (v0.0.55)

## 23 Jul 2026

- 🧪 Added a live-write smoke-test script against a real Datasette instance (v0.0.28)
- 🪶 Phase 2c: live read-write Datasette row collection (the write path) (v0.0.28)
- 🪶 Phase 2b: Connect-to-Datasette dialog for live read-write tables (v0.0.28)
- 🪶 Authenticate Datasette reads for private instances; fail writes gracefully (v0.0.28)
- 🪲 Fixed instance connect/import 404s; added a database-selection step (v0.0.28)
- 🪲 Explain blocked ("Load failed") Datasette fetches with a clear reason (v0.0.28)
- 🪲 Closing a live (source-backed) table window now removes it properly (v0.0.28)
- 🪲 Connect dialog reuses an existing live table instead of duplicating it (v0.0.28)
- 🔧 One shared, deduplicated live collection per connected table (v0.0.28)
- 🪶 Added a Refresh button to Datasette-backed import and connect tables (v0.0.28)
- 🪶 Mobile: responsive header, pan/zoom the table canvas (v0.0.28)

## 22 Jul 2026

- 🪶 Added the datasette-source plugin: import tables from any Datasette instance (v0.0.15)
- 🔧 Added a row-source routing seam so tables can be backed by live data (v0.0.15)
- 🪶 Replaced the sample-data button with a URL/source-picker Import dialog (v0.0.15)
- 🪶 Import supports a whole Datasette instance with a multi-table picker (v0.0.15)
- 🪲 Fixed Datasette paging and schema handling against real datasette.io responses (v0.0.15)
- ✨ Infer Datasette column types from row values when schema lacks them (v0.0.15)
- 🪶 Support importing an entire Datasette database (all its tables) (v0.0.15)
- 🪲 Give Datasette fetch failures a clear, actionable error message (v0.0.15)
- 🔧 Version now auto-bumps on every commit; title and header stay in sync (v0.0.15)
- 🪶 Table picker shows row counts, estimated size, and handles name collisions (v0.0.15)
- 🪲 Follow Datasette 1.0's `next` cursor when paging results (v0.0.15)

## 26 May 2026

- 🔧 Added `bulkRemove` to the data-store API; used for cascading deletes (v0.0.8)
- 🪶 Packaged the renderer for the desktop (Electron) edition (v0.0.8)
- 🔧 Replaced RxDB with Dexie for local storage (v0.0.8)
- 🪲 CSV import now matches columns by index, not by header name (v0.0.8)
- 🪶 `cell-link` detects email addresses, renders them as mailto: links (v0.0.8)
- 🪶 Cell image renderer supports data URIs or plain URLs (v0.0.8)
- ✨ Gist sync enforces GitHub's 100 MB per-file limit (v0.0.8)
- 🪶 Column editor: drag-reorder, color-picker-only cells, a row-delete bin icon (v0.0.8)

## 25 May 2026

- 🪲 Stopped reloading URL plugins unnecessarily (v0.0.7)
- 🔧 Confirmed Gists can exceed 1MB (v0.0.7)
- 🪲 Table titlebar stays visible even when its body is hidden (v0.0.7)
- 🪶 Draggable dialogs, plugin caching, and a more robust URL-loader (v0.0.7)

## 24 May 2026

- 🧪 e2e coverage: columns editor, cell editing, import/export, filters, window manager, UI (v0.0.6)
- 🔧 CI pinned to Node 22 so `node:sqlite` resolves (v0.0.6)
- 🪲 Fixed jspanel4's broken CSS sourcemap warning in Vite (v0.0.6)
- 🪶 Added the auto-sync plugin, SQL export, and release workflow tweaks (v0.0.6)
- 🪶 SQL export writes date columns as 'YYYYMMDD' string literals (v0.0.6)
- 🔧 Switched the release pipeline to Node 24 (v0.0.6)
- 🪶 Backend: `/fetch` proxy + `/plugins/registry` routes added (v0.0.6)
- 🔧 `filter-combobox` replaces the native datalist; `cell-link` moved to the catalog (v0.0.6)
- 🪶 `column.renderer` separates display from the column's data type (v0.0.6)
- 🪶 Built-in `script` cell renderer for per-column custom rendering (v0.0.6)

## 23 May 2026

- ✨ Close (×) button added to all dialogs (v0.0.3)
- 🪶 `cell-link` plugin renders URL/phone strings as clickable links (v0.0.3)
- 🪶 Autocomplete on filter inputs for low-cardinality columns (v0.0.3)
- 🪶 Faceted filter values for drill-down search, matching minniDBMax v1 (v0.0.3)
- 🪶 Server-side sync engines added (v0.0.3)
- 🪶 Dynamic plugin loading and a sample-data plugin (v0.0.3)
- 🧪 e2e test harness, per-package CLAUDE.md docs, and a CI workflow (v0.0.3)

## 22 May 2026

- ⚡ Imported v1 minniDBMax dumps; improved `bulkInsert` performance (v0.0.1)
- 🔧 Moved "+ New Table" out of the shell into a plugin (v0.0.1)
- 🧪 Added Northwind sample data for import tests (v0.0.1)
- 🪶 Persist window z-order across reload (v0.0.1)
- 🪶 Added `api.ui.dialogs` primitives: alert / prompt / choice (v0.0.1)
- 🪶 Per-table local search, collapsible UX, moved into the panel titlebar (v0.0.1)
- ✨ Row count in panel title, subtle delete icon, right-aligned numbers (v0.0.1)
- 🪶 Column constraints enforced: default, max, unique, notnull (v0.0.1)
- 🪶 Added CSV and JSON import-mode dialogs (v0.0.1)
- 🪶 Drag-to-reorder columns, plus hide/show columns (v0.0.1)
- ✨ Swept Material Icons across chrome, panels, dialogs, and built-in plugins (v0.0.1)
- 🪶 Added toast notifications and a confirm dialog (v0.0.1)
- 🪶 Added a datetime column type, null highlighting, native date inputs (v0.0.1)
- 🪶 Column resize handles with persisted width (v0.0.1)
- 🪶 Constraint pre-flight scan; CSV paste via textarea (v0.0.1)
- 🪶 Live preview of the top 100 rows in the column editor (v0.0.1)
- ✨ Made all modal dialogs draggable from their header (v0.0.1)
- 🪶 Faceted per-column filter dropdown with value counts (v0.0.1)
- ✨ Window manager polish: minimize/maximize restore, smallify, import cascade (v0.0.1)
- 🪶 CSV header mini-language: `field:label:type:default:max:flags` (v0.0.1)
- ⚡ Row virtualization for tables with more than 200 rows (v0.0.1)
- 🪶 URL-loaded plugins plus a Plugin Manager dialog (v0.0.1)
- ✨ Improved CSV date/datetime inference and normalization (v0.0.1)
- 🔧 Moved color/image cell renderers to plugins; added a header-clock demo (v0.0.1)

## 21 May 2026

- 🪶 Initial commit: sortable, filterable data-table with typed cell rendering (v0.0.0)
- 🪶 New Table dialog with a column editor and reorder support (v0.0.0)
- 🪶 Added a per-table CSV export plugin (v0.0.0)
- 🪶 Multi-workspace support via a `?space=` URL parameter (v0.0.0)
- 🪶 Added the Gist sync plugin (Push / Pull) (v0.0.0)
- 🪲 Global search across all tables, fixed to filter rows, not hide panels (v0.0.0)
