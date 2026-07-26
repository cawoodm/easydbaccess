# Plugins

easyDBAccess has (almost) no built-in features — it has a plugin host and a
folder of plugins that ship enabled by default. New Table, CSV import, cell
renderers, Gist sync: all of it is a plugin, loaded through the exact same
mechanism a third-party URL-loaded plugin would use. If a feature can be a
plugin, it is one. The contract lives in
[`packages/shared/src/plugin-api.ts`](../packages/shared/src/plugin-api.ts) —
read that file before changing plugin-host code.

## What a plugin is

A plugin is a single ES module exporting `meta`, `init(api)`, and optionally
`load(api)`:

```ts
export const meta = {
  name: 'cell-color',
  version: '0.1.0',
  description: 'Renderer for hex colour values.',
  optional: true, // user-toggleable from the Plugin Manager
};

export function init(api: HostApi): void {
  api.ui.registerCellRenderer('color', 'cell-color');
}
```

- `init()` runs once at boot (or on hot-install from the Plugin Manager).
- `load()` runs once the app shell is ready (`app:ready`) — used for anything
  that should wait until the workspace/UI has settled (e.g. `auto-sync`'s
  polling timer, `views`' template seeding).
- `meta.optional = true` surfaces the plugin as a checkbox in the Plugin
  Manager dialog; disabled state is stored under the synthetic key
  `builtin:<name>` in the `plugins` collection. Everything else loads
  unconditionally.

**Built-in vs. third-party** is purely a delivery mechanism. Built-ins
(`packages/renderer/src/plugins/*.ts`) are static-imported and listed in
[`plugin-host/loader.ts`](../packages/renderer/src/plugin-host/loader.ts).
Third-party plugins are a `.js` URL (added via the Plugin Manager or listed in
`public/plugins/catalog.json`), fetched, wrapped in a Blob URL, and
dynamic-`import()`ed — so unlike built-ins they must be fully self-contained
(no bare `import 'lit'`-style imports).

## The `HostApi` surface — where plugins hook in

Every plugin gets one `api` object. The pieces plugins actually touch:

| Surface | Purpose | Example call |
|---|---|---|
| `api.ui.registerHeaderButton` | Button in the top chrome (global actions) | `new-table-button` adds "+ New Table" |
| `api.ui.registerFooterButton` | Button in the bottom bar (workspace-level actions) | `gist-sync` adds "Push"/"Pull" |
| `api.ui.registerTableButton` | Per-table button in a table's window titlebar | `csv-export` adds a "CSV" download button |
| `api.ui.registerCellRenderer(name, tag)` | Custom element for a column whose `renderer` field matches `name` | `cell-color` registers `<cell-color>` under `'color'` |
| `api.ui.registerImporter` / `registerExporter` | Named format handlers (used by drop handlers, the Import dialog, per-table export) | `csv-import`, `csv-export` |
| `api.ui.registerDropHandler` | Intercept a file/text drag-drop onto the canvas | `csv-import`, `json-import`, `datasette-source` |
| `api.ui.registerUrlSource` | A named "import from URL" flow | `datasette-source` |
| `api.ui.dialogs` | Promise-based alert/confirm/prompt/choice/toast | used everywhere instead of `window.*` |
| `api.store` | The `DataStore` (tables, rows, settings, plugins, view templates/instances) | every plugin that persists data |
| `api.registerRowSource` | Backs a table carrying a `source` descriptor with a non-local row collection | `datasette-source`'s live connector |
| `api.events` | Typed pub/sub (`AppEvents`) | `import:before`/`import:after`, `plugin:error` |
| `api.backend.fetch` / `saveFile` | CORS-aware fetch (proxied through the Hono server in browser mode) and a save-file abstraction | `import-data`, `gist-sync`, all exporters |
| `api.windows` | Open/list/find jsPanel-backed windows | the core window manager; plugins rarely call this directly |

Plugins **may monkey-patch any `api.*` method** to override default
behaviour — the host doesn't police it. This is deliberate, not a bug.

## Built-in plugin roster

Load order matches `plugin-host/loader.ts`. "Optional" means it can be
disabled from the Plugin Manager dialog (footer → Plugins); everything else
is always on.

| Plugin | Optional | What it does | Main hooks |
|---|:---:|---|---|
| `new-table-button` | | Adds the "+ New Table" header button that opens the table-creation dialog. | `registerHeaderButton` |
| `csv-import` | | Drag-and-drop or paste CSV to create a typed table; infers column types and a `field:label:type:default:max:flags` header mini-language; append/overwrite/new-table prompt on name collision. | `registerImporter`, `registerDropHandler`, `registerHeaderButton` |
| `json-import` | | Drag-and-drop JSON — native `.db.json` dumps, legacy v1 minniDBMax dumps, or plain arrays/objects — with a table picker for multi-table dumps. | `registerImporter`, `registerDropHandler` |
| `datasette-source` | ✓ | Import (snapshot) or Connect (live, read-write) tables from any online [Datasette](https://datasette.io/) instance by URL — single table, whole database, or entire instance with a table checklist. Supports resumable paged imports and a per-table Refresh/Resume button. | `registerHeaderButton`, `registerTableButton`, `registerUrlSource`, `registerDropHandler`, `registerRowSource` |
| `csv-export` | | Per-table "CSV" download button; RFC-4180-ish writer mirroring the CSV importer's dialect. | `registerExporter`, `registerTableButton` |
| `dump-export` | | Footer "Dump" button — exports the whole workspace as one `.db.json` file (the format `json-import` round-trips). | `registerFooterButton` |
| `sql-export` | | Footer "SQL" button — exports the workspace as a portable `.sql` script (`DROP`/`CREATE TABLE`/`INSERT`, ANSI-quoted identifiers). | `registerFooterButton` |
| `gist-sync` | | Footer "Push"/"Pull" buttons that store the workspace as a private GitHub Gist (one JSON file per table + a marker file). Credentials (`user`/`gistId`/PAT) are entered once via a connection string and cached in `settings`. | `registerFooterButton` |
| `server-sync` | | Footer "Sync ↑"/"Sync ↓" buttons pushing/pulling the workspace to a configured easyDBAccess Hono server, with ETag-based conflict detection. | `registerFooterButton` |
| `plugin-manager-button` | | Footer "Plugins" button that opens the Plugin Manager dialog (install a catalog/URL plugin, toggle optional built-ins). | `registerFooterButton` |
| `core-renderers` | | Ships the `date`, `datetime`, `boolean`, and power-user `script` cell renderers (the last runs a user-authored `render(row)` JS body and injects the returned HTML). | `registerCellRenderer` |
| `cell-color` | | `color` renderer: a native `<input type=color>` swatch picker for hex values. | `registerCellRenderer` |
| `cell-image` | | `image` renderer: thumbnail + upload button; stores images as `data:` URIs. | `registerCellRenderer` |
| `cell-link` | | `link` renderer: detects http(s) URLs, email addresses, and phone numbers per-value and renders the matching `<a>` (target `_blank`/`mailto:`/`tel:`), with a pencil to switch to raw-text edit mode. | `registerCellRenderer` |
| `import-data` | ✓ | Header "Import" button — a URL/file dialog with curated sample sources (Northwind JSON, a public CSV, Datasette examples) that routes to `csv-import`, `json-import`, or `datasette-source` depending on detected/chosen kind; adds a per-table Refresh button for CSV/JSON snapshot origins. | `registerHeaderButton`, `registerTableButton` |
| `auto-sync` | ✓ | Background timer (1 min) that silently pushes local changes to the configured sync server and prompts to pull when the server has diverged. Shares its URL/ETag settings keys with `server-sync`. | `load()` (timer), `api.store.settings` |
| `views` | ✓ | The View system: workspace-global HTML templates (header/row/footer with `$TOKEN` substitution) rendered read-only per table in their own windows; seeds a default "RSS Feed" template. Footer "Views" button opens the manager dialog; window lifecycle itself is core, not plugin, code. | `registerTableButton`, `load()` (template seeding) |

## Cell Renderers

A cell renderer is a custom element registered under a name via
`api.ui.registerCellRenderer(name, tag)`. A column opts in by setting
`column.renderer` to that name (independent of the column's underlying data
`type`). The element receives a `value` property (and, for renderers that
need neighbouring fields, a `row` property) and dispatches a `change` event
with `{ detail: { value } }` to commit an edit. A column with no renderer, or
one pointing at an unregistered name, falls back to a plain read-only text
cell.

### core-renderers

Ships four renderers in one plugin: `date` and `datetime` (native
`<input type=date|datetime-local>`, coercing whatever is stored into the
input's expected string shape and back), `boolean` (a checkbox), and the
power-user `script` renderer. `script` reads `column.script` — a JS body the
user writes in the column editor that must define `function render(row)` —
compiles it once per unique source (cached in a `Map`), calls it per cell,
and injects the returned string as raw HTML. A thrown error or a non-string
return renders as a small inline `⚠` chip with the error in the tooltip
instead of breaking the row. Trust model: the plugin host already lets
user-supplied code do anything on the page, so a column script is no
additional risk.

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

### datasette-source

Two distinct entry points against any online [Datasette](https://datasette.io/)
instance: **Import** (a read-only snapshot, reachable via `registerUrlSource`
and drop) and **Connect** (a live, read-write table backed by
`api.registerRowSource({ type: 'datasette', ... })` — the one built-in that
uses the row-source routing seam instead of writing to local Dexie). A URL
may name a single table, a whole database, or an entire instance root; the
latter two open a table checklist. Snapshot imports page through the API in
fixed-size chunks (capped at 10,000 rows), and if paging is interrupted
(e.g. rate-limited) the table records a resume cursor (`table.importResume`)
surfaced as a red "Resume import" table button rather than silently
truncating. A per-table Refresh button re-pulls live tables from the remote
or re-fetches+replaces a snapshot's rows.

### import-data

The header "Import" button — a dialog wrapping the three importers above
behind one URL/file input plus a dropdown of curated sample sources
(Northwind JSON dump, a public air-quality CSV, two Datasette examples).
Guesses CSV vs. JSON vs. Datasette from the URL shape (`detectKind`) unless
the user forces it via "Import as", supports uploading a local file instead
of a URL, and offers a "Limit rows" cap and a CSV-only "Edit columns before
import" checkbox (opens the column-rename dialog before the table is
created). Also registers the per-table "Refresh" button for tables with a
`csv`/`json` `origin` (re-fetches the origin URL and replaces the table's
rows) — Datasette-origin tables get their own Refresh from
`datasette-source` instead. Enforces a 50 MB hard ceiling on browser-buffered
URL imports with an actionable error rather than an opaque failed transfer.

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

Footer "Dump" button. Serializes every table in the current workspace (plus
rows, window geometry, sort order, and any `source`/`origin` backing info)
into one `{ tables: [...] }` `.db.json` file — the exact shape `json-import`
recognizes as a native dump. Exports `serializeWorkspace`, reused by
`server-sync`/`auto-sync` as the wire format for the Hono `/sync` route and
by `gist-sync` as the per-table `.table.json` payload shape.

### sql-export

Footer "SQL" button. Emits one portable `.sql` script per workspace: a
`BEGIN`/`COMMIT`-wrapped `DROP TABLE IF EXISTS` → `CREATE TABLE` → `INSERT`
sequence per table, ANSI double-quoted identifiers (works as-is on
PostgreSQL/SQLite; MySQL needs `SET sql_mode='ANSI_QUOTES'` first). Adds a
synthesized `__id TEXT PRIMARY KEY` column carrying each `Row.id`, since
easyDBAccess row IDs are opaque strings rather than auto-increment integers.
`date` columns are written as a fixed-width `'YYYYMMDD'` literal for
predictable joins.

## Sync

Sync plugins move a whole workspace between devices. They don't share a
common interface beyond `api.store.settings` for their connection state —
each targets a different backend.

### gist-sync

Footer "Push"/"Pull" against a private GitHub Gist. Credentials
(`user`/`gistId`/a GitHub PAT) are entered once as a `user=...;gist_id=...;
gist_token=...;` connection string and cached under the settings key
`gist:<workspaceId>` — **in plaintext**, since `api.store.settings` is
unencrypted IndexedDB. There is currently no UI to edit stored credentials
short of clearing that settings record (e.g. via DevTools → IndexedDB) and
re-entering the connection string; a 401 from GitHub surfaces as a bare error
toast rather than re-prompting. Each table serializes to its own
`<slug>.table.json` file in the gist, plus a `_easydb.workspace.json` marker
so Pull can tell an easyDBAccess gist from an unrelated one. Warns (with a
Push-anyway confirm) when any table's serialized JSON exceeds GitHub's
100 MB-per-file limit.

### server-sync

Footer "Sync ↑"/"Sync ↓" against a configured easyDBAccess Hono server's
`/sync/:workspaceId` route, sharing its URL/ETag persistence helpers
(`server-sync-core.ts`) with `auto-sync`. Push sends an `If-Match` ETag
header; a `412` conflict (server changed since the last pull) prompts
force-push-anyway vs. cancel-and-pull-first. Pull always confirms first,
since it wholesale-replaces local tables with the server's copy.

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

## Views

### views

Not an importer/exporter/renderer — a small display layer. A **View
Template** (workspace-global) is header/row/footer HTML; blank row HTML
renders a read-only columns table, otherwise the row HTML repeats per row
with `$TOKEN` placeholders substituted from a per-instance token→column map.
A **View Instance** ties one template to one table, snapshotting its current
sort/filter/visible-columns, and opens read-only in its own window. The
plugin itself only owns *intent*: it adds the footer "Views" button (opens
the manager dialog, which flips `ViewInstance.open`) and seeds/repairs a
built-in "RSS Feed" template on `load()`, reconciling it against a hash of
the shipped HTML so an app update can patch an already-seeded workspace's
copy without touching a copy the user deleted. Actually opening, closing,
positioning, and maximizing view windows is core code
(`window-mgr/view-window-manager.ts`), not plugin code — plugins must not
manage jsPanel windows directly.

## Chrome / UI

Small plugins that exist only to register a single button — kept as plugins
rather than shell code to dogfood the same registration path a third-party
plugin would use.

### new-table-button

Header "+ New Table" button; its `onClick` is just
`api.ui.openNewTableDialog()`. The dialog itself is core chrome — this
plugin only supplies the entry point.

### plugin-manager-button

Footer "Plugins" button; `onClick` is `api.ui.openPluginManager()`, which
opens the dialog for adding a catalog/URL plugin or toggling any
`meta.optional` built-in.

## Adding a built-in plugin

1. Drop `src/plugins/<name>.ts` exporting `meta` + `init(api)` (+ optional `load(api)`).
2. Import it and add it to the `builtins` array in `plugin-host/loader.ts`.
3. Set `meta.optional = true` if it should be user-disableable.

See [`packages/renderer/CLAUDE.md`](../packages/renderer/CLAUDE.md) for the
full plugin-host lifecycle and hot-loading details, and
[`packages/shared/CLAUDE.md`](../packages/shared/CLAUDE.md) for the rules
around changing the `HostApi` contract itself.
