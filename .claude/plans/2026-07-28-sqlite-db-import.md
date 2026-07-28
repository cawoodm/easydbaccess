# Import `.db` (SQLite) files in the web client

## Context

easyDBAccess can import CSV and JSON today, but not SQLite `.db` files. A `.db`
drop or upload is currently **silently mis-handled**: the import dialog's
`accept` attribute excludes binary types, and `detectKindFromName`
(`packages/renderer/src/plugins/import-data.ts:585`) is a two-way branch —

```ts
function detectKindFromName(name: string): ResolvedKind {
  return /\.csv$/i.test(name) ? 'csv' : 'json';
}
```

— so anything that isn't `.csv` is treated as JSON, `await file.text()` mangles
the binary, and the user gets an "Invalid JSON" error.

**Verdict on difficulty: low-to-moderate. Roughly a day.** The feature is
mostly plumbing, because four of the five things it needs already exist:

| Needed | Already in the repo |
|---|---|
| Binary file input | `ImporterSpec.parse(input: File \| string)` takes a `File`; `csv-import.ts:255` already does `await file.slice(...).arrayBuffer()` |
| Multi-table import flow | `importJsonText` (`json-import.ts:77-285`) — picker, name-collision modes, progress bar, per-table create |
| "Which tables?" picker | `chooseTables` (`dialogs/table-select-dialog.ts:41`), already generic: `{name, size}[]` → indices |
| SQLite type → `ColumnType` | `sqliteTypeToEda` + `mapColumns` (`plugins/datasette-client.ts:139-204`) — Datasette *is* SQLite, so this mapper is already written and `mapColumns` accepts exactly `PRAGMA table_info` shape |
| **A WASM SQLite engine** | **nothing — this is the only genuinely new piece** |

No CSP anywhere in the repo (`index.html` has no CSP meta, GitHub Pages sends
none, Electron injects none), so `WebAssembly.instantiate` is unrestricted.
Vite 6 handles `.wasm` as an asset with no config.

## Libraries required

**Runtime: `sql.js@1.14.1`** (MIT) — lazy-loaded, so zero cost until a user
actually imports a `.db`.

| File | Raw | Gzipped |
|---|---|---|
| `dist/sql-wasm.wasm` | 660 KB | 322 KB |
| `dist/sql-wasm.js` (glue) | 46 KB | 17 KB |
| **Total wire cost** | **~706 KB** | **~339 KB** |

**Dev-only: `@types/sql.js@1.4.11`** — `sql.js` ships no `.d.ts` (verified: the
tarball contains no type declarations). Types-only, no runtime bytes.

For scale: the renderer already ships ~1.9 MB of `material-icons` webfonts and
a ~527 KB main chunk, and unlike the fonts this payload is deferrable.

> Rejected: `@sqlite.org/sqlite-wasm` (~1.44 MB raw / ~555 KB gz — 1.6× larger,
> and its OPFS/worker surface targets using SQLite *as* the store, which Dexie
> already is here). Also rejected: server-side parsing via Node 24's built-in
> `node:sqlite` (already used at `packages/server/src/storage/sqlite-store.ts`)
> — free in bundle terms but breaks local-first: no offline import, nothing on
> the static GitHub Pages deploy, and it uploads the user's whole database.

### Gate: this adds npm packages

`.claude/CLAUDE.md` requires prompting before adding new npm packages. The two
above are the whole list. Confirm before `npm install`.

## Scope

Import **tables and views** from the `.db` as ordinary local snapshot
("copy") tables. Copy-only is not a limitation invented here — it is the
existing rule for every uploaded file, enforced in three places
(`import-data.ts:800`, the `?disabled=${!!this.file}` radio at `:977`, and the
`mode === 'reference' && !file` guard at `:300`), because reference mode needs
a re-fetchable URL. No SQL query box.

## Implementation

### 1. New plugin: `packages/renderer/src/plugins/sqlite-import.ts`

Mirrors `json-import.ts` in structure. Exports `meta` (`type: 'importer'`),
`init(api)`, and `importSqliteBuffer(api, buf, filename, opts)`.

