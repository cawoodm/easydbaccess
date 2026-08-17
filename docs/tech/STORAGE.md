# Local Storage

How easyDBAccess persists data on one device. For moving a workspace
*between* devices, see [`SYNCH.md`](./SYNCH.md); for the plugin surface that
sits on top of this layer, see [`PLUGINS.md`](./PLUGINS.md).

## At a glance

**One storage engine, two bindings.** Every workspace is a SQLite database; what
differs is only where that database lives and which SQLite the code is bound to.

- **Browser** — `@sqlite.org/sqlite-wasm` in a Web Worker, with the database in
  the `opfs-sahpool` VFS: a real origin-private file that SQLite writes
  incrementally, so every `COMMIT` is durable. A browser that cannot install the
  pool falls back to an in-memory database mirrored to OPFS on a debounce.
- **Electron** — the renderer talks over IPC to a `node:sqlite` store in the
  **main process**, and the workspace is a `.db` file on disk.

Neither case involves a server-side database — a device with no network still
has a fully working, persistent app. `packages/server`'s `/sync` route stores
workspace *snapshots* (JSON blobs), not a live copy; see `SYNCH.md`.

```
                              Plugin
                                │  (never touches a bridge directly)
                                ▼
                            DataStore
                 packages/shared/src/plugin-api.ts — the contract
                                │
                                ▼
                      data-store-bridge.ts
                 ONE DataStore over an async bridge,
                 two transports
                                │
                 ┌──────────────┴──────────────┐
                 ▼                             ▼
        db/edb/worker.ts               electron preload.ts
        postMessage, sqlite-wasm       window.easydb.store (IPC)
                 │                             │
           EdbStore (shared)            EdbStore (shared)
                 │                             │
        opfs-sahpool VFS               node:sqlite, main process
        (or memory + mirror                    │
         where unavailable)                    ▼
                 │                    a .db file the user chose
                 ▼
        the workspace's own file, exportable
        to a .edb the user saves
```

`data-store-bridge.ts` is the **only** `DataStore` implementation. `EdbBridge`
satisfies the same `EasydbStoreBridge` interface the Electron preload does, so
the browser needed no second adapter.

Until v0.0.380 the browser's default was Dexie/IndexedDB and SQLite was opt-in
per tab. That split is gone: one engine, one row model, one set of semantics.

## A workspace in a `.edb` file (browser)

Opt-in, per tab, and per workspace. "New workspace" asks whether the data goes
in this browser or in a file; the footer **File** menu opens, saves and converts
one. `docs/tech/EDB.md` has the format and the reasoning.

Four things are worth knowing here:

- **The database lives in a Web Worker.** This app imports 600k-row tables and
  sqlite-wasm is synchronous, so a bulk insert on the main thread would freeze
  the tab for the length of the import.
- **The file is written only on Save** (or by autosave, which is off by
  default). Between saves the bytes are mirrored to OPFS.
- **The mirror is load-bearing, not insurance.** A remembered
  `FileSystemFileHandle` needs a user gesture to re-grant write permission, and
  a page load has none. The mirror is origin-private and always readable, so a
  reload restores from it and the handle is only re-permissioned on the first
  Save.
- **Permission is granted per FOLDER.** One `showDirectoryPicker` grant covers
  every workspace file in it, so New types a name and Open picks from a list,
  with no OS dialog either time. The per-file pickers remain for a browser
  without a directory picker, and for a file kept somewhere else.

The desktop writes the same v2 file, from the same `EdbStore` — so a workspace
saved in a browser tab opens on the desktop and back again. `docs/tech/EDB.md`
has the format and the two drivers.

## Why one SQLite store

The engine is hidden behind `DataStore`, so plugins never see it. SQLite is the
choice because of what it makes true above the abstraction, not below it:

- **A workspace is a file anyone can read.** DB Browser, Datasette and
  `node --experimental-sqlite` all open it. IndexedDB is opaque, cannot be handed
  to a colleague, and cannot be backed up by copying something.
- **Filtering, sorting, counting and faceting happen in SQL**, so a 609k-row
  table is answered by an index rather than by materialising every row in JS.
- **One body of storage logic** (`packages/shared/src/edb-store.ts`) serves the
  desktop and the browser, so a bug fixed once is fixed on both. The previous
  split had two implementations, two row models and two reactivity mechanisms.
- **Raw SQL becomes available to the user** — see [`SQL.md`](./SQL.md).

The cost is honest and worth naming: sqlite-wasm is roughly 1 MB of WebAssembly
to instantiate on a cold load, against Dexie's ~30 KB.

