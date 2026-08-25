# `.edb` — a workspace in a SQLite file

A `.edb` is an ordinary SQLite database. Open one in DB Browser, Datasette or
`node --experimental-sqlite` and the user's tables are there as real SQL tables
with real columns. That is the whole point: IndexedDB is opaque, cannot be
handed to a colleague, and no other tool can read it.

The browser and the Electron desktop write the **same** file. One store body
(`shared/src/edb-store.ts`) serves both — see
[One store, two bindings](#one-store-two-bindings) — so a workspace saved in a
browser tab opens on the desktop and back again.

## Two extensions, and the difference is the invariant

| Extension | What it is                | Workspaces | Where                                     |
| --------- | ------------------------- | ---------- | ----------------------------------------- |
| `.edb`    | A workspace file the user owns | **exactly one**, the one the file name says | the user's workspace folder, or anywhere they put it |
| `.edp`    | The **project index** — this browser's own database | any number   | the origin-private OPFS pool, never on disk |

Same format, same store, same code: `.edp` is not a second file type, it is the
one database that is allowed to hold several workspaces. `index.edp` is its only
name (`INDEX_DB_NAME`), and no user ever sees it.

**The extension is load-bearing.** Up to v0.0.427 the index was called
`local.edb`, so "a `.edb` holds one workspace" was false of the database the app
writes most — and nobody reading a `.edb` with two workspaces in it could tell a
bug from the normal case. Four duplicate-workspace bugs came out of that. The
boot renames an existing `local.edb` onto the new name once, in the substrate,
before anything is opened (`renameInPool`, `startEdbSession`).

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
CREATE TABLE <sqlTableNameFor(name)> (
  _id        TEXT PRIMARY KEY,   -- Row.id
  _updatedAt INTEGER,
  _extra     TEXT,               -- JSON overflow: keys with no ColumnSpec
  <column>   <sqlAffinity(type)> -- one per ColumnSpec
);
```

`packages/shared/src/sql-mapping.ts` does the naming and the type mapping, and
it already serves the desktop and the server — one convention across all three.

## Four rules, each of which has already cost a bug

- **A `.edb` holds exactly ONE workspace: the one its name says.** Not a
  convention — an invariant, and the one this file layer is built on.
  `spaceFileName` writes the name, `workspaceIdFromFileName` reads it back, the
  folder index maps between them, and `?space=` switches workspace by adopting
  that workspace's file. Two things enforce it, because prose did not for four
  versions: `one-per-file.ts` at every write, and `mayCreateWorkspaceIn` at the
  one line that creates a workspace at boot. The project index (`.edp`) is the
  exemption and says so in its name. A file already holding several — written
  before v0.0.427 — is read, reported and left alone; see
  [A `.edb` holds ONE workspace](#a-edb-holds-one-workspace).
- **`_sqlTable` is the table's own name, verbatim** — `Order Details`, not
  `Order_Details`. Every reference quotes it (`quoteIdent`), so nothing has to be
  stripped, and the file reads in DB Browser or Datasette under the names on
  screen. Three things are refused, none of them cosmetic: an empty name, the
  `_easydb*` prefix (this format's own metadata table) and `sqlite_*` (SQLite's).
  A clash gets ` 2`, ` 3`, … and the comparison is case-INSENSITIVE because
  SQLite's is — `Orders` and `orders` cannot both exist.
- **A rename moves the SQL object too** (since v0.0.410), so the two names stay
  the same thing. `ALTER TABLE … RENAME TO` carries the rows; a rename SQLite
  refuses leaves the physical name alone rather than failing the edit, because the
  doc is what this app reads. Only a change to `Table.name` triggers it, so a file
  written by an older version keeps its sanitised names until the user renames
  that table — opening a file does not rewrite it to tidy its names.
  `sanitizeTableName` is still what the SERVER's sync store uses, where the name
  arrives from a foreign document rather than from this app's UI.
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
  the Save writes over that file, which may hold work from another machine.
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

## A `.edb` holds ONE workspace

The rule the whole file layer already assumed, and did not enforce until v0.0.427.
Save names the file after the workspace, Open reads the workspace back out of the
name, the folder index maps one to the other, and `?space=` switches workspace by
adopting that workspace's file. A file holding two workspaces breaks all four.

Nothing about the FORMAT enforces it — `_easydb.workspaceId` scopes rows, so a
database can hold any number — and the tab's own database routinely does. That is
what the project index IS (every workspace with no file of its own), and New
workspace → Simple, a dropped `.edb` and the legacy import all add to whichever
database is open. So the rule is enforced where a `.edb` is **written**, and where
a workspace is **created**.

`persist()` used to write `bridge.export()` — the whole database. The first Save of
`alpha` out of browser storage therefore wrote every workspace the browser held
into `alpha.edb`, and a folder scan then truthfully reported several workspaces
living in one file. Three symptoms, of which the last is the worst: the workspace
list labelled two workspaces with the same file; every sync asked which copy of the
passenger was real, because it existed in two files; and a `.edb` handed to
somebody carried workspaces its name denies.

A Save now does two things (`db/edb/one-per-file.ts`, pure and unit-tested):

1. **The active workspace, alone, into its own file.** `export()` is still the fast
   path and is what a database holding one workspace takes — such a database
   already IS its file. Only a database holding several pays for a copy through a
   throwaway worker (`workspaceOnlyBytes`, the same scratch arrangement as
   `overwriteInFile` and `buildEdbFile`).
2. **A file of its own for every other workspace in that database**, where the
   folder does not already hold one. This is not tidiness: before this, a
   passenger's only copy on disk was its seat inside the active workspace's file,
   and `reloadActiveFromFile` replaces the database with the file's contents — so
   step 1 without step 2 would lose it. Idempotent, so only the save that creates
   them pays, and the toast names them.

### And where a workspace is created

Save is not the only way a second workspace got into a `.edb`. `?space=zz` in a tab
that had `alpha.edb` open created `zz` **inside** `alpha.edb` — a file named after
one workspace, holding two — and so did every fall-through on the way to creating
one: a folder that had to be asked for, or an adopt whose target had since gone.
Four routes, three of them wrong.

`mayCreateWorkspaceIn(dbName, workspaceId)` (pure, in `space-resolve.ts`) is the
whole rule, and `app-context.ts` checks it at the **one line** that creates a
workspace at boot rather than case-by-case per route. It reads off the extension: a
`.edb` may only hold the workspace its name says; a `.edp` may hold any. When it
says no, `leaveFileForIndex` points the tab at the index and reloads, and that boot
creates the workspace there.

That is also why the empty file New workspace → Advanced writes still works: the
file is `alpha.edb`, the workspace being created is `alpha`, and the rule allows
exactly that.

### What this deliberately does NOT do

`overwriteInFile` (the sync's *Overwrite disk version*) still merges into the file
rather than replacing it, because a passenger in a file the tab never adopted may
have no other copy at all — damage limitation on a file that is already wrong, not
an endorsement of it. And the producers above still add to a file-backed
**database**: they cannot reach another workspace's file any more and get a file of
their own on the next save, but the in-memory database can still hold two. Nothing
on disk does.

## "Which copy do you want to keep?" carries the facts

Three prompts ask the user to choose between two copies of one workspace — a
folder sync finding the same id here and in a file, this tab's own file having been
written by something else, a dropped file whose workspace name is already here —
and each of them has an answer that destroys work. They used to ask it on a NAME,
and both copies have the same name, so the answer was a guess.

`db/edb/copy-facts.ts` is the one builder for what they now show: tables, views,
the file's size, when the file was last written, and — for this tab's own file —
what its size was when we last agreed with it (`sizeChangeNote`, off the stamp).
It is pure, every field is optional, and an absent one is LEFT OUT rather than
shown as zero: a count that could not be taken is not a count of none.

Where the numbers come from matters, because none of it may cost a second read:

- **The file's counts** ride along with `peekWorkspaces`, which already has the
  file deserialized in its throwaway database (`PeekedWorkspace`). `scanFolder`
  stores them, with the file's `size`/`mtime`, on each `FolderWorkspace` — so the
  index a sync writes is also the answer to "what is in that file". All four
  fields are optional, because an index written before v0.0.407 has none of them.
- **Rows are deliberately not counted.** That is a `COUNT(*)` per table across
  every file in the folder, and no prompt is worth scanning a 600k-row workspace
  nobody asked about.
- **This side's counts** come from `countWorkspaceContents(..., { countRows: false })`,
  taken once per clashing workspace — the same call `partitionConflicts` already
  needed to spot an empty local shell, so the prompt costs nothing extra.

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

## A dropped `.edb` is COPIED IN, not opened

`edb-file` registers a drop handler, and it is deliberately not Open: opening
repoints the tab at the user's file and saves into it from then on, which is the
wrong answer for a file somebody sent you. The bytes are read, the workspace is
copied into this browser's own database, and the file is left untouched.

- **Which workspace** — the one the FILE NAME names (`workspaceIdFromFileName`),
  else the only one in the file, else the user is asked. `peekWorkspaces` lists
  them without importing anything.
- **Unknown name** → copied in under that id, then `reloadWithSpace`.
- **Name already here** → replace (`deleteWorkspace`, then copy) or keep both
  (`freeWorkspaceId` → `northwind-2`). A rename happens INSIDE the throwaway
  worker with `cloneWorkspace` before anything crosses over, because
  `copyWorkspace` writes each document under the id it already carries.
- **That question shows both copies' facts** — `db/edb/copy-facts.ts`, the same
  builder the folder-sync prompts use. See below.

One trap this cost: `sql-import` claimed the drop first, because its MIME test was
`type.includes('sql')` and the type this app puts on its own database files is
`application/x-sqlite3`. It now matches only a type ENDING in `sql`.

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
