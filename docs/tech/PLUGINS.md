# Plugins

easyDBAccess has (almost) no built-in features — it has a plugin host and a
folder of plugins that ship enabled by default. New Table, CSV import, cell
renderers, Gist sync: all of it is a plugin, loaded through the exact same
mechanism a third-party URL-loaded plugin would use. If a feature can be a
plugin, it is one. The contract lives in
[`packages/shared/src/plugin-api.ts`](../../packages/shared/src/plugin-api.ts) —
read that file before changing plugin-host code.

## What a plugin is

A plugin is a single ES module exporting `meta`, `init(api)`, and optionally
`load(api)`:

```ts
export const meta = {
  id: 'cell-color',
  name: 'Cell Color',
  type: 'cell-renderer', // 'importer' | 'exporter' | 'cell-renderer' | 'sync' | 'source' | 'ui'
  version: '0.1.0',
  description: 'Renderer for hex colour values.',
  icon: '<svg …>', // shown next to the plugin in the manager
  repo: 'https://github.com/…/cell-color.ts', // "view source" link
};

export function init(api: HostApi): void {
  api.ui.registerCellRenderer('color', 'cell-color');
}
```

- `init()` runs once at boot (or on hot-install from the Plugin Manager).
- `load()` runs once the app shell is ready (`app:ready`) — used for anything
  that should wait until the workspace/UI has settled (e.g. `auto-sync`'s
  polling timer, `views`' template seeding).
- `meta.id` is the stable kebab-case key used everywhere a plugin is
  referenced by identity (the `builtin:<id>` disabled-state key, the
  catalog, the Plugin Manager list). `meta.type` is a single primary
  functional category that drives the Plugin Manager's "by type" filter —
  every built-in declares one.
- **Every built-in defaults to user-toggleable from the Plugin Manager.**
  Only `meta.fixed = true` opts a plugin _out_ of that — it becomes
  always-on and never shows a toggle. Today only `settings` is fixed;
  everything else (including things you might assume are load-bearing, like
  `new-table-button`, `csv-import`, or any of the `cell-date`/`cell-datetime`/
  `cell-boolean` renderers) can be disabled by the user. Toggle
  state is stored under the synthetic key `builtin:<id>` in the `plugins`
  collection. (The Plugin Manager button itself is **core**, not a plugin —
  a header button in `app-shell.ts`.)

**Built-in vs. third-party** is purely a delivery mechanism. Built-ins
(`packages/renderer/src/plugins/*.ts`) are static-imported and listed in
[`plugin-host/loader.ts`](../../packages/renderer/src/plugin-host/loader.ts).
Third-party plugins are a `.js` URL (added via the Plugin Manager or listed in
`public/plugins/catalog.json`), fetched, wrapped in a Blob URL, and
dynamic-`import()`ed — so unlike built-ins they must be fully self-contained
(no bare `import 'lit'`-style imports).

## The `HostApi` surface — where plugins hook in

Every plugin gets one `api` object. The pieces plugins actually touch:

| Surface                                           | Purpose                                                                                                                          | Example call                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `api.ui.registerHeaderButton`                     | Button in the top chrome (global actions)                                                                                        | `new-table-button` adds "+ New Table"                      |
| `api.ui.registerFooterButton`                     | Button in the bottom bar (workspace-level actions)                                                                               | `gist-sync` adds a single "Gist" menu button               |
| `api.ui.registerTableButton`                      | Per-table button in a table's window titlebar                                                                                    | `csv-export` adds a "CSV" download button                  |
| `api.ui.registerCellRenderer(name, tag)`          | Custom element for a column whose `renderer` field matches `name`                                                                | `cell-color` registers `<cell-color>` under `'color'`      |
| `api.ui.registerImporter` / `registerExporter`    | Named format handlers (drop handlers, the Import dialog, the Export dialog's format list)                                               | `csv-import`, `csv-export`                                 |
| `api.ui.registerDropHandler`                      | Intercept a file/text drag-drop onto the canvas                                                                                  | `csv-import`, `json-import`, `datasette-import`            |
| `api.ui.registerUrlSource`                        | A named "import from URL" flow                                                                                                   | `datasette-import`                                         |
| `api.ui.registerConnector`                        | A live-backend CONNECT flow, listed by the Connect menu                                                                          | `datasette-connect`                                        |
| `api.ui.registerSettings(pluginId, name, fields)` | Declares a settings tab (rendered by the Settings dialog)                                                                        | `gist-sync`'s `user`/`gist_id`/`gist_token` fields         |
| `api.ui.openSettings()`                           | Opens the Settings dialog                                                                                                        | the `settings` built-in's header gear button               |
| `api.settings`                                    | Layered settings accessor (`get`/`set`/`placement`) — user layer shadows workspace layer, resolves `${secret:name}` refs on read | `gist-sync`, `server-sync` reading their config            |
| `api.ui.dialogs`                                  | Promise-based alert/confirm/prompt/choice/toast                                                                                  | used everywhere instead of `window.*`                      |
| `api.store`                                       | The `DataStore` (tables, rows, settings, plugins, view templates/instances)                                                      | every plugin that persists data                            |
| `api.registerRowSource`                           | Backs a table carrying a `source` descriptor with a non-local row collection                                                     | `datasette-connect`                                        |
| `api.events`                                      | Typed pub/sub (`AppEvents`)                                                                                                      | `import:before`/`import:after`, `plugin:error`             |
| `api.backend.fetch` / `saveFile`                  | CORS-aware fetch (proxied through the Hono server in browser mode) and a save-file abstraction                                   | `import-data`, `gist-sync`, all exporters                  |
| `api.windows`                                     | Open/list/find panel-shell-backed windows                                                                                        | the core window manager; plugins rarely call this directly |

A `ButtonSpec.onClick(api, ctx?)` handler for a header/footer button
optionally receives `ctx.anchor` — the button's own DOM element, when the
host can supply it — so the handler can position a popover/menu under the
button rather than guessing a fixed corner. See `DIALOGS.md`'s anchored-menu
section for the shared primitive this enables.

Plugins **may monkey-patch any `api.*` method** to override default
behaviour — the host doesn't police it. This is deliberate, not a bug.

## Built-in plugin roster

Load order matches `plugin-host/loader.ts`. "Fixed" means the plugin has no
toggle in the Plugin Manager and can never be disabled; every other row
defaults to enabled but **can** be turned off by the user.

| Plugin              | Type          | Fixed | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Main hooks                                                         |
| ------------------- | ------------- | :---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `settings`          | ui            |       | Header gear button that opens the tabbed Settings dialog; drag-and-drop a `secrets.txt` to import the device-local secrets store.                                                                                                                                                                                                                                                                                                                                | `registerHeaderButton`, `registerDropHandler`                      |
| `new-table-button`  | ui            |       | Adds the "+ New Table" header button that opens the table-creation dialog.                                                                                                                                                                                                                                                                                                                                                                                       | `registerHeaderButton`                                             |
| `csv-import`        | importer      |       | Drag-and-drop or paste CSV to create a typed table; infers column types and a `field:label:type:default:max:flags` header mini-language; append/overwrite/new-table prompt on name collision.                                                                                                                                                                                                                                                                    | `registerImporter`, `registerDropHandler`, `registerHeaderButton`  |
| `json-import`       | importer      |       | Drag-and-drop JSON — native `.db.json` dumps, legacy v1 minniDBMax dumps, or plain arrays/objects — with a table picker for multi-table dumps.                                                                                                                                                                                                                                                                                                                   | `registerImporter`, `registerDropHandler`                          |
| `datasette-import`  | importer      |       | IMPORT snapshot tables from any online [Datasette](https://datasette.io/) instance by URL — single table, whole database, or entire instance with a table checklist. Rows are stored locally and synced. Supports resumable paged imports, a per-table Refresh (re-fetch + merge by primary key) and a red Resume button.                                                                                                                                        | `registerTableButton`, `registerUrlSource`, `registerDropHandler`  |
| `connect-menu`      | ui            |       | Header "Connect" button plus a Ctrl+K command. Lists every registered `ConnectorSpec`; with one installed it opens that backend directly, with several it shows an anchored menu. Knows no backend itself.                                                                                                                                                                                                                                                       | `registerHeaderButton`, `registerCommand`                          |
| `datasette-connect` | source        |       | CONNECT a live, read-write Datasette table. Rows are fetched on demand and never stored locally; the table carries `source: { type: 'datasette' }` and the routed store hands it `datasette-collection.ts`. Its Refresh re-reads the remote instead of merging.                                                                                                                                                                                                  | `registerHeaderButton`, `registerTableButton`, `registerRowSource` |
| `csv-export`        | exporter      |       | The `csv` format and its options panel: separator, header row, BOM, line ends, and a typed header in the importer's own mini-language.                                                                                                                                                                                                                                                                                                                                                                       | `registerExporter`, `registerTableButton`                          |
| `dump-export`       | exporter      |       | The two buttons that open the export dialog, plus `serializeWorkspace` — the `.db.json` wire format the sync plugins share.                                                                                                                                                                                                                                                                                | `registerFooterButton`                                             |
| `sql-export`        | exporter      |       | The `sql` format: `CREATE TABLE` + `INSERT` per table, a projection as the SELECT behind it.                                                                                                                                                                                                                                                                  | none (library only)                                                |
| `gist-sync`         | sync          |       | Footer "Gist" menu button (Push/Pull/Settings/Share/View gist) plus a per-table "Gist" menu (push/pull/view just that table's file) that store the workspace as a private GitHub Gist. Credentials are Settings-dialog fields (`user`/`gist_id` workspace-scope, `gist_token` a user-scope secret).                                                                                                                                                              | `registerFooterButton`, `registerTableButton`, `registerSettings`  |
| `server-sync`       | sync          |       | Footer "Sync" menu button (Push/Pull) against a configured easyDBAccess Hono server, with ETag-based conflict detection.                                                                                                                                                                                                                                                                                                                                         | `registerFooterButton`, `registerSettings`                         |
| `cell-date`         | cell-renderer |       | `date` renderer: a native `<input type=date>` picker.                                                                                                                                                                                                                                                                                                                                                                                                            | `registerCellRenderer`                                             |
| `cell-datetime`     | cell-renderer |       | `datetime` renderer: a native `<input type=datetime-local>` picker.                                                                                                                                                                                                                                                                                                                                                                                              | `registerCellRenderer`                                             |
| `cell-boolean`      | cell-renderer |       | `boolean` renderer: a native checkbox.                                                                                                                                                                                                                                                                                                                                                                                                                           | `registerCellRenderer`                                             |
| `cell-color`        | cell-renderer |       | `color` renderer: a native `<input type=color>` swatch picker for hex values.                                                                                                                                                                                                                                                                                                                                                                                    | `registerCellRenderer`                                             |
| `cell-image`        | cell-renderer |       | `image` renderer: thumbnail + upload button; stores images as `data:` URIs.                                                                                                                                                                                                                                                                                                                                                                                      | `registerCellRenderer`                                             |
| `cell-tags`         | cell-renderer |       | `tags` renderer for `array` columns: one pill per value of the list, with a pencil to edit the raw list. Set automatically on an `array` column at import time.                                                                                                                                                                                                                                                                                                  | `registerCellRenderer`                                             |
| `cell-markdown`     | cell-renderer |       | `markdown` renderer for a column written in Markdown: one line of flattened plain text in the cell, the formatted value in the popup, clicking the text edits the source. Shares its cell with `preview` (`preview-cell.ts`) but never guesses the language.                                                                                                                                                                                                     | `registerCellRenderer`                                             |
| `cell-link`         | cell-renderer |       | `link` renderer: detects http(s) URLs, email addresses, and phone numbers per-value and renders the matching `<a>` (target `_blank`/`mailto:`/`tel:`), with a pencil to switch to raw-text edit mode.                                                                                                                                                                                                                                                            | `registerCellRenderer`                                             |
| `import-data`       | importer      |       | Header "Import" button — a URL/file dialog with curated sample sources (Northwind JSON, a public CSV, Datasette examples) that runs `csv-import` and `json-import` through the import kernel and still routes Datasette to `datasette-import`; recognises a native `.db.json` dump and offers to restore the workspace instead of importing its tables; adds a per-table Refresh button for CSV/JSON snapshot origins.                                           | `registerHeaderButton`, `registerTableButton`                      |
| `auto-sync`         | sync          |       | Background timer (1 min) that silently pushes local changes to the configured sync server and prompts to pull when the server has diverged. Shares its config with `server-sync` via `api.settings`.                                                                                                                                                                                                                                                             | `load()` (timer)                                                   |
| `views`             | ui            |       | The View system: workspace-global HTML templates (header/row/footer with `$TOKEN` substitution) rendered read-only per table in their own windows, with auto-mapped tokens and an optional row limit; seeds a default "RSS Feed" template. Footer "Views" button opens the manager dialog; window lifecycle itself is core, not plugin, code.                                                                                                                    | `registerTableButton`, `load()` (template seeding)                 |
| `validate`          | ui            |       | Footer ✓ button that checks every row against its columns' rules — `notnull`, `max`, `unique` and a `validate` script — and writes what it finds into a `<table> issues` table. Pages through the rows, reports progress, stops on Esc. Shares its rules with the columns editor's Save pre-flight (`table/validate-rules.ts`). | `registerTableButton` |
| `viz-charts`        | ui            |       | Bar, column, line and pie visualizations, registered via `registerVisualization`. A chart is a `ViewTemplate` whose `kind` is `'viz'`; see [`VISUALIZATIONS.md`](./VISUALIZATIONS.md). Chart.js is lazily imported, so a user who never opens a chart downloads none of it.                                                                                                                                                                                                | `registerVisualization`                                            |
| `viz-map`           | ui            |       | The `map` kind: rows with latitude/longitude columns plotted on raster tiles (Leaflet, lazily imported). Its own plugin because it carries its own library AND a network dependency — the tile URL is a workspace setting, and a tile failure still plots the points.                                                                                                                                                                                          | `registerVisualization`                                            |
| `viz-wordcloud`     | ui            |       | The `wordcloud` kind: term frequency over a text column, laid out with `d3-cloud` (lazily imported) into our own SVG. Tokenisation and counting live in the pure `viz/word-frequency.ts`.                                                                                                                                                                                                                                                                     | `registerVisualization`                                            |
| `viz-custom`        | ui            |       | The `custom` kind: the user's own HTML drawn over the rows the pane was given, with dataset-level `$COUNT` / `$SUM.field` / `$filter.field` tokens (`viz/viz-tokens.ts`) and an optional `render(rows, api)` script. The only visualization with `channels: []` — the markup names its own columns. Its `$filter.` pills narrow the HOST grid through `table/pane-actions.ts`. | `registerVisualization`                                            |
| `electron-db`       | ui            |       | Footer "Database" button → an anchored Open… / Save As… / Import… menu for `.db` files. **Electron-only, and silent about it:** `init()` returns immediately when `window.easydb?.db` is absent, so the browser build gets no button, no menu entry and no error. Open only accepts a file this app wrote and offers Import for a foreign one; Import previews first and asks Overwrite / Rename / Skip per colliding table. See `STORAGE.md` and `ELECTRON.md`. | `registerFooterButton`                                             |

## Cell Renderers

A cell renderer is a custom element registered under a name via
`api.ui.registerCellRenderer(name, tag)`. A column opts in by setting
`column.renderer` to that name (independent of the column's underlying data
`type`). The element receives a `value` property (and, for renderers that
need neighbouring fields, a `row` property) and dispatches a `change` event
with `{ detail: { value } }` to commit an edit. A column with no renderer, or
one pointing at an unregistered name, falls back to a plain read-only text
cell.

### Column scripts are renderer-independent

A column may also carry a `script` — a JS body defining `function render(row)`,
edited via the script button in the column editor (`script-editor-dialog.ts`,
run by `util/column-script.ts`). Its return value REPLACES the stored value on
the way into whatever renderer the column has: `link` can point at a computed
URL, `image` at a computed `data:`/`http` value, `boolean` at a derived flag,
or plain text when the column has no renderer at all. There used to be a
dedicated `script` renderer that ran the same script a second time and
injected the result as raw HTML; it duplicated this generic path and was
removed. The DISPLAYED value is always read-only — it is derived, so there is
nowhere to write it back to — but the renderer also receives `rawValue`, the
STORED cell, and a `change` event writes there. That is how the `html`
renderer's pencil edits the Markdown a script reads while the cell shows the
HTML it produced. If a script's own output is markup you want rendered, give
the column the `html` renderer; `preview` shows it as one line of text with a
popup for the full markup.

### The other column script: `validate`

A column may also carry a `validate` body defining
`function validate(value, row)`, edited via the SECOND pencil in the column
editor (right of `max`) and run by `runValidateScript` in the same
`util/column-script.ts`. It is the escape hatch for constraints the
`notnull`/`max`/`unique` flags can't express, and it **rejects by throwing** —
the thrown message is what `data-table`'s `validate()` returns, which is what
the "Cannot save" dialog shows. A return value is ignored, so the accept path
is an empty function.

Three deliberate boundaries:

- it runs **after** the declarative constraints, so a script never has to
  re-check emptiness or length that a tick-box already covers;
- it runs on `commitCell` only — the MANUAL edit path. Imports, refreshes and
  sync write through the store and are untouched, because a rule that can
  abort an import halfway is worse than an import you can then inspect;
- `row` is the row **as it would be** (`{...row.data, [field]: value}`), so a
  two-field rule reads the pending edit rather than contradicting itself
  depending on which cell was touched last.

The two kinds compile to different signatures (`render(row)` vs
`validate(value, row)`) and so keep separate memo caches, but they share the
helper set and the trust model. `dialogs/script-samples.ts` holds the ten
ready-made scripts the editor offers for EACH kind (`RENDER_SAMPLES`,
`VALIDATE_SAMPLES`); they are plain data and the unit suite compiles and
exercises every one — including a rule that each render sample returns `''`
for an empty row, since a script runs against the blank row the user just
added and "undefined undefined" or "NaN%" in the grid is the classic way a
naive script embarrasses itself.

**The user's own samples** sit beside them: the **+** next to the dropdown asks
for a name and keeps what is in the editor, and the trash beside it deletes the
one currently loaded (after a confirm; a built-in is code and cannot be deleted).
Same 🗑 / + pair as the Import dialog's sample row — see `import-data` below.
The whole list is one workspace setting, `scripts:samples` — a sample is
content, like a view template, so a gist push or a dump carries it rather than
leaving it on the machine it was written on. There are two lists, not three: a
VIEW TOKEN's script is `render(row)` like a column's, so one saved on a column is
offered on a token and the other way round, while a `validate` sample stays out
of the render list (offering it there could only ever produce a broken script).
`parseUserSamples` is deliberately tolerant — the list may arrive from another
device or a hand-edited dump, and one malformed entry must cost that entry, not
the whole editor.

### Checking every row: the Validate button

The `validate` script above runs on a manual edit, one cell at a time. That
leaves a real gap: a table imported from a file has never been checked at all,
and neither has a row written by a sync. The footer's ✓ button
(`plugins/validate.ts`) is the answer — the one place in the app that runs a
column script over more than one row.

The rules themselves moved to `table/validate-rules.ts`, shared with the columns
editor's Save pre-flight. Two copies of "what does `max` mean" is one too many:
`max` is a LENGTH for text and a MAGNITUDE for a number, a blank is not a
duplicate (that is what `notnull` is for), and a zero is a value. The pre-flight
still does NOT run scripts — a Save must not be the first thing that runs JS over
every row — which is one option flag, not a second implementation.

`table/validate-scan.ts` does the reading, a page at a time, and this is the part
worth knowing:

- **A table with no rules is not read at all.** The validator reports which
  columns carry a rule, and an empty list ends the scan before the first query.
  So the button costs nothing on a big imported table that declares nothing.
- **The scan is one continuous pass**, because `unique` needs it: a duplicate is
  only visible in the light of every row already seen, so a per-page validator
  would call two copies unique.
- **It yields between pages**, reports progress through the app-wide bar, and
  **Esc stops it** — the label says so. A cancelled scan reports what it found
  and says it was cut short.
- **Each column stops listing after 500 issues** and counts the rest. A script
  that throws for every row would otherwise return 609,283 issues that all say
  the same thing.

The results go into a TABLE, `<table> issues`, not a list in a dialog. "Let me
filter and fix these" is a request for filtering, sorting and exporting, and this
app has all three — for tables. The dialog that appears is the summary, one line
per column in the grid's own column order, with a **Show me** button that reveals
the issues window. A second run REPLACES that table's rows rather than adding a
`Pets issues-2` beside it. The table is `readonly`: every row in it is a copy of
a problem, and editing the copy fixes nothing.

Both orderings in that summary are fixed rather than encountered: rows come back
in the store's own order (a Dexie key is a random UUID), so an encounter order
would word the same table's summary differently on every run and a user comparing
two runs would read that as a change in the data.

One deviation from the design sketch, which had `notnull` / `max` / `unique`
pushed down to the store as SQL while only scripts streamed. That works on the
SQLite stores and cannot work in the browser: IndexedDB has no index on a field
inside `data`, so `WHERE col IS NULL` has nothing to use and costs the same full
read. A second code path that only ever helped the desktop is not worth two
definitions of `max`.

### HTML or Markdown — who decides

Three renderers show a value as markup: `html` puts it in the cell as HTML,
`markdown` converts it from Markdown into the popup, and `preview` has to GUESS,
because it converts a column nobody configured. `markdown` and `preview` share one
cell (`preview-cell.ts`): one line of plain text in the grid, the render in the
popup — a grid row is one line high, so headings and lists belong in a window. The guess is `markupKind` in `util/markdown.ts`, and it
tests **Markdown first**: `looksLikeHtml` reads any `<word>` as a tag, and
Markdown prose is full of angle-bracket words that are not tags — a Datasette
changelog says `/<database>/-/create` in every second line. Read as HTML, those
words are swallowed by the parser and every `**bold**` stays literal. A value
whose first character opens a tag is HTML whatever else it holds.

### Read-only: two different questions

A cell renderer is handed two flags, and they are not the same question:

- **`readonly`** — may the DISPLAYED value be edited? A scripted column always
  sets it, because what the cell shows is computed. The editor renderers
  (`date`, `datetime`, `boolean`, `tags`) key on this and render display-only.
- **`sourceReadonly`** — may the STORED value be written at all? True for a
  read-only table or view, and for a read-only column. A renderer with a SOURCE
  editor (`html`'s pencil, `preview` / `markdown`'s click) keys on this one: a
  scripted column in an editable table has `readonly` true and `sourceReadonly`
  false, so the pencil still opens the Markdown the script reads.

With `sourceReadonly`, `preview` and `markdown` open their source as a VIEWER —
the textarea is read-only and there is no Save button — because a truncated cell
still has to be readable. `html` keeps rendering and drops its pencil.

`commitCell` in `data-table.ts` refuses the write regardless, so a renderer that
ignores either flag (a third-party one, or a built-in that never honoured them)
cannot write through to a read-only table or column; a toast says why.

### Invalid stored values

A stored value that doesn't fit its column must never be silently blanked or
coerced — that loses data from the user's view (a stored `'foo'` in a boolean
column rendering as an unchecked box is indistinguishable from a real
`false`). The app-wide convention lives in `util/cell-validity.ts`: show the
raw value as text with a `#dc2626` border (the same red as
`dialogs/settings-dialog.ts`'s `.invalid` field) and a `title` explaining why,
still editable. Renderer authors should reuse `booleanState`/`markInvalid`/
`INVALID_INPUT_STYLE` from that module rather than inventing another marking.
`cell-boolean`, `cell-date`, and `cell-datetime` below all apply it; so does
`data-table.ts`'s no-renderer fallback for `number`/`date`/`datetime` columns.

### cell-date

Registers `date`: a native `<input type=date>` picker, coercing whatever is
stored into the `YYYY-MM-DD` string the input expects and back. A non-empty
value the picker can't parse (an unparseable string) shows as red-bordered
raw text with a pencil instead of a misleadingly empty box — a genuinely
empty value stays an empty date input.

### cell-datetime

Registers `datetime`: a native `<input type=datetime-local>` picker,
coercing whatever is stored into the `YYYY-MM-DDTHH:MM` string the input
expects and back. Same invalid-value handling as `cell-date`.

### cell-boolean

Registers `boolean`. Four states, per `booleanState()`: a real `true`/`false`
render as the checkbox (checked/unchecked); an empty value (`null`/`''`)
renders the same checkbox grayed out — clickable, so filling it in just means
clicking it, and it commits `true`; anything else (`'foo'`, `2`, `{}`, …)
never renders a checkbox — a checkbox can't represent a value it isn't —
instead the raw value shows as red-bordered text with a pencil to fix it.

`cell-date`, `cell-datetime`, and `cell-boolean` used to ship as a single
`core-renderers` plugin (`meta.fixed = true`, non-disableable). They were
split into separately-toggleable plugins so the Plugin Manager can disable
any one of them independently; existing workspaces have no
`builtin:core-renderers` disabled-state row, so all of them simply default
to enabled with no migration needed. (A fourth split-out, `cell-script`, was
later removed outright — see "Column scripts are renderer-independent" above.)

### cell-color

Registers `color`: a native `<input type=color>` swatch. Values are plain
hex strings (`#rrggbb`/`#rgb`); anything else falls back to `#000000` for
the picker's sake without touching the stored value until the user changes
it.

### cell-image

Registers `image`: shows a thumbnail for values that look like a `data:image`
or `http` URL, otherwise an "upload" button. Upload reads the picked file via
`FileReader.readAsDataURL` and commits the resulting `data:` URI — images are
stored inline in the row, not as separate blobs, so very large images bloat
the table.

### cell-link

Registers `link`. Per-value (not per-column) detection, in priority order:
http(s) URL → email → phone-shaped string; the matching case renders an
`<a>` (`target=_blank` for URLs, `mailto:` for emails, `tel:` for phone
numbers), ellipsized to the current column width via CSS. A pencil icon
toggles into a plain text `<input>` for editing (Enter commits, Escape
cancels back to link view). Detection is heuristic — see
`detectUrl`/`detectEmail`/`detectPhone` in `cell-link.ts` for the exact
regexes and their false-positive guards (e.g. dates and multi-digit IDs are
deliberately excluded from the phone match).

## Importers

Importers bring rows in from outside the workspace: dropped files, pasted
text, or a fetched URL. Most also register `api.ui.registerDropHandler` so
the same logic runs whether the user drags a file onto the canvas or drives
it from a dialog.

### csv-import

Drag-and-drop a `.csv`, or use the header "Paste CSV" button. Auto-detects
the delimiter (`,`, `;`, or tab) by sampling the first few lines, and reads a
row-capped import by streaming byte-slices (`readCsvHead`) so a huge file
with a "Limit rows" cap never buffers the whole thing into memory. Header
cells support a mini-language: `field:label:type:default:max:flags` (flags:
`u`=unique, `n`=notnull, `h`=hidden) — a plain header like `Customer Name`
just infers everything. Column types (`string`/`number`/`boolean`/`date`/
`datetime`) are inferred from sampled values when not pinned by the header.
Dropping a CSV onto a table, or importing one whose name already exists, asks
the four-way question below. Exports `parseCsv`/`importCsvText` for reuse by
`import-data`.

### json-import

Drag-and-drop `.json`/`.db.json`. Recognizes three shapes: the native
`{ tables: [{name, columns, rows}, ...] }` dump (what `dump-export` writes,
round-trippable), the legacy minniDBMax v1 `{ "<name>.table.json": {dataArray,
columns, elementRect} }` shape (converted in place, including window geometry
and sort order), and a bare array/object of plain JS values (columns inferred
from the union of keys). A multi-table dump opens a checklist of which tables
to import, then asks the workspace-level question
(Overwrite-matching / Replace-workspace / Add-as-new). A file holding ONE table
that names an existing one asks the four-way question below instead — a
single-table file is not a workspace question, and offering "Replace entire
workspace" for one was a trap that deleted every other table. A table carrying a live
`source` (e.g. a Datasette connection) or snapshot `origin` in the dump is
reconstructed with that backing intact rather than as a plain local table.
Exports `parsedToTables`/`importJsonText` for reuse by `import-data` and
`server-sync-core`.

**A dump's rows may carry fields its own column list omits**, and the reader adds a
column for each of them (`withUndeclaredFields`). A real case: `bible.db.json`
declares `book` and no `title`, yet 368 of its 1,258 rows carry `title` and no
`book` — one logical field under two names, written by two generations of the
exporter. Those 368 rows imported blank, and the value was unreachable rather than
merely unshown: no column means no header, no funnel and nothing to sort by, so
there was no way to tell the data had arrived. The added columns are appended and
type-inferred; declared columns keep their order and their width / renderer /
hidden flags. A field in `deletedColumns` stays deleted — that list is what tells a
deliberate deletion apart from an omission.

### A file of several tables, dropped ON one window

A window says where the data goes. It does not say which part of the file it is, so a
multi-table file leaves exactly one question open, and `pickSourceTable` answers it
the way a person would: **a table of the same name is the one meant**, and only a
file with no such table asks. The picker labels each candidate with its row count, so
two tables of one name in one file are still tellable apart.

This used to refuse outright — "holds 5 tables, drop it outside a window" — which
told the user their aim was wrong when the aim was the one unambiguous part of what
they had done. Everything after the picker is the path a single-table file already
took: the four-way question, then the column mapper if the fields differ.

### One file, one existing table: the four-way question

`import/import-mode.ts` owns it, so a CSV and a `.table.json` ask it in the same
words, and a file dropped ON a table window asks the same thing as a file that
merely carries that table's name — those are the same situation:

| Answer          | What happens                                                                              |
| --------------- | ----------------------------------------------------------------------------------------- |
| **Re-Create**   | The file's columns REPLACE the table's, and its rows replace the data.                    |
| **Re-Load**     | The table's columns stay (widths, renderers, types, scripts); only the rows are replaced. |
| **Append**      | The rows are added after the ones already there.                                          |
| **A new table** | That table is left alone; the store uniques the name (`Cities-2`).                        |

Re-Create keeps the table's **id**, name and window rather than deleting and
re-inserting it: every projection and view instance bound to it survives what is
otherwise a re-import, and the panel does not jump back to a cascade position.

Re-Load and Append have to map the file's columns onto the table's, and they open
the **column mapper** (`dialogs/column-map-dialog.ts`) unless `columnsLineUp()`
says the incoming names already match the target's fields or labels, position for
position — the case of a file the table was imported FROM. Anything else mapped
by position silently, which put cells under the wrong columns in a table that
already held data. Re-Create maps nothing, so it never asks.

A read-only table (a live connection, a reference) takes no rows at all: the drop
says so and falls through to importing as a new table. A multi-table file dropped
on a window cannot land in one table either, and says so.

### datasette-import and datasette-connect

Two plugins, because they are two different things against any online
[Datasette](https://datasette.io/) instance.

**`datasette-import`** takes a read-only **snapshot** you own: rows are written
locally, synced, and editable. Reachable via `registerUrlSource`, a table-URL
drop handler, and the Import dialog. A URL may name a single table, a whole
database, or an entire instance root; the latter two open a table checklist.
It pages through the API in fixed-size chunks (cap and page size come from the
Settings → Datasette tab; default cap 10,000 rows, 0 = unlimited), and if
paging is interrupted (e.g. rate-limited) the table records a resume cursor
(`table.importResume`) surfaced as a red "Resume import" button rather than
silently truncating. Its Refresh re-fetches and merges by primary key, keeping
columns the user added and honouring the ones they deleted.

**`datasette-connect`** points a window at somebody else's **live** table. It
registers a `ConnectorSpec` rather than its own header button, so the single
"Connect" in the header comes from `connect-menu` no matter how many backends
are installed.
Nothing is stored: the table carries `source: { type: 'datasette' }` and
`api.registerRowSource({ type: 'datasette', ... })` hands it the collection in
`datasette-collection.ts` — the one built-in that uses the row-source routing
seam instead of writing to local Dexie. Its Refresh forces that collection to
re-read, which is not the same operation as the import's merge, which is why
each plugin registers its own Refresh button with a mutually-exclusive
`visible` predicate.

Both share `datasette-common.ts` (the table and database pickers, the row cap,
the `TableInfo` stamp) and the wire layer in `datasette-client.ts`. Neither
imports the other.

### import-data

The header "Import" button and the dialog behind it. The dialog is two blocks:
the options EVERY importer has (sample source, URL, file upload, Copy vs.
Reference, "Import into", "Edit columns before import", "Limit rows"), then a
second block holding only the options of the chosen importer, mounted from the
custom-element tag its `ImporterSpec.panel` declares — so this plugin imports
no format code to render them. The format list, the file input's `accept` and
the panel all come from `registries.importers`, so a new importer plugin
appears with no edit here.

An importer that declares `supports.kernel` (csv, json) runs entirely through
`runImport`: the kernel owns the listing, the table picker, the row cap, the
naming, the collision policy and the write, which is why "Import into" is only
offered for those. Datasette is still dispatched to `datasette-import`, which
owns its own paging and collision prompt.

**The sample list is the user's** (`import/import-samples.ts`). `PREDEFINED` in
the plugin is only what it STARTS as: the **+** beside the URL box prompts for a
name and keeps that URL, and the trash beside the list deletes whichever sample
is picked. The + sits with the URL rather than with the list because that is what
it acts on. Deleting one of
ours cannot remove it from the code, so it is recorded as hidden BY URL in
`import:samplesHidden`, while the user's own live in `import:samples` — two
workspace settings, so the list travels with a gist push or a dump. Two
consequences of hiding by url: changing a shipped sample's url un-hides it (a
different url is a different sample), and nothing is destroyed, which is what
lets **Restore samples** — shown only while something is hidden — simply clear
the list. `parseUserSamples` / `parseHiddenSamples` are deliberately tolerant: the
value may arrive from another device or a hand-edited dump, and one malformed
entry must cost that entry, not the Import button. A stored `kind` that is not a
known importer is dropped while the sample is kept, since auto-detect reads the
URL anyway.

A native `.db.json` body is sniffed before anything is written: it is a whole
workspace, so the dialog offers `json-import`'s `restoreWorkspaceDump` instead
of flattening it into tables. The sniffed body is passed to the kernel as `text`
so nothing is fetched twice.

Also registers the per-table "Refresh" button for a `csv`/`json` `origin`,
delegating to `import/refresh.ts` — which re-reads through the importer's own
`list`/`read`, reconciles columns against the user's arrangement and honours
`deletedColumns`. Datasette-origin tables keep their own Refresh in
`datasette-import`, which additionally drives a progress bar and a resumable
paged read. Enforces a 50 MB hard ceiling on browser-buffered URL imports with
an actionable error rather than an opaque failed transfer — lifted for a
Reference or a row-capped import, which do not buffer the whole body to keep.

## Exporters

Exporters serialize a table (or the whole workspace) out through
`api.backend.saveFile`, which triggers a browser download — **still true
inside Electron**, even though the `.db` file operations there already use
`dialog.showSaveDialog` (see `ELECTRON.md`). Routing `saveFile` through that
same bridge is the leftover half of Phase 8; exporters need no change when it
lands, since they only ever call `api.backend.saveFile`.

Note that exporting is not the same thing as the desktop app's Save As: an
exporter writes CSV / JSON / SQL _text_, while Save As copies the live SQLite
file (the `electron-db` plugin, above).

### The export dialog owns the UI; a format is a plugin again

Every export goes through `dialogs/export-dialog.ts`. It lists the formats from the
exporter REGISTRY — which nothing read before: `registerExporter` had no consumer at
all, and `dump-export.ts` hard-coded CSV / JSON / SQL in an anchored menu. Registering
a format is now what puts it in the dropdown.

The dialog asks the questions every format shares (`ExportOptions`: a row limit,
visible or all columns, filtered or unfiltered rows, sorted or unsorted, raw or
rendered values, run scripts) and turns them into rows in one place,
`export/export-rows.ts`. A serializer receives the finished rows and must not narrow
them again — a limit taken twice writes a smaller file than the user asked for.

A format's OWN questions live in the element it names in `ExporterSpec.panel`,
exactly as an importer names one in `ImporterSpec.panel`: the dialog mounts the tag
and reads its `value` back, so it imports nothing from any plugin. `ExporterSpec` also
gained `serializeMany` — several tables in ONE file, for a format that has a shape for
that. Without it the dialog writes a file per table, which is the only thing a CSV can
mean.

Two options are narrower than they sound, and the docs say so rather than the UI
implying more:

- **Rendered** formats by column TYPE — a datetime in local time, an array as its
  members. Not the registered cell renderer: that returns a Lit template, and a
  template cannot become a CSV cell.
- **Run scripts** fills a scripted column only where it stores nothing of its own. A
  script that decorates stored data must not overwrite it.

### csv-export

The `csv` exporter and its panel (`csv-export-options.ts`): separator (comma,
semicolon, tab, pipe or one typed in), header row, byte-order mark, CRLF or LF, and a
**typed header** that writes each column as `field:label:type:default:max:flags` in
`csv-import`'s own header mini-language — so a file exported and imported again comes
back with the types it left with instead of whatever inference makes of the values.

The writer is otherwise the mirror image of `csv-import`'s parser, and quoting follows
the CHOSEN separator: with `;` picked, a cell holding a comma needs no quotes and one
holding a semicolon does.

### json-export

New. The `json` exporter, split out of `dump-export` because each format should be its
own plugin. One table becomes a `.table.json` (the shape `json-import` reads as a
single table); several become one `.db.json` dump through `serializeMany`, optionally
carrying the workspace's view templates and the instances of the exported tables. An
instance whose table is not in the file is left out — it would restore a window bound
to nothing.

### dump-export

Two buttons, and nothing else: the workspace footer's "Export" and each table
footer's "Export", both of which now open the dialog. It keeps
`serializeWorkspace` — the `{ tables: [...] }` `.db.json` shape that
`server-sync`/`auto-sync` push over the Hono `/sync` route and `gist-sync` writes per
table. That is a WIRE format with no options, which is why it did not move into
`json-export` with the dialog's JSON.

### sql-export

Registers the `sql` exporter, which is what keeps SQL in the dropdown: the format was
named by `dump-export`'s menu before, and a dialog reading the registry would have
dropped it. `serializeTablesAsSql` is the dialog's entry point — the same dump built
from tables the dialog has already read and narrowed, since `serializeWorkspaceAsSql`
reads the workspace itself and so can honor no limit, filter or column choice.
The serializer itself is unchanged: one portable `.sql` script per
workspace, a `BEGIN`/`COMMIT`-wrapped `DROP TABLE IF EXISTS` → `CREATE
TABLE` → `INSERT` sequence per table, ANSI double-quoted identifiers (works
as-is on PostgreSQL/SQLite; MySQL needs `SET sql_mode='ANSI_QUOTES'` first).
Adds a synthesized `__id TEXT PRIMARY KEY` column carrying each `Row.id`,
since easyDBAccess row IDs are opaque strings rather than auto-increment
integers. `date` columns are written as a fixed-width `'YYYYMMDD'` literal
for predictable joins.

## Sync

Sync plugins move a whole workspace between devices. They now share two
things: `api.settings` for connection state (see `STORAGE.md`'s settings
section) and the shared `AnchoredMenu` primitive (from `@cawoodm/lit-menu`,
see `DIALOGS.md`) for their footer buttons — a single button opens a small
menu instead of one footer button per action.

### gist-sync

A single footer "Gist" menu button (Push / Pull / Settings / Share / View
gist) plus a per-table "Gist" menu (Push this table / Pull this table /
View gist file) — replacing the old separate Push/Pull buttons. Credentials
are declared via `api.ui.registerSettings('gist-sync', 'Gist Sync', [...])`
and edited as ordinary Settings-dialog fields: `user` and `gist_id` are
plain workspace-scope strings, but `gist_token` is a **user-scope `secret`
field** — it defaults to the device-local layer (`localStorage`, never
synced) rather than the workspace `settings` collection, a meaningfully
better story than the old plaintext-in-Dexie connection string. The
"Settings" menu item just opens the Settings dialog on this tab; the
`user=...;gist_id=...;gist_token=...;` connection string still exists as
the format the "Share" link's `#gist=<base64>` URL hash carries (loaded on
boot to bootstrap a fresh device onto an existing workspace), and as a
migration path `loadCreds` falls back to if the new per-field settings
aren't populated yet.

A push also asks to DELETE the gist's table files that this workspace no longer
has (`staleTableFiles` + `confirmStaleRemoval`). A PATCH only touches the files it
names, so the file of a deleted table — or the old name of a renamed one, since the
slug is in the file name — stayed in the gist and the next pull brought the table
back. It asks for the same reason the pull side asks (`offerPrune`): a push from a
device that has not pulled lately would otherwise remove a table another device
added. Only a data push prunes, and only files matching `*.table.json`.

Push now bundles more than tables: alongside each table's own
`<slug>.table.json` file and the `_easydb.workspace.json` marker (which
lets Pull tell an easyDBAccess gist from an unrelated one), that marker file
also carries the workspace's `viewTemplates`, `viewInstances`, and its
`settings` entries, so a pull can restore views and plugin config too. Key
prefixes are no longer excluded (they were, until secrets moved into
`secrets.txt`); instead `withoutRawSecrets()` from
[`db/secret-guard.ts`](../../packages/renderer/src/db/secret-guard.ts) withholds
any setting that actually HOLDS a credential — a credential-named key whose value
is neither empty nor a `${secret:name}` reference, or a composite record with such
a member (the legacy `gist:<id>` value, or `datasette:token:<base>` which is
written straight to the settings table). The whole entry is left out rather than
blanked, and the push toast names what stayed behind. Each table's own
file is likewise more than rows: `tableToFile()` also carries `title`,
`view`, `windowGeometry`, `sortColumn`/`sortAsc`, `filters`, `labelColumn`,
`deletedColumns`, `readonly`, and `info`, so a pull restores a table's window
position/size, sort, and filters exactly as pushed, not just its data
(row values are projected onto the table's _current_ columns, so a
long-deleted column's leftover data never inflates the push size or gets
re-synced). `syncedTableFields()` only overwrites the fields a given gist
file actually carries, so pulling an older gist can never clear newer local
state. After a pull, the incremental per-table inserts open windows in file
order rather than saved z-order (each insert fires its own `liveQuery`), so
gist-sync dispatches `easydb:restack-windows` at the end — the core window
manager (see `WINDOWS.md`) listens for that event and re-fronts every open
panel by its saved `z`. Warns (with a Push-anyway confirm) when any table's
serialized JSON exceeds 10 MB (slow) or GitHub's 100 MB-per-file limit
(rejected outright). Pull fetches GitHub-truncated files via `raw_url` and
continues past a single failing table, reporting which file failed rather
than aborting the whole pull.

### server-sync

A single footer "Sync" menu button (Push / Pull) against a configured
easyDBAccess Hono server's `/sync/:workspaceId` route — replacing the old
separate "Sync ↑"/"Sync ↓" buttons — sharing its URL/ETag persistence
helpers (`server-sync-core.ts`) with `auto-sync`. Its server URL is now a
`registerSettings` field too. Push sends an `If-Match` ETag header; a `412`
conflict (server changed since the last pull) prompts force-push-anyway vs.
cancel-and-pull-first. Pull always confirms first, since it
wholesale-replaces local tables with the server's copy.

### auto-sync

Optional background version of `server-sync`: on a 60-second timer
(`load()`, skipped entirely under Playwright's `?test=1`, which drives
`tick()` manually instead), it diffs the local workspace against the
server's copy. If they match, nothing happens; if local is ahead (server
still shows the ETag we last saw), it force-pushes silently; if the server
has genuinely diverged, it prompts to pull once, then remembers the
dismissed ETag so it won't re-prompt for the same remote state on every
tick. Never toasts on transient errors — only `console.warn`s — since a
minute-by-minute failure toast would be miserable.

## Settings

### settings

The `settings` built-in supplies the entry point to the whole layered
settings system (see `STORAGE.md` for the storage model): a header gear
button (`variant: 'secondary'`, icon-only, pinned to the far right) whose
`onClick` is just `api.ui.openSettings()`. It also registers a drop handler
that only claims a file literally named `secrets.txt` — dropped anywhere on
the canvas, it imports that text into the device-local secrets store
(confirming an overwrite if secrets already exist), so a user can carry
their secrets between devices without typing them again. The Settings
_dialog_ itself — tabs, per-field promote/demote, the secrets editor — is
core chrome documented in `DIALOGS.md`; this plugin only owns the entry
point and the drag-and-drop convenience, the same "dogfood the registration
path" pattern `new-table-button` follows.

Any other plugin participates in this system by calling
`api.ui.registerSettings(pluginId, name, fields)` once in `init()` — see
`gist-sync` and `server-sync` above for real examples — which gets it a tab
in the dialog for free with no per-plugin UI code.

## Views

### views

Not an importer/exporter/renderer — a small display layer. A **View
Template** (workspace-global) is header/row/footer HTML; blank row HTML
renders a read-only columns table, otherwise the row HTML repeats per row
with `$TOKEN` placeholders substituted from a per-instance token→column map.
A **View Instance** ties one template to one table, snapshotting its current
sort/filter/visible-columns, and opens read-only in its own window.

Creating an instance **auto-maps** each of the template's tokens to a
column: an exact field/label match wins outright; failing that, a
`title`/`name`/`label` token falls back to the table's `labelColumn` (e.g.
Datasette's designated label column); date-ish tokens (`date`, `created`,
`updated`, `timestamp`, …) match the first `date`/`datetime`-typed column;
url-ish tokens (`url`, `link`, `website`, …) prefer a column already using
the `link` renderer, else the first column whose field/label contains a
url-ish word; description-ish tokens similarly prefer a long-text column.
An instance also carries an optional `limit` (0/absent = show all) — a
"Show at most (rows)" field in the dialog — applied as a simple slice after
sort/filter in `view-window.ts`'s `recompute()`.

A token's PREFIX decides how it renders; the name after it is the mapping key,
so `$TITLE`, `$input.TITLE` and `$filter.TITLE` all read the same column
(`views/view-render.ts`):

- `$TOKEN` — the value THROUGH the column's cell renderer, read-only, so a view
  looks like the grid (a `link` column as a link, `tags` as pills).
- `$raw.TOKEN` — the value as plain text, skipping the renderer.

A `date` / `datetime` column with NO renderer is still formatted for the reader,
by TYPE, in `util/local-datetime.ts` — otherwise a card showed the stored
`2026-06-17T10:59:56.937Z`. The one distinction that module exists for: a value
carrying a zone names an INSTANT and is converted to the reader's clock, while an
unzoned one is already a wall clock and must not be shifted. A date-only value is
formatted from its parts, never through `new Date(s)`, which parses it as midnight
UTC and renders the day before west of Greenwich. `$raw.` keeps the stored text,
and a value the app cannot parse comes back unchanged rather than blank.

Since 0.0.339 that module is also what the GRID and the `cell-date` /
`cell-datetime` renderers use, so a view and a grid can no longer disagree about
the same cell. Two functions there answer the second half of the question — what
goes INTO a native `<input type="date">` / `<input type="datetime-local">`:
`toDateInput` / `toDatetimeInput`. A native picker is a wall-clock control with no
way to show a zone, so a zoned value has to be converted before it goes in; all
four call sites used to strip the zone instead, putting the UTC time in the box
and writing that wrong time back on the next edit. Both still return `''` for an
unreadable value, which is what lets `isNonEmptyButUnparsed` tell a broken cell
from a blank one.

- `$input.TOKEN` — an editable control bound to the cell (checkbox for a
  boolean, number/text otherwise), disabled for a read-only view or a scripted
  column, which has nowhere to write back to.
- `$filter.TOKEN` — a clickable chip. Clicking it OR-appends an exact-match
  filter for that value onto the instance's separate `pillFilters`, and the chip
  appears in the view's toolbar where its field cycles `=` → `≠` → off and its
  value opens the field's other values as a checklist.

An **`array` field renders one `$filter.` chip per member** (and a real JS array
is taken apart whatever the column type says). One chip for the whole cell
filtered on `=red,blue`, and no list cell is ever exactly equal to that, so the
click emptied the view. Per member it matches per member, which is what an
`array` column's filter already does — see `search/column-filter.ts`.

**Rendering a `$TOKEN` needs a DOM pass**, not just string substitution: a cell
renderer is a custom element fed by PROPERTIES (`.value`, `.column`, `.row` — see
`data-table.ts`), and a property cannot be written into an HTML string. So
`substituteRow` emits an empty `<span class="eda-cell" data-eda-…>` slot and
`view-window`'s `updated()` mounts the renderer element into it — every render,
because `unsafeHTML` replaces the whole block whenever the string changes.

Four things send a token back to plain text: the `raw.` prefix or
`ViewInstance.tokenRaw[token]` (the mapping dialog's 🎨 / 🔤 toggle, default
rendered), a column with no renderer or an unregistered name, a token that has
its own script (which already decided what to show), and — load-bearing — **a
token INSIDE a tag**. `<img src="$IMAGE">` and `<a href="$URL">` is how the
shipped templates are written, and an element spliced into an attribute is not a
renderer, it is a broken tag; `insideTag()` catches it by asking whether the last
`<` before the token is still unclosed.

**A token can carry its own script** — the `ƒ(x)` button next to its column in
the mapping list, stored as `ViewInstance.tokenScripts[TOKEN]`. It is the same
`function render(row) { … }` a column script uses (the same editor, the same
`markdownToHtml` helper), and what it returns is what the token shows: markdown
as HTML, a date in the reader's locale, a value computed from several fields.
The stored cell never changes, so one column can read one way in the grid and
another in a card, and a scripted token needs no mapped column at all.

It applies to a plain `$TOKEN` only. `$input.TOKEN` writes back to the cell and
`$filter.TOKEN`'s pill has to carry the stored text to match anything, so both
keep reading the mapped column. A script that will not compile, or that throws,
renders a `⚠` chip with the message on hover — a blank card would read as "no
data" and hide the broken script.

**Every field a template offers a `$filter.` on has a chip in the toolbar**, even
with nothing filtered: an IDLE chip (`field ▾`, dashed) that opens the field's
value checklist. `view-window.ts` derives them with `extractFilterTokens` over
the template's three fragments, mapped through the instance's token→column map,
so the toolbar says what CAN be filtered instead of only what is. Two
consequences: a filter is reachable without hunting for a row that shows the
value, and cycling a chip to "off" leaves the idle chip behind rather than
removing the only way back to it. Grid mode (template off) has no template body
and so offers none — its chips remain whatever is actually filtering.

The plugin itself only owns _intent_: it adds the footer "Views" button (opens
the manager dialog, which flips `ViewInstance.open`) and seeds/repairs a
built-in "RSS Feed" template on `load()`, reconciling it against a hash of
the shipped HTML so an app update can patch an already-seeded workspace's
copy without touching a copy the user deleted. Actually opening, closing,
positioning, and maximizing view windows is core code
(`window-mgr/view-window-manager.ts`), not plugin code — plugins must not
manage panel-shell windows directly.

## Chrome / UI

Small plugins that exist only to register a single button — kept as plugins
rather than shell code to dogfood the same registration path a third-party
plugin would use.

### new-table-button

Header "+ New Table" button; its `onClick` is just
`api.ui.openNewTableDialog()`. The dialog itself is core chrome — this
plugin only supplies the entry point.

### Plugin Manager button (core, not a plugin)

An icon-only secondary header button (top-right, left of Settings) in
`app-shell.ts` whose `onClick` is `api.ui.openPluginManager()`. It opens the
Plugin Manager dialog: one unified list merging built-ins, catalog entries,
and installed URL plugins (rather than three separate sections), with two
independent tri-state filter-chip rows — by category (Installed / Built-in /
Available / Fixed) and by `meta.type` (Importer / Exporter / Cell renderer /
Sync / Source / UI) — plus a search box. Each chip cycles off →
show-only-these → hide-these → off. A row shows its `meta.icon` (falling back
to a generic "extension" glyph), name, and a GitHub link when `meta.repo` is
set. (The button used to be the `plugin-manager-button` plugin; it was
promoted to core chrome.)

## Adding a built-in plugin

1. Drop `src/plugins/<name>.ts` exporting `meta` (with `id`/`name`/`type`
   at minimum) + `init(api)` (+ optional `load(api)`).
2. Import it and add it to the `modules` array in `plugin-host/loader.ts`.
3. Only set `meta.fixed = true` if it must be permanently non-disableable —
   the default for every other built-in is already user-toggleable.

See [`packages/renderer/CLAUDE.md`](../../packages/renderer/CLAUDE.md) for the
full plugin-host lifecycle and hot-loading details, and
[`packages/shared/CLAUDE.md`](../../packages/shared/CLAUDE.md) for the rules
around changing the `HostApi` contract itself.
