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

| Piece                                 | File                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| The store                             | `packages/shared/src/edb-store.ts`                       |
| The driver seam                       | `packages/shared/src/sql-driver.ts`                      |
| sqlite-wasm adapter                   | `renderer/src/db/edb/wasm-driver.ts`                     |
| Raw SQL                               | see [`SQL.md`](./SQL.md)                                 |
| Worker, protocol, bridge              | `renderer/src/db/edb/{worker,protocol,worker-bridge}.ts` |
| The OPFS pool (the durable substrate) | `renderer/src/db/edb/substrate.ts`                       |
| Single-writer election                | `renderer/src/db/edb/tab-lock.ts`                        |
| Memory fallback's mirror              | `renderer/src/db/edb/mirror.ts`                          |
| Files, folder, permissions            | `renderer/src/db/edb/file-handle.ts`                     |
| Making a new file                     | `renderer/src/db/edb/new-file.ts`                        |
| Copying a workspace in                | `renderer/src/db/edb/convert.ts`                         |
| Autosave timing                       | `renderer/src/db/edb/dirty.ts`                           |
| The UI                                | `renderer/src/plugins/edb-file.ts`                       |

`EdbStore` takes a `SqlDriver` — `exec` plus `prepare` → `get`/`all`/`run` — and
nothing else. `node:sqlite` and sqlite-wasm both satisfy it, so the suites drive
the same store the browser runs, with no WASM to boot and no DOM to fake. That
is also what will make converging the desktop onto this store a small change.

No new `DataStore` adapter exists. `EdbBridge` implements the same
`EasydbStoreBridge` the Electron preload does, so `createIpcDataStore` in
`data-store-bridge.ts` is reused whole, windowed row reads included.

## Why a worker, and why the pool

**The worker** is not about tidiness. This app imports 600k-row tables and
sqlite-wasm is synchronous, so a bulk insert on the main thread would freeze the
tab for the length of the import. OPFS needs a worker anyway:
`createSyncAccessHandle` exists nowhere else, and it is what lets this work
without the COOP/COEP headers GitHub Pages cannot set.

**The database lives in the `opfs-sahpool` VFS**, so it is a real
origin-private file and SQLite writes its pages incrementally. Every `COMMIT` is
durable. Nothing is serialised, debounced or flushed, and a reload simply
reopens the file.

That is a correctness requirement, not a performance one. The previous design
held the database in memory and mirrored whole-database bytes to OPFS on a
two-second debounce, which meant **writes made just before a reload were lost** —
the two reload specs in `test/e2e/02-general.spec.ts` catch it precisely. It was
survivable while file mode was opt-in; it is not survivable as the only store.

**One tab owns the pool.** SAHPool takes exclusive sync access handles on its
files, origin-wide, so a second tab's install fails. Ownership is elected with a
Web Lock (`db/edb/tab-lock.ts`) BEFORE the substrate is chosen — the memory
fallback needs it just as much, where two tabs would silently overwrite each
other's snapshots instead of erroring. A tab that does not win shows a blocking
notice rather than opening a second, diverging copy.

**The memory fallback** (`db/edb/mirror.ts`) remains for a browser that cannot
install the pool. It is the old behaviour, debounce window and all, and it
exists to keep such a browser working — not as a second supported way of
running.

## A folder, not a file

The first time a workspace goes into a file, the app asks for a **folder**
(`showDirectoryPicker`). One grant covers everything in it, so afterwards:

- **Save** — writes `<workspaceId>.edb` into the folder, no dialog at all. The id
  and the file name are one convention (`spaceFileName`), so there is nothing to
  ask. A name already in the folder is the one exception: it is confirmed, because
  a Save writes the WHOLE open database over that file, which may hold work from
  another machine.
- **Open** — pick from the `.edb` files listed in the folder. No OS dialog. The
  file decides the workspace: `a.edb` reloads as `?space=a`
  (`workspaceIdFromFileName` → `reloadWithSpace`), and a file holding no `a` gets
  an empty one created inside it.
- **Connect / Change workspace folder** — one command, whose title says which of
  the two it will do. **Sync workspace folder** re-reads it, and says so rather than
  going quiet when no folder has been granted.

**Nothing asks for a file NAME any more.** `edbTargetNamed` (was
`chooseEdbTarget`) takes the name rather than suggesting it: since Open reads the
workspace out of the file name, a user who typed something else got `sales.edb`
holding the workspace `q3`, and opening it then created an empty `sales` and hid
the data. The OS save dialog is the one place a name can still drift, because the
OS owns that field — and the "a file holding no `a`" rule above is what copes.

Granting per file meant a prompt for every Open. A lone file picker is not offered
as an answer to "where does this Save go?" any more: a folder grant covers every
later save and every other workspace, where a per-file grant has to be re-obtained
from a user gesture the autosave timer does not have. The per-file picker remains
for a file kept **elsewhere** — the Open list ends with "Another file…".

