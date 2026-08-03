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
  Only `meta.fixed = true` opts a plugin *out* of that — it becomes
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

| Surface | Purpose | Example call |
|---|---|---|
| `api.ui.registerHeaderButton` | Button in the top chrome (global actions) | `new-table-button` adds "+ New Table" |
| `api.ui.registerFooterButton` | Button in the bottom bar (workspace-level actions) | `gist-sync` adds a single "Gist" menu button |
| `api.ui.registerTableButton` | Per-table button in a table's window titlebar | `csv-export` adds a "CSV" download button |
| `api.ui.registerCellRenderer(name, tag)` | Custom element for a column whose `renderer` field matches `name` | `cell-color` registers `<cell-color>` under `'color'` |
| `api.ui.registerImporter` / `registerExporter` | Named format handlers (used by drop handlers, the Import dialog, per-table export) | `csv-import`, `csv-export` |
| `api.ui.registerDropHandler` | Intercept a file/text drag-drop onto the canvas | `csv-import`, `json-import`, `datasette-import` |
| `api.ui.registerUrlSource` | A named "import from URL" flow | `datasette-import` |
| `api.ui.registerConnector` | A live-backend CONNECT flow, listed by the Connect menu | `datasette-connect` |
| `api.ui.registerSettings(pluginId, name, fields)` | Declares a settings tab (rendered by the Settings dialog) | `gist-sync`'s `user`/`gist_id`/`gist_token` fields |
| `api.ui.openSettings()` | Opens the Settings dialog | the `settings` built-in's header gear button |
| `api.settings` | Layered settings accessor (`get`/`set`/`placement`) — user layer shadows workspace layer, resolves `${secret:name}` refs on read | `gist-sync`, `server-sync` reading their config |
| `api.ui.dialogs` | Promise-based alert/confirm/prompt/choice/toast | used everywhere instead of `window.*` |
| `api.store` | The `DataStore` (tables, rows, settings, plugins, view templates/instances) | every plugin that persists data |
| `api.registerRowSource` | Backs a table carrying a `source` descriptor with a non-local row collection | `datasette-connect` |
| `api.events` | Typed pub/sub (`AppEvents`) | `import:before`/`import:after`, `plugin:error` |
| `api.backend.fetch` / `saveFile` | CORS-aware fetch (proxied through the Hono server in browser mode) and a save-file abstraction | `import-data`, `gist-sync`, all exporters |
| `api.windows` | Open/list/find panel-shell-backed windows | the core window manager; plugins rarely call this directly |

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

