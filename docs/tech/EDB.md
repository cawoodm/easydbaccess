# `.edb` — a workspace in a SQLite file

A `.edb` is an ordinary SQLite database. Open one in DB Browser, Datasette or
`node --experimental-sqlite` and the user's tables are there as real SQL tables
with real columns. That is the whole point: IndexedDB is opaque, cannot be
handed to a colleague, and no other tool can read it.

The browser and the Electron desktop write the **same** file. One store body
(`shared/src/edb-store.ts`) serves both — see
[One store, two bindings](#one-store-two-bindings) — so a workspace saved in a
browser tab opens on the desktop and back again.

## The format (v2)

### Everything that is not row data: one `_easydb` table

```sql
CREATE TABLE _easydb (
  coll        TEXT NOT NULL,   -- workspaces | settings | plugins
                               -- | viewTemplates | viewInstances | tables | _meta
  key         TEXT NOT NULL,   -- primary key within that collection
  workspaceId TEXT,            -- scopes settings and view instances
  doc         TEXT NOT NULL,   -- the document, JSON
  PRIMARY KEY (coll, key)
);
CREATE INDEX _easydb_coll_ws ON _easydb (coll, workspaceId);
```

A `tables` doc is the `Table` verbatim — `columns` included — plus two storage
fields, `_sqlTable` (the physical name) and `_ordinal`. One row per table, where
the old desktop layout used a registry plus a per-table metadata table.

`coll='_meta', key='format'` holds `{ version: 2, app: 'easydbaccess' }`. It is
how a file is recognised as ours.

### Row data: real SQL tables

```sql
CREATE TABLE <sanitizeTableName(name)> (
  _id        TEXT PRIMARY KEY,   -- Row.id
  _updatedAt INTEGER,
  _extra     TEXT,               -- JSON overflow: keys with no ColumnSpec
  <column>   <sqlAffinity(type)> -- one per ColumnSpec
);
```

`packages/shared/src/sql-mapping.ts` does the naming and the type mapping, and
it already serves the desktop and the server — one convention across all three.

## Three rules, each of which has already cost a bug

- **`_sqlTable` is assigned once.** Renaming a table rewrites the doc, never the
  SQL object.
- **Column reconciliation is additive only** — `ADD COLUMN`, never `RENAME` or
  `DROP`. `ColumnSpec` has no stable id, so a rename cannot be told from a
  drop-plus-add, and guessing destroyed data once already (v0.0.218). A dropped
  column just lingers, orphaned and harmless: the doc says what is visible.
- **`_extra` carries overflow**, and is SQL `NULL` when empty rather than `'{}'`,
  which is what lets a round-tripped row equal a freshly built one.

## How it runs

| Piece | File |
| --- | --- |
| The store | `packages/shared/src/edb-store.ts` |
| The driver seam | `packages/shared/src/sql-driver.ts` |
| sqlite-wasm adapter | `renderer/src/db/edb/wasm-driver.ts` |
| Worker, protocol, bridge | `renderer/src/db/edb/{worker,protocol,worker-bridge}.ts` |
| OPFS mirror | `renderer/src/db/edb/mirror.ts` |
| Files, folder, permissions | `renderer/src/db/edb/file-handle.ts` |
| Which store each workspace uses | `renderer/src/db/edb/registry.ts` |
| Starting one load's session | `renderer/src/db/edb/session.ts` |
| Making a new file | `renderer/src/db/edb/new-file.ts` |
| Copying a workspace in | `renderer/src/db/edb/convert.ts` |
| Autosave timing | `renderer/src/db/edb/dirty.ts` |
| The UI | `renderer/src/plugins/edb-file.ts` |

`EdbStore` takes a `SqlDriver` — `exec` plus `prepare` → `get`/`all`/`run` — and
nothing else. `node:sqlite` and sqlite-wasm both satisfy it, so the suites drive
the same store the browser runs, with no WASM to boot and no DOM to fake. That
is also what will make converging the desktop onto this store a small change.

No new `DataStore` adapter exists. `EdbBridge` implements the same
`EasydbStoreBridge` the Electron preload does, so `createIpcDataStore` in
`data-store-bridge.ts` is reused whole, windowed row reads included.

## Why a worker, and why an OPFS mirror

**The worker** is not about tidiness. This app imports 600k-row tables and
sqlite-wasm is synchronous, so a bulk insert on the main thread would freeze the
tab for the length of the import. OPFS needs a worker anyway:
`createSyncAccessHandle` exists nowhere else, and it is what lets the mirror work
without the COOP/COEP headers GitHub Pages cannot set.

**The mirror** looks like crash insurance, and it is, but its real job is the
reload. A remembered `FileSystemFileHandle` needs a user GESTURE to re-grant
write permission, and a boot sequence does not have one. The mirror is
origin-private and always readable, so the workspace comes back straight away and
the file handle is only re-permissioned when the user presses Save.

That is also why Open and New both force a mirror write (`flush`) before they
reload. Without it the boot after the reload finds no mirror and starts empty —
which is exactly what Open did before v0.0.347.

## A folder, not a file

The first time a workspace goes into a file, the app asks for a **folder**
(`showDirectoryPicker`). One grant covers everything in it, so afterwards:

- **New** — type a name. No OS dialog.
- **Open** — pick from the `.edb` files listed in the folder. No OS dialog.
- **Save** — covered by the same grant.

Granting per file meant a prompt for every New and every Open. The per-file
pickers are still there for a browser with no directory picker (Firefox, Safari,
where Save falls back to a download) and for a file kept elsewhere — the Open
list ends with "Another file…".

## One store, two bindings

`EdbStore` takes a `SqlDriver` — `exec`, and `prepare` returning
`get`/`all`/`run` — and nothing else. Two bindings satisfy it:

| Binding | Runs on | Used by |
| --- | --- | --- |
| `electron/src/node-sqlite-driver.ts` | `node:sqlite`, main process | the desktop, through `electron/src/sqlite-store.ts` |
| `renderer/src/db/edb/wasm-driver.ts` | `@sqlite.org/sqlite-wasm`, Web Worker | a file-backed browser tab |

`sqlite-store.ts` is the driver plus what only a real file on disk needs: the
page-cache and WAL pragmas, `checkpoint()`, `setDurability()` and the file copy
Save As makes. It holds no storage logic of its own.

## Format versions

**v2 is the only format.** v1 — an `_easydb_tables` registry, one
`_easydb_meta_<name>` per table and an `_easydb_docs` for everything else — is
what the desktop wrote between v0.0.313 and v0.0.355. It was removed in v0.0.357
with **no migration and no read path**: a v1 file does not open, and the app
cannot recover one. `coll='_meta', key='format'` is what distinguishes them.

## Tests

- `test/shared/edb-store.test.ts` — the store on `node:sqlite`
- `test/shared/edb-file.test.ts` — a saved file read back with plain SQL, no store
- `test/renderer/db/wasm-driver.test.ts` — the same store on sqlite-wasm
- `test/renderer/db/edb-convert.test.ts` — copying a workspace in
- `test/renderer/db/edb-dirty.test.ts` — autosave timing
- `test/e2e/100-edb-browser.spec.ts` — the browser flow in a real tab
- `test/e2e/desktop/` — the desktop app writing and reopening a real file
  (`npm run test:e2e:desktop`)
- `test/e2e/100-edb-browser.spec.ts` — the worker, the mirror, the reload, the
  File menu, the storage question and the folder helpers

The OS file picker cannot be driven from Playwright. Two ways round it: set the
`localStorage` marker the picker would have written, or hide `showSaveFilePicker`
and `showDirectoryPicker` so the app takes its download path — which is also what
Firefox and Safari really look like. The folder helpers are driven against OPFS,
which hands over a genuine `FileSystemDirectoryHandle` with no dialog at all.
