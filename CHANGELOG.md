# CHANGELOG

## 9 Aug 2026

### Chores

- 🔧 CI workflows warned that their actions still ran on the deprecated Node 20 (v0.0.325)

## 6 Aug 2026

### Features

- ✨ Commandlets: a Default commandlet setting maps a plain `#anchor`, the palette offers to run one you type, and the dialog checks it live (v0.0.324)
- 🪶 Commandlets: `goto/bible?Book=Matthew` opens and filters a table from a cell link, a `#hash`, `?cmdlet=` or the palette (v0.0.322)
- ✨ Startup tip dialog, compiled from the help page: walk tips with ‹ ›, "Show tip" in the palette, or turn it off (v0.0.319)

### Bugs

- 🪲 A link to an anchor on the same page opened a new tab and reloaded the workspace (v0.0.323)
- 🪲 A filter on a column that does not exist emptied a table, with no funnel to clear it (v0.0.323)

### Chores

- 🔧 Desktop app drops its unused `@easydb/server` dependency, which was breaking the installer build (v0.0.321)

## 5 Aug 2026

### Features

- ✨ Every filter a view template offers has a chip in the toolbar, and a chip switched off stays there (v0.0.314)

## 4 Aug 2026

### Features

- 🪶 Move desktop app to SQLite storage and support larger databases. User can import .db files and save as .edb (v0.0.311)
- ✨ An `array` column shows its values as pills, one per value, with a pencil for the raw list (v0.0.296)
- 🪶 New `array` column type: a cell holds several values (`foo,bar` or `["Foo","Bar"]`) and the filter dropdown offers each one (v0.0.295)
- ✨ New `markdown` cell renderer: one line of text in the grid, the formatted value in the popup, and never guessed at (v0.0.298)
- ✨ `$filter.TAGS` in a view renders one chip per value of an `array` field, and each chip filters on that value (v0.0.311)
- 🪶 A file dropped on a table, or naming one, offers Re-Create / Re-Load / Append / A new table — and maps mismatched columns (v0.0.311)
- 🪶 Workspace commands in the palette — switch, new and delete; deleting takes the workspace's tables, rows, views and settings with it (v0.0.305)
- ✨ A twikki dump converts to importable `.table.json` tables, one per twikki package (v0.0.306)
- 🪶 A big table opens fast: the grid, views and projections now ask the store for the rows they show instead of reading the whole table (v0.0.309)
- 🪶 A `.db` import runs in the background on a worker thread, so the app stays usable while it copies (v0.0.309)
- 🪶 Converting or importing a `.db` shows one progress bar for the whole file, weighted by how big each table is (v0.0.309)
- 🪶 Workspace files are `.edb`; a plain `.db` can be imported, appended onto a table that already exists, or browsed read-only (v0.0.309)
- 🪶 Importing a `.db` picks its tables and views with checkboxes, and a view can arrive as a projection or as a snapshot (v0.0.309)
- ✨ The columns editor's checkbox headers set or clear their whole column, and 👁 moved to the front of the row (v0.0.309)

### Bugs

- 🪲 Markdown that mentions a tag, like `/<database>/-/create`, was read as HTML: the word vanished and the formatting stayed literal (v0.0.297)
- 🪲 A `<word>` that is no HTML element, like `<database>`, was dropped from a rendered Markdown value (v0.0.299)
- 🪲 A setting holding `${secret:name}` was overwritten with the secret itself, which then synced (v0.0.300)
- 🪲 A gist kept the file of a table deleted locally, so the next pull brought the table back (v0.0.301)
- 🪲 A read-only table offered a Save button on its `preview`, `markdown` and `html` cells (v0.0.302)
- 🪲 Dragging in a `.table.json` and choosing "Add as new table" made a second table with the same name (v0.0.304)
- 🪲 Renaming a field emptied the column in a projection, and left a join on that field matching nothing (v0.0.311)
- 🪲 Filtering, searching or sorting a table above 20,000 rows only saw the first 20,000 and confidently showed the wrong ones (v0.0.309)
- 🪲 The panel title lost its `shown/total` count a moment after a filter was typed (v0.0.309)
- 🪲 The app crashed on startup with a large workspace, and an unfinished import restarted itself (v0.0.309)
- 🪲 The UI froze while a `.db` imported (v0.0.309)

## 3 Aug 2026

### Features