`init` registers an `ImporterSpec` for consistency plus a
`registerDropHandler` that filters `/\.(db|sqlite|sqlite3)$/i` and returns
`true` when it handles the drop. Note `registries.importers` is currently
**vestigial** — nothing reads it (grep confirms only declaration/init/push), so
the drop handler and the dialog branch are the live paths. Also note
`ImporterSpec.parse` returns a single `{columns, rows}` and structurally cannot
express a multi-table file; `json-import.ts:50-64` already works around this by
returning the first table, so do the same.

**Loading sql.js** — lazy, inside the import handler, following the established
`await import('../chrome/top-progress.js')` pattern:

```ts
const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
  import('sql.js'),
  import('sql.js/dist/sql-wasm.wasm?url'),
]);
const SQL = await initSqlJs({ locateFile: () => wasmUrl });
const db = new SQL.Database(new Uint8Array(buf));
```

The `?url` import is load-bearing: Vite emits the wasm as a hashed asset and
rewrites the URL against `base`, which **must** survive three different bases —
`/easydbaccess/` (`publish.ps1` runs `vite build --base /easydbaccess/`), `./`
(the Electron `build:electron` script, for `file://`), and `/` in dev. Do
**not** hardcode a path, and do not copy
`plugin-manager-dialog.ts:22`'s `new URL(..., location.origin)` idiom — it
breaks under `file://`.

`sql.js` is UMD/CJS with a `browser` export condition; if Vite's pre-bundling
complains, add `optimizeDeps: { include: ['sql.js'] }` to
`packages/renderer/vite.config.ts` (which currently has no `optimizeDeps` at
all).

**Reading the schema:**

```sql
SELECT name, type FROM sqlite_master
 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
```

Then filter FTS/shadow artefacts (`*_content`, `*_segments`, `*_segdir`,
`*_docsize`, `*_stat`, `*_idx`, `*_data`, `*_config`) so an FTS-enabled database
doesn't present a dozen internal tables. Per table, `PRAGMA table_info(<name>)`
→ feed straight into `mapColumns` as `column_details` (its array branch reads
`d.column ?? d.name`, `d.type`, `d.notnull`, `d.is_pk` — a 1:1 fit for
`table_info`), and get row counts via `SELECT count(*)` for the picker's `size`.
Views have no `table_info` pk info; fall back to inferring columns from the
result set's `columns` array plus `inferTypeFromValues`-style sampling.

Quote identifiers as `"name"` (reuse `sanitizeIdent`'s sibling convention from
`sql-export.ts:160`) — table names from `sqlite_master` are attacker-adjacent
input in the sense that a crafted `.db` could carry a quote in a name.

**Value coercion** (SQLite has no real date or boolean type):
- `null` → `null`.
- `boolean`-typed column (`sqliteTypeToEda` infers these from `INT` + an
  `is_`/`has_`/`_flag` name pattern): `0`/`1` → `false`/`true`.
- `date`/`datetime`: pass ISO strings through; normalize to ISO
  `YYYY-MM-DD` as `csv-import.ts:551-578` does. Be aware of an existing
  asymmetry — `sql-export.ts` *writes* `date` as `'YYYYMMDD'`, so a round-trip
  through our own SQL dump needs that form accepted too.
- **BLOB**: `sqliteTypeToEda` maps `BLOB` → `'string'`, but sql.js hands back a
  `Uint8Array`, which would break the grid and JSON/gist sync. Convert: if
  under 32 KB, emit a base64 `data:` URL (the existing `cell-image` renderer
  then displays images for free); otherwise emit a `«BLOB n bytes»` placeholder.
  Never store the raw `Uint8Array`.

**Size guard**: sql.js needs the whole file resident in WASM memory. Refuse
oversized uploads up front with the real size in the message, mirroring the
existing URL-import ceiling at `import-data.ts:111-117`, rather than letting the
tab OOM.

Close the database (`db.close()`) in a `finally` — the WASM heap is not freed
otherwise.

### 2. Extract the shared multi-table writer from `json-import.ts`

`importJsonText` lines 105-285 are already fully generic over
`NormalizedTable[]`; only three things tie them to JSON: the hardcoded
`source: 'json'` in the `import:before`/`import:after` events, the
`opts.originUrl` origin stamping, and the `restoreViews(api, parsed, ...)` call
at `:276` (native dumps only).