| Plugin | Type | Fixed | What it does | Main hooks |
|---|---|:---:|---|---|
| `settings` | ui | | Header gear button that opens the tabbed Settings dialog; drag-and-drop a `secrets.txt` to import the device-local secrets store. | `registerHeaderButton`, `registerDropHandler` |
| `new-table-button` | ui | | Adds the "+ New Table" header button that opens the table-creation dialog. | `registerHeaderButton` |
| `csv-import` | importer | | Drag-and-drop or paste CSV to create a typed table; infers column types and a `field:label:type:default:max:flags` header mini-language; append/overwrite/new-table prompt on name collision. | `registerImporter`, `registerDropHandler`, `registerHeaderButton` |
| `json-import` | importer | | Drag-and-drop JSON — native `.db.json` dumps, legacy v1 minniDBMax dumps, or plain arrays/objects — with a table picker for multi-table dumps. | `registerImporter`, `registerDropHandler` |
| `datasette-import` | importer | | IMPORT snapshot tables from any online [Datasette](https://datasette.io/) instance by URL — single table, whole database, or entire instance with a table checklist. Rows are stored locally and synced. Supports resumable paged imports, a per-table Refresh (re-fetch + merge by primary key) and a red Resume button. | `registerTableButton`, `registerUrlSource`, `registerDropHandler` |
| `connect-menu` | ui | | Header "Connect" button plus a Ctrl+K command. Lists every registered `ConnectorSpec`; with one installed it opens that backend directly, with several it shows an anchored menu. Knows no backend itself. | `registerHeaderButton`, `registerCommand` |
| `datasette-connect` | source | | CONNECT a live, read-write Datasette table. Rows are fetched on demand and never stored locally; the table carries `source: { type: 'datasette' }` and the routed store hands it `datasette-collection.ts`. Its Refresh re-reads the remote instead of merging. | `registerHeaderButton`, `registerTableButton`, `registerRowSource` |
| `csv-export` | exporter | | Per-table "CSV" download button; RFC-4180-ish writer mirroring the CSV importer's dialect. | `registerExporter`, `registerTableButton` |
| `dump-export` | exporter | | Footer "Export" menu button (JSON dump / SQL script) — the JSON option exports the whole workspace as one `.db.json` file; the SQL option delegates to `sql-export`'s serializer. | `registerFooterButton` |
| `sql-export` | exporter | | No UI of its own — exports `serializeWorkspaceAsSql()`, called from `dump-export`'s "Export" menu. Still a standalone catalog entry (its own `meta.type`) for the Plugin Manager's type filter. | none (library only) |
| `gist-sync` | sync | | Footer "Gist" menu button (Push/Pull/Settings/Share/View gist) plus a per-table "Gist" menu (push/pull/view just that table's file) that store the workspace as a private GitHub Gist. Credentials are Settings-dialog fields (`user`/`gist_id` workspace-scope, `gist_token` a user-scope secret). | `registerFooterButton`, `registerTableButton`, `registerSettings` |
| `server-sync` | sync | | Footer "Sync" menu button (Push/Pull) against a configured easyDBAccess Hono server, with ETag-based conflict detection. | `registerFooterButton`, `registerSettings` |
| `cell-date` | cell-renderer | | `date` renderer: a native `<input type=date>` picker. | `registerCellRenderer` |
| `cell-datetime` | cell-renderer | | `datetime` renderer: a native `<input type=datetime-local>` picker. | `registerCellRenderer` |
| `cell-boolean` | cell-renderer | | `boolean` renderer: a native checkbox. | `registerCellRenderer` |
| `cell-color` | cell-renderer | | `color` renderer: a native `<input type=color>` swatch picker for hex values. | `registerCellRenderer` |
| `cell-image` | cell-renderer | | `image` renderer: thumbnail + upload button; stores images as `data:` URIs. | `registerCellRenderer` |
| `cell-link` | cell-renderer | | `link` renderer: detects http(s) URLs, email addresses, and phone numbers per-value and renders the matching `<a>` (target `_blank`/`mailto:`/`tel:`), with a pencil to switch to raw-text edit mode. | `registerCellRenderer` |
| `import-data` | importer | | Header "Import" button — a URL/file dialog with curated sample sources (Northwind JSON, a public CSV, Datasette examples) that runs `csv-import` and `json-import` through the import kernel and still routes Datasette to `datasette-import`; recognises a native `.db.json` dump and offers to restore the workspace instead of importing its tables; adds a per-table Refresh button for CSV/JSON snapshot origins. | `registerHeaderButton`, `registerTableButton` |
| `auto-sync` | sync | | Background timer (1 min) that silently pushes local changes to the configured sync server and prompts to pull when the server has diverged. Shares its config with `server-sync` via `api.settings`. | `load()` (timer) |
| `views` | ui | | The View system: workspace-global HTML templates (header/row/footer with `$TOKEN` substitution) rendered read-only per table in their own windows, with auto-mapped tokens and an optional row limit; seeds a default "RSS Feed" template. Footer "Views" button opens the manager dialog; window lifecycle itself is core, not plugin, code. | `registerTableButton`, `load()` (template seeding) |

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
Dropping a CSV whose table name already exists prompts
Append / Overwrite / Create new; append and overwrite map CSV cells onto the
*existing* column schema **by position**, not by header name, so the
existing table's renderers/widths/constraints survive untouched. Exports
`parseCsv`/`importCsvText` for reuse by `import-data`.

### json-import

Drag-and-drop `.json`/`.db.json`. Recognizes three shapes: the native
`{ tables: [{name, columns, rows}, ...] }` dump (what `dump-export` writes,
round-trippable), the legacy minniDBMax v1 `{ "<name>.table.json": {dataArray,
columns, elementRect} }` shape (converted in place, including window geometry
and sort order), and a bare array/object of plain JS values (columns inferred
from the union of keys). A multi-table dump opens a checklist of which tables
to import; a name collision with an existing table prompts
Overwrite-matching / Replace-workspace / Add-as-new. A table carrying a live
`source` (e.g. a Datasette connection) or snapshot `origin` in the dump is
reconstructed with that backing intact rather than as a plain local table.
Exports `parsedToTables`/`importJsonText` for reuse by `import-data` and
`server-sync-core`.

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
`api.backend.saveFile`, which triggers a browser download today and will
route through a native save dialog once Electron's Phase 8 lands.

### csv-export

Per-table "CSV" button (`registerTableButton`) plus a named `csv` exporter
spec. The writer is the mirror image of `csv-import`'s parser: comma
delimiter, CRLF line endings, double-quote escaping for any cell containing
a comma/quote/newline — so a round trip through export → import is
lossless for anything the importer itself produced.

### dump-export

Footer "Export" menu button (via the shared `AnchoredMenu` — see
`DIALOGS.md`), offering "JSON dump (.db.json)" and "SQL script (.sql)" —
the two used to be separate footer buttons, one per exporter plugin.
The JSON option serializes every table in the current workspace (plus rows,
window geometry, sort order, and any `source`/`origin` backing info) into
one `{ tables: [...] }` `.db.json` file — the exact shape `json-import`
recognizes as a native dump. Exports `serializeWorkspace`, reused by
`server-sync`/`auto-sync` as the wire format for the Hono `/sync` route and
by `gist-sync` as the per-table `.table.json` payload shape. The SQL menu
option just calls into `sql-export`'s serializer below.

### sql-export

No UI of its own anymore — its footer button was folded into `dump-export`'s
"Export" menu (the SQL option calls `serializeWorkspaceAsSql()` directly).
It's still a separate built-in with its own `meta.type: 'exporter'` entry so
the Plugin Manager's type filter and the catalog can list it independently.
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
section) and the shared `AnchoredMenu` primitive (`chrome/anchored-menu.ts`,
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

Push now bundles more than tables: alongside each table's own
`<slug>.table.json` file and the `_easydb.workspace.json` marker (which
lets Pull tell an easyDBAccess gist from an unrelated one), that marker file
also carries the workspace's `viewTemplates`, `viewInstances`, and every
**non-secret** `settings` entry — `isSyncableSetting()` excludes any key
starting with `gist:`, `datasette:token:`, or `server-sync:` before
including it, so a pull can restore views and plugin config too, without
ever round-tripping a credential through the gist itself. Each table's own
file is likewise more than rows: `tableToFile()` also carries `title`,
`view`, `windowGeometry`, `sortColumn`/`sortAsc`, `filters`, `labelColumn`,
`deletedColumns`, `readonly`, and `info`, so a pull restores a table's window
position/size, sort, and filters exactly as pushed, not just its data
(row values are projected onto the table's *current* columns, so a
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
*dialog* itself — tabs, per-field promote/demote, the secrets editor — is
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

The plugin itself only owns *intent*: it adds the footer "Views" button (opens
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