## Every logical table is a real SQL table

`DataStore.rows(tableId)` returns a *view*, and that contract is unchanged — but
underneath, each table the user creates is its own SQL table with one column per
`ColumnSpec`. `tableId` therefore selects *which* table rather than filtering a
column.

The browser used to work the other way: one shared `rows` store keyed by a
`tableId` index. That inversion removed a whole section of this document, because
the machinery it needed went with it — the shared table could not say which
logical table a delete had touched (a delete by key knows only primary keys), so
writes had to announce themselves separately or every open grid re-read itself
once per chunk of a chunked delete.

**What replaces it.** The store reports which table a write touched and the
worker broadcasts `changed(collection, scope)`, where `scope` is that table's id.
A subscriber for another table ignores it. `changeScopeOf`
(`packages/shared/src/change-scope.ts`) is the single rule both transports use,
and it derives the scope from what the write RETURNED — a `remove` request names
only a row id, and a `patch` only the changed fields, so neither can say which
table it hit until the store has looked.

Writes that cannot say what they touched — raw SQL, a workspace clone, a
workspace delete — announce every collection instead. Anything narrower would
leave a stale panel on screen.

## `DataStore` — what plugins actually see

[`data-store-bridge.ts`](../../packages/renderer/src/db/data-store-bridge.ts)
wraps each collection in the minimal `DataCollection<T>` shape from
[`plugin-api.ts`](../../packages/shared/src/plugin-api.ts):
`find`/`findOne`/`insert`/`bulkInsert`/`upsert`/`patch`/`remove`/
`bulkRemove`/`subscribe` (+ optional `refresh`). Plugins receive this wrapper
and never the transport, so a third-party URL-loaded plugin cannot reach the
database directly even if it wanted to.

One optional member is a capability rather than a collection: `store.sql` is
present only where the transport can run raw SQL, which is what lets the SQL
console feature-detect instead of guessing at the platform. See
[`SQL.md`](./SQL.md).

`subscribe()` re-runs its whole query on any `changed` broadcast for that
collection — there is no fine-grained diffing. Deliberately coarse: every
chrome component that subscribes (the table list, a grid's row set, footer
state) consumes the full result set anyway. The one place it is NOT coarse is
rows, which are scoped to a single table — see above.

## The Electron path — the workspace IS a SQLite file

Inside Electron the same `DataStore` contract is served by
[`db/data-store-bridge.ts`](../../packages/renderer/src/db/data-store-bridge.ts)
over the IPC transport. `app-context.ts` selects it when
`window.easydb?.store` exists; every `find`/`insert`/`patch`/… becomes an IPC
call to a `node:sqlite` store in the main process
([`packages/electron/src/sqlite-store.ts`](../../packages/electron/src/sqlite-store.ts)).
`ELECTRON.md` covers the shell and the preload bridge; what matters here is
the shape of what lands on disk.

**A saved `.db` is a genuine database, not an opaque blob** — openable in DB
Browser or Datasette. That is the whole point of the design, and it is what
makes "import a `.db`" a meaningful operation:

| SQL object | Holds |
|---|---|
| `<sanitized table name>` | the rows — `_id TEXT PRIMARY KEY` (= `Row.id`), `_updatedAt INTEGER`, `_extra TEXT` (overflow), then one real column per `ColumnSpec` |
| `_easydb` | everything that is not row data — `workspaces`, `settings`, `plugins`, `viewTemplates`, `viewInstances` and `tables` — as `(coll, key, workspaceId, doc)` |

This is format v2, and `packages/shared/src/edb-store.ts` is what writes it —
the same store the browser's file mode runs, bound here to `node:sqlite` instead
of sqlite-wasm. `sqlite-store.ts` adds only what a file on disk needs: the
pragmas, `checkpoint()`, `setDurability()` and the copy behind Save As. See
`docs/tech/EDB.md`.

So the browser's "one `rows` table, many logical tables" (above) inverts
here: each logical table really is its own SQL table, and `rows(tableId)`
selects *which* table rather than filtering a `tableId` column. The view
semantics plugins see are unchanged.

Three rules a naive change would break:

- **The physical table name is assigned once.** Renaming `Table.name` rewrites
  the `tables` doc, never the SQL object. Nothing outside that doc addresses a
  table by its physical name (`_sqlTable`), and renaming would risk a fresh
  collision for no benefit.
- **Column reconciliation is additive only** — `ALTER TABLE … ADD COLUMN`,
  never `RENAME` or `DROP`. `ColumnSpec` has no stable id, so a rename is
  indistinguishable from a drop-plus-add, and dropping on that guess destroys
  data (that was the v0.0.218 bug). A removed column just lingers, orphaned
  and harmless: the table doc's `columns`, not the DDL, decides what is visible.