- ✨ Clicking a column header sorts descending first, then ascending — Settings → Table grid turns it around (v0.0.293)
- ✨ Importing a `.db` lists its tables and views as checkboxes in separate sections, each with its own all/none; a view can come in as a Projection or as Data (v0.0.292)
- ✨ Importing a `.db` onto a table that already exists offers Append: the rows are added and the table's own columns are left alone, with a column mapper when the names differ (v0.0.291)
- ✨ Save As names the file after the workspace (v0.0.291)
- ✨ A view's filter chip is `field = value` now, in the same bar as the sort: the field cycles = / ≠ / off, the value opens a checklist of the field's other values (v0.0.291)
- ✨ Workspace files are `.edb` now: drop one to open it, drop a plain `.db` to import its data — no question asked (v0.0.290)
- ✨ The app opens a workspace named on the command line, and a setting controls whether the last one reopens on startup (v0.0.290)
- ✨ Importing a `.db` runs on a worker thread, so the window stays responsive while it copies (v0.0.289)
- ✨ Esc closes a preview popup or its source editor, like it closes a dialog (v0.0.289)
- ✨ A view's filter chip lists the field's other values, so a second value can be OR-ed in by clicking (v0.0.289)
- ✨ A column filter takes `AND`: `!NULL AND Biden` needs both, and `OR` spells out the comma (v0.0.288)
- ✨ Importing or converting a `.db` shows its tables at once and fills each one in with its own percentage (v0.0.286)
- ✨ Convert to EDA asks which tables to take, with a shortcut that skips the views (v0.0.286)
- ✨ The `html-preview` cell renderer is called `preview` now, and shows a Markdown value as formatted text by itself (v0.0.282)
- ✨ The `html` cell renderer has a pencil for the source, so a link inside the cell can be clicked (v0.0.281)
- ✨ The command-palette launcher is an icon button on the header's utility side now, beside search, plugins, help and settings (v0.0.278)
- ✨ "Go to" a table or view now brings its window on screen: the canvas pans to it on desktop, and it fills the screen on a phone (v0.0.275)
- ✨ Drop a CSV on a table window to append to it, replace its rows, or make a new table; append opens a column mapper (v0.0.274)

### Bugs

- 🪲 A cell with a renderer ignored the column width: `preview` cut at 30 characters and a long value widened the whole column (v0.0.294)
- 🪲 An id past 2^53 (e.g. 1298624375692894210) was rounded on import — silently a different id (v0.0.292)
- 🪲 The app crashed on startup after converting a large database: every open window fetched its whole table, 1.9 million rows between them (v0.0.288)
- 🪲 An unfinished conversion restarted its import on every launch, unprompted and with no way to stop it (v0.0.288)
- 🪲 The app froze while a `.db` imported — clicks and windows stopped responding until it finished (v0.0.287)
- 🪲 Converting a `.db` left the app with no window for 15 seconds, and every table that finished importing made all the others re-read their rows (v0.0.286)
- 🪲 Every click inside a window re-ordered the windows while a minimized one sat above it; a second finger hijacked a drag or resize (v0.0.283)
- 🪲 A column script's Markdown output showed its HTML tags as text when the cell already held HTML (v0.0.281)
- 🪲 Editing an HTML cell on a scripted column saved the computed output over the stored source (v0.0.281)
- 🪲 A photo column read out of a database showed "no image": the renderer took only URLs and data URIs, never the image's own bytes (v0.0.277)
- 🪲 A minimized window changed colour in the dock (v0.0.276)
- 🪲 A file dropped on a table window was ignored, and the browser left the app to open it (v0.0.274)
- 🪲 The unsaved-work prompt could still stop a reload for a moment after the editor was closed (v0.0.272)
- 🪲 A window that had never been moved reopened at the top-left, and a bit too small, after being minimized (v0.0.272)
- 🪲 A window closed right after a drag could come back open (v0.0.272)
- 🪲 A collapsed window reopened at the default size and position, and no longer collapsed (v0.0.272)

### Chores

- 🔧 `npm run lint` reported 55 errors of standing debt: untyped Datasette response JSON, dead locals, and rethrows that dropped the original error (v0.0.290)

### Tests

- 🧪 The window-stacking specs waited on fixed sleeps for a view's saved front rank, so a slow write failed them (v0.0.286)

### Chores

- 🔧 The table window manager was still named after jsPanel, and a cell renderer had to import it to read the canvas zoom (v0.0.287)

## 2 Aug 2026

### Features

