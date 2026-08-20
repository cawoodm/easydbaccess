# @easydb/electron

Desktop shell **and** desktop storage. A `BrowserWindow` that loads the
renderer — Vite in dev, the built `frontend/index.html` in production — plus a
`node:sqlite` store in the main process. The browser build runs the same store
on sqlite-wasm; this package is the desktop's binding to it.

## Files

| File                         | Role                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                | App entry. Creates the BrowserWindow, picks dev vs prod loader, registers the `store:*` and `db:*` IPC handlers, applies the production CSP, handles `window-all-closed` / `activate`.                                          |
| `src/sqlite-store.ts`        | The desktop's binding to `EdbStore` (`packages/shared`) plus the connection tuning and file controls. Holds no storage logic — see "Storage layout" below.                                                                      |
| `src/node-sqlite-driver.ts`  | The `SqlDriver` `EdbStore` runs on, over `node:sqlite`. The browser binds the same store to sqlite-wasm.                                                                                                                        |
| `src/db-files.ts`            | The store singleton (open / close / switch, remembered path) and the Open / Save As file operations, including the OS dialogs.                                                                                                  |
| `src/db-import.ts`           | Reads **any** SQLite file's `sqlite_master` and imports its tables and views — a two-phase preview-then-commit so the renderer can resolve name collisions first. Also `probeDatabaseFile`, the guard Open needs.               |
| `src/db-browse.ts`           | Read-only listing and reading of a file's tables + views, for Browse. Never writes — not even a `-wal`.                                                                                                                         |
| `src/db-convert.ts`          | Convert to EDA: writes a NEW workspace file from a foreign one, leaving the original alone. Takes an `only` list of source object names — the renderer asks which, the same as Import does; without it, every table (no views). |
| `src/preload.ts`             | contextBridge surface exposed as `window.easydb`: `{ platform, version, store, db }`. Never the raw `ipcRenderer`.                                                                                                              |
| `scripts/dev.cjs`            | Boots `dev:renderer` (Vite) first, then launches Electron with `EASYDB_RENDERER_URL` pointing at it.                                                                                                                            |
| `scripts/check-frontend.cjs` | `prestart` guard — fails with a readable message instead of Chromium's "Not allowed to load local resource" when `frontend/index.html` was never built.                                                                         |
| `electron-builder.json`      | Packaging config (out of scope for code edits — bumped via the publish scripts at repo root).                                                                                                                                   |

Design: [`.claude/plans/2026-07-31-electron-sqlite-storage.md`](../../.claude/plans/2026-07-31-electron-sqlite-storage.md).

**Open, Browse and Import are not interchangeable.** Browse and Import take any
SQLite file; Open takes only a file this app wrote. Opening is not a read-only
act — the store's constructor runs `CREATE TABLE IF NOT EXISTS _easydb` — so
pointing it at a stranger's database adds a table to it and then shows an empty
workspace, there being no `tables` docs to list.
`probeDatabaseFile` therefore runs first, read-only, and `pickDatabaseToOpen`
returns its verdict as `kind`; the renderer (`plugins/electron-db.ts`) offers
Convert or Browse for a `foreign` file and says so plainly for an `unreadable`
one. Design: [`2026-08-03-open-db-three-ways.md`](../../.claude/plans/2026-08-03-open-db-three-ways.md).

**The stamp alone does not make a file ours.** `isEasydbFile` requires `_easydb`
to be _usable_: some `coll='tables'` docs in it, OR no unregistered user objects
in the file. A file the pre-guard Open had already stamped carries an empty
`_easydb` over all of its real tables — a real `northwind.db` did, with 13 tables
and 17 views — and testing only for the stamp made Open show a blank workspace
and made Import find zero tables, both silently. A brand-new easydb file also has
no `tables` docs and must still count as ours; unregistered data sitting
alongside is what separates the two.

## Storage layout

A saved `.db` is a genuine database — openable in DB Browser or Datasette —
not an opaque blob. That is the whole point of the design, and it is why
"import a `.db`" is meaningful.

| SQL object               | Holds                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `<sanitized table name>` | the rows: `_id TEXT PRIMARY KEY` (= `Row.id`), `_updatedAt INTEGER`, `_extra TEXT` (overflow), then one column per `ColumnSpec`        |
| `_easydb`                | everything else — `workspaces`, `settings`, `plugins`, `viewTemplates`, `viewInstances`, `tables` — as `(coll, key, workspaceId, doc)` |

**The rules are not in this package.** They live with the store that enforces
them, `packages/shared/src/edb-store.ts`: the physical table name assigned once,
additive-only column reconciliation, `_extra` overflow. `docs/tech/EDB.md` states
each and why. This package supplies the `node:sqlite` driver
(`src/node-sqlite-driver.ts`) and the file-level controls a real database on disk
needs — page-cache and WAL pragmas, `checkpoint()`, `setDurability()`,
`copyDatabase()`.