- **`_extra` holds schemaless overflow.** `Row.data` may carry keys with no
  `ColumnSpec`; they go into a JSON object in `_extra` rather than being
  dropped. It is SQL `NULL` (not `'{}'`) when empty, and a decoded `null` is
  omitted from `data`, so a round-tripped row matches a fresh one.

[`packages/shared/src/sql-mapping.ts`](../../packages/shared/src/sql-mapping.ts)
owns the type↔SQL mapping (`sanitizeTableName`, `quoteIdent`, `sqlAffinity`,
`encodeValue`, `decodeValue`, `columnTypeFromSqlType`) and the **server's**
`storage/sqlite-store.ts` imports the same helpers — one convention, so a
`.db` written by either side has the same shape.

**Reactivity.** Nothing re-runs a query closure automatically. The main
process broadcasts
`store:changed` naming the mutated collection; the renderer's collection
re-runs its query and notifies its subscribers. Same coarse granularity as
`liveQuery`, same contract.

### Open takes only our own files; Import takes any

Opening a database is **not** a read-only act: the store's constructor runs
`CREATE TABLE IF NOT EXISTS _easydb`. Pointing it at a stranger's `.db` would
therefore add a bookkeeping table to someone else's file and then show an empty
workspace, there being no `tables` docs to list.

So `pickDatabaseToOpen` probes the picked file read-only first
(`probeDatabaseFile` in
[`db-import.ts`](../../packages/electron/src/db-import.ts)) and reports a
`kind`:

| `kind` | Meaning | What the user is offered |
|---|---|---|
| `easydb` | has our registry — a file this app wrote | Open, after a confirmation naming the file |
| `foreign` | a valid SQLite database, but not ours | Import its tables instead, reusing the already-picked path |
| `unreadable` | not a SQLite database at all | told so plainly |

Nothing is written until the user agrees to one of those. Import itself is
two-phase for the same reason: phase one previews (table names, row counts,
which collide with an existing table) with no side effects, so the app can
ask Overwrite / Rename / Skip per collision, and phase two commits only what
was agreed. The renderer half of both flows is the `electron-db` plugin
(see `PLUGINS.md`); the file operations live in
[`db-files.ts`](../../packages/electron/src/db-files.ts).

## Table names are unique, and the store is what makes them unique

Two tables in one workspace may never share a name. This is load-bearing, not
cosmetic: projections and view instances bind to their source **by name**, so a
duplicate makes every reference to it ambiguous — it resolves to whichever
document the query happens to return first.

The columns editor has always refused a clash, but it is one writer of many.
Dropping a `.table.json` and answering "Add as new tables" wrote the dump's name
verbatim and produced two tables with one name, and each importer carried its
own rule (or none). So
[`unique-table-names.ts`](../../packages/renderer/src/db/unique-table-names.ts)
decorates the `tables` collection — the one place that sees every write — and
`app-context.ts` wraps it in before anything else touches the store.

- `insert`, `bulkInsert`, `upsert` and a name-changing `patch` all go through it.
  A `bulkInsert` also resolves collisions **inside** the batch, so two tables of
  one name in a single dump collide with each other, not only with what is
  already stored.
- A taken name is uniqued by `uniqueTableName`
  ([`util/table-names.ts`](../../packages/renderer/src/util/table-names.ts)) —
  `places` → `places-2`, compared case-insensitively — and `code` is re-derived
  so it keeps matching. This is the ONE naming rule now: the CSV importer's
  base36 timestamp (`places (m8x1k2)`) and Datasette's `places (2)` both read it
  from here.
- **The write is never rejected.** A rejection would abort a gist pull or a dump
  restore halfway through a loop the caller cannot resume; a renamed table can
  be fixed by hand. Callers that show the name must use the RETURNED document,
  which carries the name that was actually stored — `json-import` does, and
  toasts which name a dumped table came in under.

## Row-source routing — when a "table" isn't local at all

A `Table` may carry an optional `source: TableSource` descriptor
(`{ type, config, writable?, serverQuery? }`). When present,
`createRoutedDataStore` (a decorator `app-context.ts` wraps around the plain
bridge-backed store) hands `rows(tableId)` to whatever
`RowCollectionProvider` a plugin registered for that `type` via
`api.registerRowSource(...)` — e.g. the `datasette-connect` plugin's live,
read-write Datasette connector — instead of the table's own local SQL table.