- ✨ Projections: virtual tables that JOIN real tables — a join editor with FK-name preselect, self-joins, inherited column settings, and a row limit; joined columns are editable and write back to their own table (v0.0.265)
- ✨ Import `.sql` scripts as tables and projections (v0.0.258); import a Datasette view as a snapshot table, and copy any table or projection (v0.0.262)
- ✨ A markdown helper for column scripts, and projections bind to their base by name so a recreated table reconnects (v0.0.260)
- ✨ A command palette launcher (`>`) button in the header (v0.0.247)
- ✨ The column editor's read-only flag now works per column, and the data table honors it (v0.0.241)

### Bugs

- 🪲 A refresh clobbered the user's own column values when the source had no primary key (v0.0.263)
- 🪲 On mobile a restored window lost its size, and "Open" on a view did not show it (v0.0.261); the HTML preview and editor now open maximized there (v0.0.259)
- 🪲 Datasette paging followed the server's scheme instead of the requested one, breaking https-proxied cursors (v0.0.255)
- 🪲 The Edit Join dialog offered only the selected fields instead of every source field (v0.0.254)
- 🪲 The view header's filter control sat mid-header instead of at the far right (v0.0.264)
- 🪲 Restoring a JSON dump dropped the read-only flag on columns (v0.0.244)

## 31 Jul 2026

### Features

- ✨ Floating windows run on an in-repo panel shell instead of jsPanel4: restored windows keep maximized state, drags track any zoom (v0.0.235)

## 30 Jul 2026

### Features

- ✨ The columns editor and the Settings dialog hold on to unsaved edits: the browser asks before it reloads or leaves the page (v0.0.234)
- ✨ The command palette keeps the last five commands in a "Recent" section at the top, so Ctrl+K Enter runs the last one again (v0.0.230)
- ✨ A table can be set read-only in the column editor, and a referenced table is read-only from the moment it is created (v0.0.227)
- ✨ A `$filter.TOKEN` in a view template shows the value as a pill: click it to narrow the view to that value, and drop it from the chip in the view header (v0.0.226)
- ✨ A column filter takes `=text` for an exact match, and `!=text` to exclude one (v0.0.226)
- ✨ A dropped CSV asks first: import directly, or review the columns (v0.0.225)
- ✨ Any view template can be deleted, built-ins included — the confirm says a deleted built-in is not seeded again (v0.0.224)
- ✨ Gallery cards are clickable: `$LINK` opens the row's URL in a new tab (v0.0.223)
- ✨ A settings field can carry help behind an (i) icon; the GitHub token links to the page that creates one (v0.0.222)
- ✨ The column editor has a "Guess renderers" button: it picks a renderer per column from the values, then you press Save (v0.0.220)
- ✨ A cell shows its full value as a tooltip, so a column narrower than its content is still readable (v0.0.219)
- 🪶 Sort by several columns: shift-click a header to add a sort level behind the ones already active (v0.0.218)
- ✨ The column editor can turn off sorting or filtering per column; an unfilterable column is skipped by search too (v0.0.216)
- ✨ An empty cell is pink and a value that does not fit its column type gets a red outline, under every renderer (v0.0.211)
- 🪶 Settings belong to a workspace now, and a new workspace asks what to take over: everything, settings only, or nothing (v0.0.207)
- ✨ Datasette limits are now settings: max import rows (0 = unlimited), page size, connected-table cap, rate-limit wait (v0.0.208)
- ✨ After a gist pull you are offered the local tables and views the gist does not have, to delete or keep (v0.0.205)
- ✨ A boolean column's filter dropdown always lists true and false, even when no row carries one of them (v0.0.203)
- ✨ A Help (?) button in the header opens the user guide in a new tab (v0.0.202)
- ✨ A view window footer has a Delete button now: it asks first, then removes the view and closes the window (v0.0.200)
- ✨ A built-in view template has no Delete button now. Copy it first if you want a version you can delete (v0.0.199)
- ✨ A view now has a Copy button: the copy picks up columns added to the table since, and keeps template, filters and sort (v0.0.196)
- ✨ Views gained a sort bar: pick a column and a direction, kept on the view, and the rows re-sort live (v0.0.193)
- ✨ Search now takes `field:value` terms in tables and views: negate, starts-with, comma-OR and NULL all work (v0.0.193)
- ✨ Three new view templates: Todo List with a tick box, Gallery as an image grid, and Contact Cards (v0.0.193)
- ✨ A `$input.TOKEN` in a view template is now an editable control for its column: checkbox, number or text. It writes back to the row (v0.0.192)