A browser with no directory picker (Firefox, Safari) can open a file and work on
it, but cannot write one: Save says so (`NO_FILE_ACCESS`) and the workspace stays
in the pool. There is no download fallback — that went with the IndexedDB dump in
v0.0.396, because "saved" must not mean two different things.

## One button, and commands for the rest

There is **no File menu**. It was a footer button opening an anchored menu until
v0.0.402 — a second navigation model for five items the palette already indexed,
sitting in a footer that otherwise holds the workspace's own buttons. The five are
palette commands now, under the group `File`:

| Command                           | Notes                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `edb-file:open`                   | Open workspace file…                                                             |
| `edb-file:autosave`               | Title follows the state: "Turn on" / "Turn off"                                  |
| `edb-file:folder`                 | Title follows the state: "Connect" / "Change". Only where a folder can be picked |
| `edb-file:sync-folder`            | Only where a folder can be picked                                                |
| `edb-file:leave`                  | Back to browser storage                                                          |
| `edb-file:save` **(conditional)** | Registered ONLY where `canReachAFile()` is false — see below                     |

Three things follow from a palette being one flat searched list:

- **A dynamic title is edited in place.** The palette rebuilds its list on every
  open and reads the registered `CommandSpec` objects, so mutating `title` is
  enough — nothing has to be told. `refreshFileCommands()` is called at boot and
  wherever the state behind a title changes, and `connectFolder()` exists so that
  all three paths that can grant a folder go through one of them.
- **A command cannot be hidden, so it answers for its state.** Sync with no folder
  and Back-to-browser-storage with no file both say so in a toast, where the menu
  simply left the item out.
- **Save is not registered as a command while the header button exists.** The
  palette lists every header/footer button under "Actions", so it would be the same
  entry twice. Where the browser can produce no file at all there is no button —
  and then the command is the only thing left that can explain why.

`edb-file` registers a `primary` header button for Save, and its unsaved work shows
as a red dot in the button's corner — `ButtonSpec.badge`, drawn by `app-shell`, the
notification convention. It is a badge rather than text in the label because a
label that grows and shrinks moves the buttons beside it. Two consequences worth
knowing:

- `ButtonSpec` is static and `app-shell` renders from a snapshot of the registry,
  so the plugin edits its own spec and dispatches `easydb:refresh-buttons`, which
  makes the shell re-snapshot. That event is the only reason the shell knows
  anything about this.
- The marker is pushed by `AutosavePolicy.onDirtyChange`, not polled. A workspace
  that has never been saved is dirty from boot — creating the workspace record and
  seeding the view templates are both writes, and none of it is in a file yet.

Save and the autosave switch are offered whether or not a file has been adopted.
They used to appear only in file mode, which read as "this app cannot save" in the
one state where saving is both possible and not yet done.

## Two things deliberately absent

- **New .edb file** — New workspace → Advanced already creates a workspace in its
  own file (`chrome/workspace-actions.ts`), and a Save of a workspace that has no
  file writes it into the folder and adopts it, which is the whole of what
  converting was.
- **Save As** — its job was to write the workspace out under another name, and that
  is now the one thing that must not happen: a file's name IS the workspace inside
  it. A COPY comes from New workspace → "Clone everything" followed by a Save, which
  writes the clone into the folder under its own name. (The desktop's `.db` Save As
  in `electron-db` is a different thing and stays: there the file is live, and Save
  As means copy-then-follow.)

## One store, two bindings

`EdbStore` takes a `SqlDriver` — `exec`, and `prepare` returning
`get`/`all`/`run` — and nothing else. Two bindings satisfy it:

| Binding                              | Runs on                               | Used by                                             |
| ------------------------------------ | ------------------------------------- | --------------------------------------------------- |
| `electron/src/node-sqlite-driver.ts` | `node:sqlite`, main process           | the desktop, through `electron/src/sqlite-store.ts` |
| `renderer/src/db/edb/wasm-driver.ts` | `@sqlite.org/sqlite-wasm`, Web Worker | a file-backed browser tab                           |

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
- `test/e2e/desktop/` — the desktop app writing and reopening a real file
  (`npm run test:e2e:desktop`)
- `test/e2e/100-edb-browser.spec.ts` — the worker, the pool, the reload, the file
  commands, the storage question and the folder helpers

The OS file picker cannot be driven from Playwright. Two ways round it: set the
`localStorage` marker the picker would have written, or hide `showSaveFilePicker`
and `showDirectoryPicker` so the app takes its download path — which is also what
Firefox and Safari really look like. The folder helpers are driven against OPFS,
which hands over a genuine `FileSystemDirectoryHandle` with no dialog at all.