Extract that span as an exported
`importNormalizedTables(api, tables, filename, opts)` taking
`{ source: string; maxRows?; originUrl?; afterCreate?(nameToId) }`, and export
the `NormalizedTable` interface (`json-import.ts:331`, currently module-local).
`importJsonText` then becomes parse → `parsedToTables` →
`importNormalizedTables(..., { source: 'json', afterCreate: nameToId => restoreViews(...) })`,
and `importSqliteBuffer` reuses it with `source: 'sqlite'`.

This is the highest-value part of the change: it buys the picker, the
overwrite/replace/append collision modes, the row-weighted `TopProgress` bar,
`bulkInsert` batching, and the `easydb:restack-windows` dispatch for free. Keep
it a pure extraction — no behaviour change — so the existing
`json-import.test.ts` and specs `06`, `24`, `26` stay green as the regression
check.

### 3. Wire the import dialog — `packages/renderer/src/plugins/import-data.ts`

Five small edits:
1. `ImportKind` (`:30`) → add `'db'`.
2. `detectKindFromName` (`:585`) → `/\.(db|sqlite3?)$/i` → `'db'` before the
   csv/json fallback.
3. File input `accept` (`:929`) → add
   `.db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3`.
4. "Import as" `<select>` (near `:954`) → `<option value="db">SQLite database</option>`.
5. In `doImport`'s `if (file)` block (`:310-327`) add a `kind === 'db'` branch:
   `await importSqliteBuffer(api, await file.arrayBuffer(), file.name, { maxRows })`.

The `mode === 'reference'` path needs no change — it is already guarded by
`!file`, and `.db` is upload-only.

### 4. Register the built-in — `packages/renderer/src/plugin-host/loader.ts`

Add `import * as sqliteImport from '../plugins/sqlite-import.js'` and an entry
in the `modules` array. Place it **before** `jsonImport`, because
`registerDropHandler` appends in `init()` order and the first handler returning
`true` wins — otherwise a `.db` drop risks being claimed by the JSON handler.

Leave `meta.fixed` unset so it is user-toggleable in the Plugin Manager. Be
aware the disable flag is runtime-only (`loadBuiltinPlugins` just skips
`init()`); the module stays in the bundle. That is exactly why sql.js must be
behind `await import()` inside the handler rather than a static import — a
static import would push ~46 KB of glue into the main chunk for every user,
including those who disabled the plugin.

## Verification

1. `npm run typecheck` and `npm run lint` — required before claiming done.
2. `npm run test` — `json-import.test.ts` must pass unchanged, proving step 2
   was a pure extraction. Add unit tests for the sqlite→`NormalizedTable`
   mapping (type inference, BLOB handling, `0`/`1` → boolean, view columns).
3. **New e2e spec** `e2e/36-sqlite-import.spec.ts`, modelled on
   `26-import-upload.spec.ts` — which already feeds the file input a binary
   `Buffer` via `setInputFiles({ name, mimeType, buffer })`, so no new test
   machinery is needed. Generate the fixture `.db` in a setup script using
   Node 24's built-in `node:sqlite` (**zero new dependencies** — already used at
   `packages/server/src/storage/sqlite-store.ts`): two tables, one view, a
   BLOB column, an `is_active` INTEGER, and a `created_at`. Assert table count,
   inferred column types, and row counts via the `window.__easydb.store` helper
   that spec already uses.
4. Manual: `npm run dev:renderer` → http://localhost:5190 → drag a real
   `.db` (e.g. a Datasette sample or a Chinook/Northwind SQLite file) onto the
   window; confirm the picker lists tables + views, and that the wasm loads.
5. **Base-path check — the most likely thing to break.** Run
   `cd packages/renderer && npx vite build --base /easydbaccess/`, serve `dist/`
   under a `/easydbaccess/` prefix, and confirm the `.wasm` resolves (not a 404
   against the domain root). Then `npm run build:electron` and confirm it
   resolves under `file://` too.

## Out of scope for this change