This routing is a **strict no-op for every ordinary table**: no `source`, an
unregistered `source.type`, or a table not yet primed into the routing
seam's synchronous cache all fall straight through to the plain local
collection, byte-for-byte identical to a table with no seam involved at all.
A snapshot *import* from Datasette (via the `import-data` plugin) is a
different, unrelated path — it copies rows once into the local `rows` table
with `origin` (not `source`) recorded, so it's an ordinary local table
afterward.

## Non-row collections

- **`workspaces`** — one record per workspace (`id`, `name`, `createdAt`,
  `pluginUrls: string[]`, optional `title`). `pluginUrls` is what makes an
  installed third-party plugin follow the workspace across devices via
  sync. `title` is an optional display name shown in the header instead of
  "easyDBAccess" (Settings → General) — presentation only; `id`/`name` stay
  the technical identifiers `?space=` routing uses.
- **`tables`** — one record per user-facing table: name, optional display
  `title` (shown in the panel titlebar; exports/references still use the
  technical `name` — same split as `Workspace.title`/`name`), `columns`
  (`ColumnSpec[]` — field/label/type/renderer/width/etc.), sort/filter
  state, `windowGeometry`, `deletedColumns` (fields the user explicitly
  removed via the column editor, so a refresh/re-import doesn't resurrect
  them), and the optional `source`/`origin`/`info` descriptors above.
- **`settings`** — the **workspace layer** of a two-layer settings model
  (see below): a flat `key → value` bag, keyed by convention as
  `${pluginId}:${key}` for anything going through `api.settings`, or a
  bespoke key for older direct `store.settings` writes (`server-sync:url`,
  `server-sync:etag:<workspaceId>`). This layer syncs with the workspace
  (dump-export, gist-sync). **Anything written here directly is still
  plaintext** — there is no encryption layer — but the settings system now
  steers actual secrets away from this collection entirely (see below).
- **`plugins`** — one record per installed third-party plugin URL, keyed by
  the URL itself: `enabled`, `lastFetched`, `cachedBody` (the fetched module
  source, so boot never blocks on a network fetch — see below), and
  `lastError`. Disabled state for a user-toggleable built-in is also stored
  here under the synthetic key `builtin:<id>`, reusing the same collection
  rather than adding a new one (see `PLUGINS.md`'s plugin lifecycle for
  which built-ins are toggleable vs. `fixed`).
- **`viewTemplates`** / **`viewInstances`** — the View system's
  workspace-global HTML templates and their per-table bindings, including
  each instance's optional `limit` (cap on rows shown) — see `PLUGINS.md`'s
  Views section.

## The settings system: two layers + a separate secrets store

`api.settings` (`SettingsApi` — `get`/`set`/`placement`) is a layered
resolver plugins use instead of touching `store.settings` directly for
anything a user might configure. A plugin declares its fields once via
`api.ui.registerSettings(pluginId, name, fields)` (surfaced as a tab in the
Settings dialog — see `DIALOGS.md`); each field carries a default `scope`
(`'workspace'` or `'user'`), and the user can promote/demote a field between
layers from the dialog. Every key lives in **exactly one layer at a time** —
writing to one layer removes it from the other:

- **Workspace layer** — the `settings` collection above, keyed
  `${pluginId}:${key}`. Syncs with the workspace.
- **User layer** — a single JSON blob in `localStorage`
  (`/easydbaccess/settings.json`, via `db/user-settings.ts`), device-local
  and **never synced**. `api.settings.get()` checks this layer first,
  falling through to the workspace layer, then the field's declared
  default.

A **separate, cross-workspace secrets store** (`/easydbaccess/secrets.txt`
in `localStorage`, a `name: value` text blob the user edits directly, or
drops in as a `secrets.txt` file) backs a third mechanism: any string
setting value may embed a `${secret:name}` reference, which
`api.settings.get()` resolves against this store on read. A `'secret'`-typed
field in the Settings dialog defaults to the **user** scope and gets a
"insert secret reference" picker, so a token can be entered once, kept out
of the synced workspace layer entirely, and referenced by name elsewhere.

This is why `gist-sync`'s GitHub token no longer sits in the workspace
`settings` blob the way it once did (see `PLUGINS.md`'s Sync section) — its
`gist_token` field is registered as `scope: 'user'` + `type: 'secret'`, so a
default install keeps it device-local. Nothing stops a plugin from writing
a real secret straight into the workspace layer instead (`scope: 'workspace'`
on a `'string'` field, or a raw `store.settings.upsert`), so this is a
convention the settings system makes easy to follow, not a hard guarantee —
still worth checking before assuming a given plugin's credentials never
leave the device.

## Boot sequence and workspace resolution

`app-context.ts`'s `init()` runs once per page load (memoized behind
`getContext()`):

