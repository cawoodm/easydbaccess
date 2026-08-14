# Local Storage

How easyDBAccess persists data on one device. For moving a workspace
*between* devices, see [`SYNCH.md`](./SYNCH.md); for the plugin surface that
sits on top of this layer, see [`PLUGINS.md`](./PLUGINS.md).

## At a glance

There are **two** storage backends behind one contract, and the environment
picks which one runs — decided once, in `app-context.ts`, by whether the
Electron preload bridge is present:

- **Browser** — one IndexedDB database, accessed through
  [Dexie](https://dexie.org/), a thin wrapper that adds `liveQuery`
  reactivity and explicit versioned schema migrations on top of the raw
  IndexedDB API.
- **Electron** — no IndexedDB at all. The renderer talks over IPC to a
  `node:sqlite` store in the **main process**, and the workspace is a real
  `.db` file on disk that the user can open, save elsewhere, and read in DB
  Browser or Datasette.

Neither case involves a server-side database — a device with no network
access still has a fully working, persistent app. `packages/server`'s `/sync`
route stores workspace *snapshots* (JSON blobs), not a live copy of this
data; see `SYNCH.md`.

```
                              Plugin
                                │  (never touches Dexie or a bridge directly)
                                ▼
                            DataStore
                 packages/shared/src/plugin-api.ts — the contract
                                │
        ┌───────────────────────┼───────────────────────┐
   browser, simple        browser, .edb file        Electron
        │                       │                       │
        ▼                       └───────────┬───────────┘
  data-store-dexie.ts                       ▼
  wraps each Dexie table            data-store-bridge.ts
  in DataCollection<T>              same DataCollection<T> over an
        │                           ASYNC BRIDGE — two transports
        ▼                                   │
  dexie-db.ts                    ┌──────────┴──────────┐
  one Dexie() instance, one      ▼                     ▼
  IndexedDB database "easydb"  db/edb/worker.ts   preload.ts
        │                      postMessage        window.easydb.store
        ▼                      sqlite-wasm             │
  IndexedDB — persists across  in a Web Worker         ▼
  reloads, scoped to the origin        │        electron/src/sqlite-store.ts
                                       ▼        main process, node:sqlite
                              a .edb file the user             │
                              saves + an OPFS mirror           ▼
                                                     a .db file the user chose
```

The `DataStore` abstraction below is what makes those three interchangeable:
the plugin-facing `DataCollection<T>` contract is identical, so no plugin —
and almost nothing in the chrome — knows which backend it is talking to.

`data-store-bridge.ts` serves two of the three. It is a `DataStore` over an
async message bridge, and `EdbBridge` satisfies the same `EasydbStoreBridge`
interface the Electron preload does — so the browser's file mode needed no
second adapter. (It was called `data-store-ipc.ts` while Electron was its only
caller.)

## A workspace in a `.edb` file (browser)

Opt-in, and **per workspace**. "New workspace" asks whether the data goes in
this browser or in a file; the footer **File** menu opens, saves and converts
one. `docs/tech/EDB.md` has the format and the reasoning.

Five things are worth knowing here:

- **Storage belongs to the workspace, not to the browser or the tab.**
  `db/edb/registry.ts` keeps one `localStorage` entry per workspace naming the
  `.edb` it lives in, or nothing for one kept in IndexedDB, and boot binds the
  store the resolved workspace asks for — see `wantedWorkspaceId()` in
  `app-context.ts`, which reads `?space=` and the last-opened id before any store
  exists. Two tabs can therefore hold two workspaces in two different stores.

  This replaced a single `easydb:edb:active` key naming "the open file". That key
  was wrong about its own scope: `localStorage` is per ORIGIN, exactly like
  IndexedDB, so one file name governed every workspace and every tab, and moving
  one workspace into a file hid all the others — they were still in IndexedDB,
  but nothing in the app named them. There is no app-wide "file mode" any more,
  and so no "Back to browser storage": the way out of a file is to open another
  workspace.
- **The registry lists the local workspaces too**, which is why it is a roster
  and not just a file map. A load backed by a `.edb` never opens IndexedDB, so
  from inside a file that is the only place a browser workspace can be named.
  `app-context.ts` records the workspace it resolved on every boot, so an entry
  lost with `localStorage` comes back the next time its workspace is opened. It
  is an index, never the truth — both stores carry their own workspace records.

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

## The browser store holds 10 000 rows, and refuses the 10 001st

`db/row-budget.ts` enforces one number: **a workspace kept in this browser holds
10 000 rows.** A write that would cross it throws `RowLimitError` and nothing of it
lands. There is no setting, and no "do it anyway".

The number is measured, not chosen (full tables in
`.claude/plans/2026-08-13-sqlite-threshold.md`). In IndexedDB, on this app's row
layout:

| rows    | import | `count()` | filter | funnel list |
| ------- | ------ | --------- | ------ | ----------- |
| 20 000  | 5.8 s  | 575 ms    | 1.6 s  | 496 ms      |
| 60 000  | 135 s  | 3.5 s     | 3.2 s  | 2.0 s       |
| 120 000 | 320 s  | 5.3 s     | 5.9 s  | 4.1 s       |

The same 120 000 rows in a `.edb`: **12 s** to import, **17 ms** to count, **180
ms** to filter, and none of it grows with size. The first thing to cross a second
in IndexedDB is the per-column filter, at about 12 000 rows, so 10 000 is set
BELOW the first cliff rather than at it — and it is a number a person can recite,
which a threshold nobody remembers is not.

Four things make it hold up:

- **Per WORKSPACE, not per table.** Dexie keeps every table's rows in one `rows`
  store keyed by a random UUID, so an insert degrades against everything already
  there: the same 20 000-row chunk took 5.8 s into an empty store and 34 s with
  20 000 rows already in it. A per-table limit would let twenty tables of 10 000
  build the same hole.
- **Checked in the store, so there is nothing to go around.** The three row-adding
  calls of the Dexie rows view (`insert`, `bulkInsert`, `upsert` of a row that is
  not there yet) ask `assertRoomForRows` first. An importer, a sync pull and a
  plugin all arrive through it, and because importers write in chunks, a refused
  import is turned away whole rather than half-written.
- **Plus a PRE-FLIGHT wherever a write wipes first.** `assertIncomingFits` is
  called before the delete by every path that replaces rows it is about to
  overwrite — `server-sync-core.replaceWorkspace`, a gist pull, a JSON dump
  restore, CSV re-create/reload, a Datasette overwrite and a Datasette refresh
  merge. Without it the store's own check would refuse the insert AFTER the delete,
  and the user would be left with their old rows gone and part of a new set. It
  judges the incoming total only: whatever the wipe frees is free by then. It is
  also the one check that has to ask whether the limit applies at all, since it can
  run on any store — hence `markBrowserStore()`, set where the Dexie store is
  built.
- **A refusal is always measured.** The per-workspace total is cached (a walk of
  10 000 keys per typed row would be its own performance bug) and is only ever
  increased, so it can drift HIGH — a delete in another tab, a sync. A check that
  is about to refuse recounts first, so a stale total can delay a refusal but never
  cause one.
- **Counting stops at the limit.** `limit(max + 1).primaryKeys()` — the answer is
  only ever compared against the limit, so a 600 000-row workspace costs the same
  walk as a 10 001-row one. Counting an index range is the 14-second operation this
  file warns about everywhere else, and this runs on the write path.

Not limited: reading, editing and deleting (a workspace that is already too big
must not become unusable, only unable to grow), every `.edb` workspace, the whole
Electron app (its store is SQLite at every size), and rows that live in a provider
rather than the store. `window.__easydbRowLimit` lifts it for the two e2e specs
that must seed past it to exercise the grid's own 20 000-row read cap; nothing in
the app sets it.

## Why Dexie, not a bigger database engine

The storage layer is hidden behind `DataStore`, so the choice of engine is an
implementation detail plugins never see. Dexie was picked over something
like RxDB because the app doesn't need schema validation or a built-in
replication protocol — sync is a separate, app-owned HTTP concern (see
`SYNCH.md`) — and a thin, predictable IndexedDB wrapper with explicit
migrations is easier to reason about than a heavier reactive-database layer
bringing along conventions of its own.

## The Dexie schema

Declared once in
[`packages/renderer/src/db/dexie-db.ts`](../../packages/renderer/src/db/dexie-db.ts),
one IndexedDB database named `easydb`:

| Dexie table | Schema string | Primary key | Indexed fields |
|---|---|---|---|
| `workspaces` | `id` | `id` | — |
| `tables` | `id, workspaceId, updatedAt` | `id` | `workspaceId`, `updatedAt` |
| `rows` | `id, tableId, updatedAt` | `id` | `tableId`, `updatedAt` |
| `settings` | `key` | `key` | — |
| `plugins` | `url` | `url` | — |
| `viewTemplates` | `id, workspaceId` | `id` | `workspaceId` |
| `viewInstances` | `id, workspaceId, tableId` | `id` | `workspaceId`, `tableId` |

Dexie's schema string syntax: the first column is the primary key, the rest
are secondary indexes. Non-indexed fields on a record (e.g. `Table.columns`,
`Row.data`) live in the record's serialized value and don't need a schema
entry — only fields you plan to `.where(...)` on do.

**Schema versioning:** `raw.version(1).stores({...})` / `raw.version(2)
.stores({...})` — Dexie carries earlier versions' stores forward
automatically, so a later `version()` block only needs to declare *new or
changed* stores (the `viewTemplates`/`viewInstances` v2 bump adds two stores
without touching v1's). Adding or removing an **indexed** field bumps the
version; adding a plain JSON field on an existing record does not. A schema
change that needs existing rows rewritten (not just re-indexed) uses an
`.upgrade(tx => ...)` callback inside the relevant `version()` block — none
exists yet because nothing has needed one so far.

**Multi-tab upgrade safety:** an IndexedDB version bump can only run inside a
`versionchange` transaction, which blocks while any other tab still holds the
database open at the old version. `dexie-db.ts` handles both sides of that:
a tab notified of `versionchange` closes its own connection (and reloads if
another tab is genuinely upgrading the schema, so it comes back running the
new code rather than a dead handle); a tab whose own upgrade is `blocked` by
a stale tab shows a full-screen "close your other tabs" message instead of
hanging silently.

## The one `rows` table, many logical tables

There is **no per-user-table Dexie table**. Every row of every table the user
creates lives in the single `rows` Dexie table, disambiguated by the
`tableId` index. `DataStore.rows(tableId)` — the only way plugins ever touch
rows — returns a *view* over that one table, not a separate collection:

- Reads are `rows.where('tableId').equals(tableId)`.
- Writes (`insert`/`bulkInsert`/`upsert`) auto-stamp `tableId` onto the
  document before writing, so a plugin can never accidentally write a row
  into the wrong logical table.
- `subscribe()` runs a `liveQuery` scoped to that same `where` clause.

This is why adding a user-facing "table" never touches the Dexie schema —
only a `Table` record (in the `tables` store) is created; its rows are just
more documents in the shared `rows` store carrying that table's `id`.

## A row write wakes one table

One shared `rows` table has one cost: a change signal cannot say WHICH
logical table changed. Dexie's `storagemutated` names the index ranges a
write touched, which covers `tableId` for an insert or an update — but a
DELETE by key reports only the primary keys, because knowing which table a
deleted row belonged to means having read the row first. So a delete used to
wake every open grid, each of which re-read itself with its own progress bar,
and a chunked delete did that once per chunk.

The writer announces instead. Every write through the `rows(tableId)` view
tells that table's watchers and no others, and the coarse `storagemutated`
signal is ignored while one of our own writes is in flight
(`announceRowWrite` / `watchDexieRows`). Three rules the listener follows:

1. A mutation naming no `rows` part at all is ignored. Every panel click
   stamps its front-order onto `tables`, and without this test each one
   re-read every grid.
2. A mutation that names `tableId` values is judged exactly, by range
   overlap.
3. Anything else — another tab, or a direct `getDb()` write such as a
   workspace delete — is treated as unknown and re-read.

`subscribe()` needs none of this: a `liveQuery` records the primary keys its
own query returned, so Dexie can already tell it apart from a delete
elsewhere. It pays for that precision by materializing every row, which is
why the grid uses `watch`.

The one thing this gives up: a write from ANOTHER TAB that lands during one
of our own writes is missed, and that grid updates on its next trigger.
Nothing goes stale for a write made in this tab.

## `DataStore` — what plugins actually see

[`data-store-dexie.ts`](../../packages/renderer/src/db/data-store-dexie.ts)
wraps every Dexie table in the minimal `DataCollection<T>` shape from
[`plugin-api.ts`](../../packages/shared/src/plugin-api.ts):
`find`/`findOne`/`insert`/`bulkInsert`/`upsert`/`patch`/`remove`/
`bulkRemove`/`subscribe` (+ optional `refresh`). Plugins receive this
wrapper, never raw Dexie — the storage engine can change without a plugin
noticing, and a third-party URL-loaded plugin can't reach into IndexedDB
directly even if it wanted to.

`subscribe()` is backed by Dexie's `liveQuery`, which **re-runs the whole
query closure on any write to the underlying table** — there's no
fine-grained diffing. This is intentionally coarse: every chrome component
that subscribes (the table list, a data-table's row set, footer state)
consumes the full result set on every change anyway, so the extra
re-evaluation cost is harmless and the implementation stays simple.

## The Electron path — the workspace IS a SQLite file

Inside Electron the same `DataStore` contract is served by
[`db/data-store-bridge.ts`](../../packages/renderer/src/db/data-store-bridge.ts)
instead of the Dexie wrapper. `app-context.ts` selects it when
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

**Reactivity without `liveQuery`.** There is no Dexie here, so nothing
re-runs a query closure automatically. The main process instead broadcasts
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
Dexie-backed store) hands `rows(tableId)` to whatever
`RowCollectionProvider` a plugin registered for that `type` via
`api.registerRowSource(...)` — e.g. the `datasette-connect` plugin's live,
read-write Datasette connector — instead of the local `rows` Dexie table.

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

- **Workspace layer** — the Dexie `settings` collection above, keyed
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

1. Open the Dexie database, wrap it in `DataStore`, wrap *that* in the
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

- **In the browser: per-origin, per-browser.** IndexedDB data is scoped to
  the browser profile + origin. Opening the app in a different browser, a
  private window, or after clearing site data starts from an empty database —
  this is exactly what `SYNCH.md`'s server sync and the `gist-sync` plugin
  exist to bridge. **In Electron this doesn't apply**: the workspace is a
  file, so backing it up is copying it, and moving it to another machine is
  Save As plus Open.
- **No built-in encryption.** Everything above — table data, plugin settings,
  cached plugin source, sync tokens — is plain IndexedDB, inspectable and
  editable via DevTools → Application → IndexedDB (or, in Electron, plain SQL
  in a file anything can read). In the browser, losing the browser's storage
  (profile deletion, private-mode exit, "clear browsing data") loses
  everything not separately synced or exported.
- **Adding a new persisted field to an existing type** touches at most one
  place (`packages/shared/src/types.ts`) if the field isn't indexed. Adding
  a **new collection**, or indexing an existing field, touches four places
  in lockstep — the type, the Dexie schema + typed accessor in
  `dexie-db.ts`, the `DataStore` wrapper in `data-store-dexie.ts`, and the
  same collection in `data-store-bridge.ts` + `packages/electron/src/sqlite-store.ts`
  (an unknown collection **throws** there rather than degrading quietly) —
  see `packages/shared/CLAUDE.md`.

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