- Live/reference mode against a `.db` — uploads have no re-fetchable URL, and
  the live-SQLite story is Datasette's (`datasette-source.ts`).
- Electron-native `.db` reading via `node:sqlite`. It would be free of new
  deps, but Phase 8 has not wired the IPC storage bridge yet; the WASM path
  works identically in both shells today.

---

# Future direction

Two follow-ups, recorded here because they shape the choices above. Both are
separate pieces of work; **neither is part of the import change.**

## A. Export a whole workspace as `.db` (near-term, cheap)

**Difficulty: low — roughly half a day on top of the importer.** No new
dependency: the same `sql.js` already gives us the write direction via
`db.export(): Uint8Array` (verified in its type surface), and
`api.backend.saveFile` already accepts a `Blob`
(`plugin-host/api-factory.ts:101`), so it is
`saveFile(name, new Blob([bytes]), 'application/vnd.sqlite3')` and a **third**
entry in the Export menu, which today offers exactly two
(`dump-export.ts:27-39`: `JSON dump (.db.json)` and `SQL script (.sql)`).

**Start from the serializer that already exists.** `serializeWorkspace(api)`
(`dump-export.ts:56`) is the single whole-workspace serializer — `/sync`,
`server-sync.ts:71` and `auto-sync.ts:75` all reuse it. It already carries
`viewTemplates`, `viewInstances`, and every per-table presentation field
(`title`, `windowGeometry`, `sortColumn`/`sortAsc`, `filters`, `labelColumn`,
`info`, `deletedColumns`, `source`, `origin`). What it omits is
**`settings`**, **`plugins`**, and the `Workspace` record itself (only the bare
`workspaceId` string survives, so `name`, `title` and `pluginUrls` are lost) —
plus `Row.id`, `Table.id`/`code`/`view`/`updatedAt`.

So the export needs `serializeWorkspace` + those gaps, not a from-scratch
walk of Dexie.

**The format already exists and should not be reinvented.**
`packages/server/src/storage/sqlite-store.ts` is a working `.db` workspace
store written with `node:sqlite`. It lays a workspace out as:

```sql
CREATE TABLE _easydb_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  exported_at INTEGER NOT NULL, etag TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE _easydb_tables (
  ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  sql_table TEXT NOT NULL UNIQUE, columns_json TEXT NOT NULL
);
-- then one REAL SQL table per user table:
CREATE TABLE "<sanitised name>" (_id INTEGER PRIMARY KEY AUTOINCREMENT, "<field>" <affinity>, …)
```

with `quoteIdent` / `sanitize` / `sqlAffinity` / `encodeValue` / `decodeValue`
as its helpers (`sqlite-store.ts:357-393`), and the `_easydb_` prefix already
**reserved** — a user table whose sanitised name starts with `_easydb_` is
rejected (`:319`). So the convention is deliberately extensible.

**The gap is exactly what you asked for.** That adapter's docblock states it
"REQUIRES the body to look like `{ tables: [{ name, columns, rows }] }` (the
dump-export shape)" — i.e. it persists **tables, columns and rows only**, and
`readWorkspace` rebuilds only `{ workspaceId, exportedAt, tables }`
(`sqlite-store.ts:174-178`). The 7 Dexie collections are `workspaces, tables,
rows, settings, plugins, viewTemplates, viewInstances`
(`db/dexie-db.ts:45-55`), so a workspace pushed to `STORAGE_KIND=sqlite` and
pulled back **loses the views and every per-table presentation field even
though `serializeWorkspace` sent them**. The server keeps two adapters side by
side for this reason: `fs-store.ts` (byte-faithful JSON blob, and the default)
and `sqlite-store.ts` (normalized, lossy).

> Docs bug worth fixing on the way past: `packages/server/CLAUDE.md:23` and
> `docs/TECH.md:167` both describe this adapter as a *"single-row blob table"*.
> The code has been normalized-per-table since; the docs are stale.

So the work is **making the `.db` format lossless**, which fixes the export
feature and the server store in one move:

