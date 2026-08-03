# @easydb/electron

Desktop shell **and** desktop storage. A `BrowserWindow` that loads the
renderer — Vite in dev, the built `frontend/index.html` in production — plus a
`node:sqlite` store in the main process that the renderer uses instead of
Dexie/IndexedDB.

## Files

| File | Role |
|---|---|
| `src/main.ts` | App entry. Creates the BrowserWindow, picks dev vs prod loader, registers the `store:*` and `db:*` IPC handlers, applies the production CSP, handles `window-all-closed` / `activate`. |
| `src/sqlite-store.ts` | The store itself. User tables become real SQL tables; everything else lives in `_easydb_docs`. See "Storage layout" below. |
| `src/db-files.ts` | The store singleton (open / close / switch, remembered path) and the Open / Save As file operations, including the OS dialogs. |
| `src/db-import.ts` | Reads **any** SQLite file's `sqlite_master` and imports its tables — a two-phase preview-then-commit so the renderer can resolve name collisions first. |
| `src/preload.ts` | contextBridge surface exposed as `window.easydb`: `{ platform, version, store, db }`. Never the raw `ipcRenderer`. |
| `scripts/dev.cjs` | Boots `dev:renderer` (Vite) first, then launches Electron with `EASYDB_RENDERER_URL` pointing at it. |
| `scripts/check-frontend.cjs` | `prestart` guard — fails with a readable message instead of Chromium's "Not allowed to load local resource" when `frontend/index.html` was never built. |
| `electron-builder.json` | Packaging config (out of scope for code edits — bumped via the publish scripts at repo root). |

Design: [`.claude/plans/2026-07-31-electron-sqlite-storage.md`](../../.claude/plans/2026-07-31-electron-sqlite-storage.md).

## Storage layout

A saved `.db` is a genuine database — openable in DB Browser or Datasette —
not an opaque blob. That is the whole point of the design, and it is why
"import a `.db`" is meaningful.

| SQL object | Holds |
|---|---|
| `<sanitized table name>` | the rows: `_id TEXT PRIMARY KEY` (= `Row.id`), `_updatedAt INTEGER`, `_extra TEXT` (overflow), then one column per `ColumnSpec` |
| `_easydb_meta_<sanitized>` | that table's `columns_json` (the `ColumnSpec[]` verbatim) + `table_json` (the `Table` doc minus `columns`) |
| `_easydb_tables` | registry: `id`, `name`, `sql_table`, `ordinal` |
| `_easydb_docs` | `workspaces`, `settings`, `plugins`, `viewTemplates`, `viewInstances` — `(coll, key, workspaceId, doc)` |

Three rules that a naive change would break:

- **`sql_table` is assigned once.** Renaming `Table.name` updates the registry
  and `table_json`, never the SQL object — nothing outside the registry
  addresses a table by its physical name, and renaming risks a fresh collision
  for no benefit.
- **Column reconciliation is additive only** — `ALTER TABLE … ADD COLUMN`,
  never `RENAME`/`DROP`. `ColumnSpec` has no stable id, so a rename is
  indistinguishable from a drop-plus-add; dropping on that guess destroys data
  (the v0.0.218 bug). A removed column just lingers, orphaned and harmless:
  `columns_json`, not the DDL, says what is visible.
- **`_extra` holds schemaless overflow.** `Row.data` may carry keys with no
  `ColumnSpec`; they go to a JSON object in `_extra` rather than being dropped.
  It is SQL `NULL` (not `'{}'`) when empty, and a decoded `null` is omitted
  from `data` so a round-tripped row matches a fresh one.

`packages/shared/src/sql-mapping.ts` owns the type↔SQL mapping
(`sanitizeTableName` / `quoteIdent` / `sqlAffinity` / `encodeValue` /
`decodeValue` / `columnTypeFromSqlType`) and the server's `sqlite-store.ts`
imports the same helpers — one convention, so a `.db` written by either side
has the same shape.

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

`@easydb/server` is a runtime dependency in `package.json` but `src/main.ts`
does not import or boot it. The remaining Phase 8 work-items are:

- **Hono in-process** — main process boots `createServer(...)` from
  `@easydb/server` and mounts it on a localhost port, passing it a
  `StoreAdapter` over the same SQLite file.
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

## Build / package / test

```bash
npm run dev:electron          # vite + electron (live reload)
npm run build --workspace @easydb/electron
npm run build:electron --workspace @easydb/renderer   # produces frontend/
npm run start:electron        # uses already-built dist + frontend
npm test --workspace @easydb/electron                 # vitest: store, import, sql mapping
npm run package:electron      # electron-builder installer (PowerShell wrapper)
```

The store module is pure Node, so vitest covers it directly — no Electron
runtime needed for the storage tests.