Format **v2 only**. v1 — an `_easydb_tables` registry, one
`_easydb_meta_<name>` per table and `_easydb_docs` — is what this package wrote
between v0.0.313 and v0.0.355. It was removed in v0.0.357 with no migration and
no read path, so a v1 file does not open.

`packages/shared/src/sql-mapping.ts` owns the type↔SQL mapping
(`sanitizeTableName` / `quoteIdent` / `sqlAffinity` / `encodeValue` /
`decodeValue` / `columnTypeFromSqlType`) and the server's `sqlite-store.ts`
imports the same helpers — one convention, so a `.db` written by any of the
three has the same shape.

## Dev vs prod

```ts
const isDev = !!process.env.EASYDB_RENDERER_URL;
```

- **Dev**: `dev:electron` runs Vite on the branch's port and sets the URL. The
  window loads it and opens DevTools detached.
- **Prod**: `loadFile(path.join(__dirname, '../frontend/index.html'))` —
  `packages/electron/frontend/`, built by
  `npm run build:electron --workspace @easydb/renderer` (`--base ./`). Kept
  separate from `packages/renderer/dist/` so the gh-pages build
  (`--base /easydbaccess/`) can't collide with the `file://` build.

The production load also gets a CSP via `onHeadersReceived`. It keeps
`script-src 'unsafe-eval'` because per-column user scripts run through
`new Function` (`renderer/src/util/column-script.ts`) — which means Electron's
"Insecure Content-Security-Policy" console warning still fires in dev. That
warning cannot be silenced without dropping the column-script feature, and
Electron itself suppresses it in a packaged build.

## Security defaults

`BrowserWindow` is created with `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. Don't relax any of these.
Anything the renderer needs from the main process goes through
`preload.ts` via `contextBridge.exposeInMainWorld`.

`preload.ts` imports `db-files.ts` / `db-import.ts` **for their types only**
(`import type`). Their runtime code calls `dialog`/`app`/`BrowserWindow`,
which don't exist in preload's context.

## CommonJS, not ESM

This package is `"type": "commonjs"` (the only one in the monorepo).
Electron's main process is happiest on CJS, and `electron-builder` packages
that shape cleanly. Imports use plain TS / ESM-style syntax but compile to
CJS via `tsc`. Don't switch this to ESM without verifying
`electron-builder` still resolves the entry.

`node:sqlite` is loaded with `require('node:sqlite')`, not a static `import` —
the bundler/transpiler chain mishandles the built-in otherwise. Electron 43
(Node 24) is what makes it available unflagged.

## What's intentionally not wired yet

The remaining Phase 8 work-items:

- **Hono in-process** — main process boots `createServer(...)` from
  `@easydb/server` and mounts it on a localhost port, passing it a
  `StoreAdapter` over the same SQLite file. `@easydb/server` is currently
  **not** a dependency of this package (removed in v0.0.314 — it sat unused
  and, as a `file:` dependency, was tripping electron-builder's
  production-install step under npm workspaces; see "Packaging" below). Add
  it back to `package.json` `dependencies` (and `../server/dist/**/*` to
  `electron-builder.json`'s `files`) when this lands.
- **Native saveFile** — `api.backend.saveFile` still uses a browser
  `<a download>`. The `.db` operations already use
  `dialog.showSaveDialog`; routing `saveFile` through it is the leftover.

When you add either:

1. Implement on the main side under `src/main.ts` (or split into
   `src/ipc/` if it grows).
2. Expose a minimal surface via `preload.ts` — never the raw Electron API.
3. Keep the branch in `app-context.ts` (or a plugin's own `init` guard, as
   `renderer/src/plugins/electron-db.ts` does) — not scattered
   `window.easydb` checks inside `api.backend` / `DataStore` callers.

## Packaging

`electron-builder --config electron-builder.json` runs an "installing
production dependencies" step (`npm install --omit=dev` scoped to this
package) whenever `package.json` has real `dependencies` — under npm
workspaces that install isn't actually scoped: it resolves against the root
lockfile/hoisted tree, and can prune root-hoisted devDependencies that other
tooling still needs (this bit `app-builder-bin` itself, electron-builder's own
packaging helper, causing a same-run `ENOENT`). Keeping this package's
`dependencies` list as small as possible (ideally empty) avoids triggering
that step at all.

## Build / package / test

```bash
npm run dev:electron          # vite + electron (live reload)
npm run build --workspace @easydb/electron
npm run build:electron --workspace @easydb/renderer   # produces frontend/
npm run start:electron        # uses already-built dist + frontend
npm test --workspace @easydb/electron                 # vitest: store, import, sql mapping
npm run test:e2e:desktop      # playwright: the real app (test/e2e/desktop/)
npm run package:electron      # electron-builder installer (PowerShell wrapper)
```

The store module is pure Node, so vitest covers it directly — no Electron
runtime needed for the storage tests. What vitest CANNOT reach is anything in
`db-files.ts` (it imports `electron`) and the renderer's choice of store, so
`test/e2e/desktop/` launches the real app for those: boot, the file it writes,
restart, Save As and Import. See `docs/tech/ELECTRON.md` § Tests for the three
launch arguments that make it isolated.