1. Add system tables following the existing prefix convention —
   `_easydb_workspace`, `_easydb_settings`, `_easydb_plugins`,
   `_easydb_view_templates`, `_easydb_view_instances` — and carry the per-table
   fields `sqlite-store` currently drops in `_easydb_tables` alongside
   `columns_json`. Simplest faithful approach: one row per record with the
   record's JSON in a `doc` column, since these are small and
   schemaless-by-design; `_easydb_tables.columns_json` already sets that
   precedent.
2. Bump a `schema_version` in `_easydb_meta` so readers can refuse a newer file
   rather than importing it half-understood.
3. Teach the importer from this plan to **detect** `_easydb_meta` and take a
   lossless round-trip path (restoring views/settings via the same
   `restoreViews` machinery `importJsonText` uses at `json-import.ts:276`),
   falling back to the generic `sqlite_master` path for foreign `.db` files.
   This is the payoff for extracting `importNormalizedTables` in step 2 above.
4. Keep the server's `sqlite-store.ts` and the renderer's exporter reading and
   writing the *same* schema.

**Deliberately exclude secrets.** There is a second persistence tier no
serializer touches: `db/user-settings.ts` keeps device-local settings **and
secrets in localStorage**, not Dexie (`'/easydbaccess/settings.json'` and
`'/easydbaccess/secrets.txt'`), with its own
`exportUserSettingsBlob`/`importUserSettingsBlob`. A `.db` is a file people
mail around and open in other tools, so secrets must stay out of it — and
settings values can embed `${secret:name}` references, so export the reference
text, never the resolved value. Only `gist-sync` currently exports `settings`
at all (via its own separate multi-file layout, `gist-sync.ts:351-373`); note
its `_easydb.workspace.json` marker as prior art but do not widen it to
secrets either.

**Decision to settle first:** the five SQL helpers must agree across the
renderer exporter, the renderer importer and the server store, but
`packages/shared` is documented as "pure types + the plugin API. No runtime
logic" — which is why `sqlite-store.ts` currently re-declares `ColumnType` /
`ColumnSpec` locally (`:280-284`). Either duplicate the helpers (consistent
with existing practice) or add a `packages/shared/src/sqlite-format.ts` and
relax that rule for pure, dependency-free string functions. Recommend the
latter — three copies of `encodeValue` drifting apart is a real correctness
risk, and these functions have no I/O.

## B. Use a `.db` file directly as the persistence layer (larger; needs a different engine)

This is the appealing end state — one file, no IndexedDB, open it in any SQLite
tool — and it is roughly where the architecture plan already points, but the
plan's Phase 8 is narrower than this wish and partly stale.

**What the plan says.** `.claude/plans/2026-05-21-rewrite-architecture.md`
scopes SQLite to Node and Electron's *main process*, keeping IndexedDB in the
browser: *"Persistence: IndexedDB (browser), SQLite file (Electron + server)"*,
with the modes table giving Browser `RxDB-Dexie (IndexedDB)` and Electron
`RxDB-IPC → main-process RxDB-SQLite`. Phase 8 is *"Bundle Hono into main
process, IPC bridge for RxDB, `better-sqlite3` storage adapter"*. Two caveats:
that text is written around **RxDB, which the codebase never adopted** (it uses
Dexie directly behind a hand-rolled `DataCollection` wrapper), and
`better-sqlite3` is now unnecessary — Node 24's built-in `node:sqlite` is
already in use and `engines.node` is `>=24`.

**The good news: the seam is already right, and small.** Plugins never see
storage — they get `DataStore` from `@easydb/shared`, and
`db/data-store-dexie.ts` is the **only** implementation, at **147 lines**.
`DataCollection<T>` is 10 methods (`find, findOne, insert, bulkInsert, upsert,
patch, remove, bulkRemove, subscribe, refresh?`) over 7 collections, but
written generically as a `wrap<T>()` that is ~11 implementations, not 70. Only
two files in the whole renderer import `dexie` at all
(`dexie-db.ts`, `data-store-dexie.ts`), and the swap point is a single line —
`app-context.ts:26-27`, `const baseStore = createDataStore(db)`.
`routed-data-store.ts` (73 lines) plus the `cachingTables` decorator at
`app-context.ts:48-58` already prove the composition pattern. So an alternative
`data-store-sqlite.ts` is on the order of 200-300 lines — the abstraction was
built for exactly this and has held.