1. Start the SQLite session, wrap it in `DataStore`, wrap *that* in the
   row-source-routing decorator.
2. Resolve which workspace to open, in priority order: a `?space=NAME` URL
   param (creating that workspace if it doesn't exist yet) → the
   last-active workspace, remembered in **`localStorage`** under
   `eda:lastWorkspaceId` (the one piece of local persistence outside
   IndexedDB) → the first existing workspace → a freshly-created `default`
   workspace.
3. Build the `HostApi`, then `init()` every built-in plugin synchronously,
   followed by every URL-loaded plugin.
4. On a `queueMicrotask`, emit `app:ready` and run every plugin's `load()`.

Third-party plugins persist their fetched module body to `plugins.cachedBody`
on first install. Every later boot loads from that cache instantly and kicks
off a non-blocking background re-fetch to refresh it for next time — so the
app boots without a network round trip, and stays working even if the
plugin's original URL later goes offline.

## Practical implications

- **In the browser: per-origin, per-browser.** Origin-private storage is scoped
  to the browser profile + origin, so a different browser, a private window, or
  clearing site data starts from an empty database. What is different now is the
  way out: the workspace is a SQLite file, so **Save** hands you a real `.edb`
  you can copy, back up or send. Server sync and `gist-sync` (`SYNCH.md`) remain
  the automatic answer.
- **One tab at a time.** The OPFS pool's files are exclusive origin-wide, so a
  second tab is told to wait rather than opening a second, diverging copy. This
  is stricter than the IndexedDB store it replaced.
- **No built-in encryption.** Table data, plugin settings, cached plugin source
  and sync tokens are all plain SQL in a file anything can read. Losing the
  browser's storage still loses anything not synced or saved to a file.
- **Adding a new persisted field** touches one place
  (`packages/shared/src/types.ts`). Adding a **new collection** touches three,
  in lockstep: the type, `data-store-bridge.ts`, and
  `packages/shared/src/edb-store.ts` — where an unknown collection **throws**
  rather than degrading quietly. It used to be four; the Dexie schema and its
  wrapper are gone.

## Where each piece of data lives today

A map from "thing" to its actual storage location on one device — useful when
reasoning about what `gist-sync` (see `SYNCH.md`) does and doesn't carry
across devices, since it only ever reads from a subset of this list.

The table below is the **browser** layout. Under Electron every IndexedDB row
becomes SQL in the open `.db` file instead (`rows` → one real SQL table per
logical table, everything else — `tables` included — → `_easydb`), while the
three `localStorage` entries stay exactly as they are — user-layer settings,
the secrets store, and the last-active workspace id are device-local either
way and do not travel with the `.db` file.

| Data | Where stored today |
|---|---|
| Table fields (`name`, `title`, `columns`, `view`, `windowGeometry`, `sortColumn`/`sortAsc`, `filters`, `labelColumn`, `deletedColumns`, `readonly`, `info`, `source`, `origin`) | IndexedDB (`easydb`) → `tables` |
| Row data (`row.data`) | IndexedDB → `rows` |
| View templates | IndexedDB → `viewTemplates` |
| View instances (incl. their own `windowGeometry`) | IndexedDB → `viewInstances` |
| Workspace record (`title`, `pluginUrls`, `id`, `name`) | IndexedDB → `workspaces` |
| Workspace-layer settings (`${pluginId}:${key}`, e.g. `user`/`gist_id`, `server-sync:url`, non-token `datasette:*`) | IndexedDB → `settings` |
| Installed third-party plugin state + cached module body, and toggled built-ins (`builtin:<id>`) | IndexedDB → `plugins` |
| User-layer settings (any field promoted to `scope: 'user'`, e.g. `gist_token`) | `localStorage` blob `/easydbaccess/settings.json` |
| Secrets referenced via `${secret:name}` | `localStorage` blob `/easydbaccess/secrets.txt` |
| Last-active workspace id | `localStorage` key `eda:lastWorkspaceId` |

Cross-reference with `SYNCH.md`: `gist-sync` only ever touches the `tables`,
`rows`, `viewTemplates`, `viewInstances` collections and the workspace-layer
`settings` (filtered to exclude `gist:`/`datasette:token:`/`server-sync:`
keys). Everything in the `workspaces` and `plugins` tables, all user-layer
settings, and the secrets store are never read or written by gist-sync — a
pulled workspace never gets the pusher's title, installed plugin list, or
credentials.