### Bugs

- 🪲 A command picked from the palette started a moment late, after the palette had saved its history (v0.0.233)
- 🪲 The pencil on a script-generated link opened the computed URL and then dropped the edit (v0.0.232)
- 🪲 A scripted column was blank in a view, and a view could not filter or sort on one (v0.0.231)
- 🪲 Importing a workspace, or pulling one from a Gist, added a second copy of every view template the workspace already had (v0.0.229)
- 🪲 A view window's title counted against the source table, so a view showing a slice of it never read as complete (v0.0.228)
- 🪲 Referencing a Datasette database took every table without asking, and each reference stopped at its first 1000 rows (v0.0.227)
- 🪲 Re-importing a table exported as JSON lost all but one row, and its refresh URL (v0.0.221)
- 🪲 Renaming a field in the column editor lost its data (v0.0.218)
- 🪲 Two view templates can no longer share a name; `window.api` now exposes the plugin API for console scripting (v0.0.210)
- 🪲 A tiled or cascaded layout survives a reload — the arrangement is stored, not only drawn (v0.0.209)
- 🪲 A click outside the command palette closes it, like Esc already did (v0.0.206)
- 🪲 Settings will not close while a field points at a `${secret:name}` the store does not have (v0.0.204)
- 🪲 A maximized window that you minimize comes back maximized, in this session and after a reload (v0.0.201)
- 🪲 Two jsPanel callbacks for one action no longer overwrite each other's window geometry (v0.0.201)
- 🪲 Publish now switches the GitHub Pages repo to master first, so a deploy from a detached HEAD cannot silently reach nobody (v0.0.197)

## 29 Jul 2026

### Features

- ✨ New Auto Renderer plugin: after any import, columns get an appropriate renderer from their values (v0.0.191)
- ✨ Each window titlebar now starts with an icon for its kind (local, imported, referenced etc) (v0.0.184)
- ✨ The boolean renderer now tells empty apart from false: a grayed checkbox for empty, red-bordered raw text for an invalid value (v0.0.183)
- ✨ The date, datetime, boolean and script renderers are now four separate plugins you can turn off individually (v0.0.183)
- ✨ Any column can carry a script now: its `render(row)` output is what the column's renderer displays (v0.0.181)
- ✨ A GitHub file URL now imports its real content: the blob link becomes the raw link, and a Git-LFS file is fetched from the media host (v0.0.180)
- ✨ One header Connect button lists every installed backend, instead of one button per backend (v0.0.178)
- 🪶 The Datasette plugin split into Import and Connect, so each can be switched off on its own (v0.0.177)
- 🪶 Import dialog split in two blocks: the options every format shares, then the chosen format's own. CSV gained a Separator field (v0.0.176)
- ✨ "Import into" lets you pick new table, append or replace up front, instead of a modal interrupting the import (v0.0.176)
- ✨ "Edit columns before import" and "Limit rows" now work for JSON and Datasette, not only CSV (v0.0.176)
- 🪶 A `.db.json` dump is now offered as a workspace restore, keeping window layout and views, not flattened into tables (v0.0.176)
- ✨ The delete-table trash icon is now dark red instead of inheriting the button's default color (v0.0.174)

### Bugs

- 🪲 The e2e backing server port is now resolved per branch instead of a shared 3998, so two worktrees can run the suite at once (v0.0.193)
- 🪲 Tile and Cascade now leave minimized windows alone, instead of restoring them and reserving empty cells for them (v0.0.192)
- 🪲 A JSON column of URLs was typed as a date, which locked out the link renderer (v0.0.191)
- 🪲 Reloading now keeps windows stacked as you left them: views no longer jump in front of tables (v0.0.185)
- 🪲 An invalid stored value is shown with a red border and a pencil to fix it, instead of being blanked or coerced (v0.0.183)
- 🪲 A boolean column with no renderer now shows its raw value, not a checkbox that hid empty and invalid data (v0.0.183)
- 🪲 Saving the column editor no longer discards a column's width, description, units, sortable flag or default (v0.0.183)
- 🪲 Refreshing a CSV or JSON table now finds columns the source has added and keeps columns you added yourself (v0.0.179)
- 🪲 Dev/e2e server port now resolves per branch instead of hardcoded 5190; a taken port fails loudly instead of drifting (v0.0.176)
- 🪲 The pre-import column editor renamed columns without moving their values, so a renamed column came out empty (v0.0.176)

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