**Two things that are harder than they look**, and are the real cost:

- **`liveQuery` is doing more than it appears.** It is only two call sites
  (`data-store-dexie.ts:65`, `:123`) but ~15 chrome call sites depend on it
  (`data-table.ts`, `jspanel-manager.ts`, `view-window*.ts`, `panel-footer.ts`,
  `table-list.ts`, `workspace-selector.ts`, `app-shell.ts`) *and* it is what
  primes the `tableCache` that row-source routing needs
  (`app-context.ts:37`). Critically, Dexie's version is **cross-tab for free**;
  a SQLite adapter must emit its own change notifications and solve cross-tab
  (and, for a shared file, cross-process) invalidation explicitly. Note the
  server's `sqlite-store.ts` `watch()` already has this exact limitation — it
  is an in-process `EventEmitter`, so SSE misses external edits to the file.
- **A schema mismatch at the core.** `store.rows(tableId)` is a *view* over one
  shared `rows` table with a schemaless `data` blob, auto-stamping and
  auto-filtering `tableId` (`data-store-dexie.ts:78-130`); the renderer
  CLAUDE.md states the invariant outright: *"There is **not** one Dexie table
  per logical row table."* A `.db` worth opening in another tool wants the
  opposite — one real SQL table per logical table, as `sqlite-store.ts` already
  does. Reconciling those is the actual design work, not the CRUD. Related:
  `find(query)` today is an arbitrary JS predicate over nested `data` keys,
  which becomes `json_extract` or a full scan in SQL.

**The hard news: `sql.js` cannot do this job.** It is purely in-memory — its
API is `new SQL.Database(bytes)` and `db.export()`, with no VFS, no OPFS and no
filename concept (confirmed: no `vfs`/`opfs`/`persist`/`filename` anywhere in
its type surface). Persisting a write means re-serialising and rewriting the
**entire** file, which is fine for import/export and unacceptable per-keystroke.
A live `.db` therefore needs a different engine:

| Target | Engine | Notes |
|---|---|---|
| **Electron** | `node:sqlite` | **Zero new deps**, real file on disk, full read/write. This is where the idea works cleanly and should be done first. |
| **Browser, invisible file** | `@sqlite.org/sqlite-wasm` OPFS SAHPool VFS (~555 KB gz) or `wa-sqlite@1.0.0` | A genuine incrementally-written SQLite file, but in origin-private storage — sandboxed and *not* a file the user can see or hand to another tool. Needs a worker; the repo currently has no `new Worker` anywhere. |
| **Browser, the user's actual file** | File System Access API + one of the above | The literal wish. `showSaveFilePicker`/`showOpenFilePicker` are **Chromium-only** — no Firefox, no Safari — and the repo uses neither today (no `showSaveFilePicker`, no `navigator.storage` anywhere). |

**Recommended sequencing**, and the reason to treat this as a distinct project:

1. Land the importer (this plan).
2. Land lossless `.db` export (A). This makes `.db` a first-class *interchange*
   format and, with import, already delivers most of the felt benefit —
   open your workspace in any SQLite tool, hand it to a colleague — at a
   fraction of the cost.
3. Make `node:sqlite` the Electron store behind `DataStore` (the honest
   Phase 8, minus RxDB and minus `better-sqlite3`). Full read/write to a real
   `.db` on disk, no new dependency. **Settle which seam first** — the docs
   currently disagree: `docs/STORAGE.md:33-38` and root `CLAUDE.md:160` frame it
   as the renderer's `DataStore` over IPC (per-record, live), while
   `docs/ELECTRON.md:123-126` frames it as the server's 4-method `StoreAdapter`
   (whole-workspace blob, clobber-on-write). Those give very different products;
   only the `DataStore` one is actually "working directly with a `.db`".
4. Only then consider OPFS-backed SQLite in the browser, and treat "the user's
   own `.db` file, live" as Chromium-only or Electron-only rather than a
   baseline guarantee.

The thing to protect meanwhile is the seam: keep new code going through
`DataStore`/`DataCollection` and never let Dexie leak out of
`packages/renderer/src/db/`. Steps 3 and 4 stay cheap only while that holds.
