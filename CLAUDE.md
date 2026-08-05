# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

easyDBAccess is a greenfield rewrite of [`minniDBMax`](C:\projects\Marc\minniDBMax) —
a local-first, plugin-extensible, multi-table database app that runs both as a
browser app and as an Electron desktop app, with a small loosely-coupled Node
backend for multi-device sync and URL-based data ingestion.

The canonical design lived at `.claude/plans/2026-05-21-rewrite-architecture.md`.
That file no longer exists; the dated per-feature notes still in
`.claude/plans/` are what survives of it, and they remain more authoritative
than this file for the _why_ behind anything they cover. Read the relevant one
before making structural changes. Phases 1–6 are landed (skeleton +
shared types + Dexie + plugin host + built-in plugins + jsPanel windows +
standalone Hono server with `/sync`, `/fetch`, `/plugins/registry`). Phase 8's
storage half is landed too: inside Electron the renderer talks to a
main-process SQLite store over IPC (`node:sqlite`, not `better-sqlite3`) and
the user can open / save / import `.db` files. Phase 7 (live multi-device
replication beyond whole-workspace blob push/pull), the rest of Phase 8
(Hono in-process, native save dialog), Phase 9 (migration from v1
localStorage), and Phase 10 (polish) are ahead.

## Commands

All scripts run from the repo root (`npm` workspaces). Node ≥24 required
(`engines.node`); the server's `process.loadEnvFile` and Electron 43 expect it.
Electron 43 is also what makes `node:sqlite` available unflagged in the main
process — the Electron storage layer depends on it.

| Command                    | What it does                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`              | Install all workspace dependencies.                                                                                                                                                           |
| `npm run dev:renderer`     | Vite dev server at **`http://localhost:5190`** (port chosen to avoid clashing with the legacy `minniDBMax` on `:5173`).                                                                       |
| `npm run dev:server`       | `tsx watch` for the Hono server (`packages/server/src/standalone.ts`), defaults to port 3000.                                                                                                 |
| `npm run dev:electron`     | Vite + Electron with live reload (`scripts/dev.cjs` boots renderer first, then launches Electron pointed at it).                                                                              |
| `npm run build`            | Build every workspace that defines a `build` script.                                                                                                                                          |
| `npm run typecheck`        | `tsc -b` across all project references, then `test/tsconfig.json` for the suites. Run this before claiming work is done.                                                                      |
| `npm run lint`             | ESLint over `packages/` and `test/` (`test/e2e/` is ignored — see `eslint.config.mjs`).                                                                                                       |
| `npm run test`             | One Vitest run over `test/renderer/` + `test/server/` (the server suites are e2e-style HTTP tests).                                                                                           |
| `npm run test:e2e`         | Playwright suite under `test/e2e/` (79 specs covering dialogs, table, columns editor, cells, import/export, filters, window manager, auto-sync, sql-export, backend proxy, plugins registry). |
| `npm run test:e2e:ui`      | Same, with Playwright's interactive UI.                                                                                                                                                       |
| `npm run format`           | Prettier across `packages/` and `test/`.                                                                                                                                                      |
| `npm run package:electron` | `package-electron.ps1 -Installer` — builds renderer + electron, runs `electron-builder` for the Windows installer.                                                                            |
| `npm run publish`          | `publish.ps1` — release script. Only needed for **branch previews** now; `main` publishes itself (see below).                                                                                  |

The `dev` script chains renderer + server with `&`; on Windows prefer running
`dev:renderer` and `dev:server` in separate terminals.

## Publishing

`https://cawoodm.github.io/easydbaccess/` is deployed by CI, not by hand:
`.github/workflows/publish.yml` runs on every push to `main`, builds the
renderer with `--base /easydbaccess/`, and deploys it to this repo's GitHub
Pages site (`actions/upload-pages-artifact` + `actions/deploy-pages`). A
project site is served at the repo-name path, which is the same
`/easydbaccess/` URL `publish.ps1` writes into the Pages repo — so the project
site now owns that path and the `easydbaccess` folder in
`cawoodm/cawoodm.github.io` is no longer what visitors see.

Branch previews are still manual and still go through the Pages repo:
`npm run publish -- -Target easydbaccess<N>`. Don't point `publish.ps1` at the
plain `easydbaccess` slot any more — it would deploy to a folder nothing reads.

## Versioning

**Every commit bumps the patch version**, and every place the version is shown
is kept in sync with `package.json` (the single source of truth): the
`<title>` in `packages/renderer/index.html` **and** the header-bar
`<span class="version">` in `packages/renderer/src/chrome/app-shell.ts`. This
is automated by `.githooks/pre-commit`, which runs `scripts/bump-version.mjs`
(increments `package.json` `version`, rewrites both displayed spots, and stages
the files). Enable the
hook in a fresh clone with `git config core.hooksPath .githooks` (git config is
local, so it must be re-run per clone). If you commit somewhere the hook isn't
active, run it manually first: `node scripts/bump-version.mjs` (or
`--sync-only` to only repair index.html drift without bumping). The publish
scripts read the version from `package.json`.

## Architecture in one paragraph

Three logical pieces:

1. **`packages/renderer`** — Lit web components for the chrome. Identical code
   runs in the browser (Vite-served) and inside the Electron renderer. In the
   browser it talks to Dexie/IndexedDB; in Electron the same `DataStore`
   contract is served over IPC by the main-process SQLite store. Sync goes
   over HTTP to the server.
2. **`packages/server`** — A Hono app exposed by `createServer({ store, fetchFn, ... })`.
   The _same_ exported app is designed to run inside Electron's main process
   **and** as a remote peer (`packages/server/src/standalone.ts`). Routes:
   `/health`, `/sync` (whole-workspace JSON blob push/pull with ETag), `/sync/:workspaceId/stream`
   (SSE), `/fetch` (URL proxy with allowlist + size cap), `/plugins/registry`
   (operator-curated catalog file).
3. **`packages/electron`** — Shell that loads the renderer (Vite in dev, built
   `frontend/index.html` in prod) **and** owns the desktop storage: a
   `node:sqlite` store (`src/sqlite-store.ts`) that keeps user tables as real
   SQL tables, file operations for Open / Save As / Import (`src/db-files.ts`,
   `src/db-import.ts`), and the `store:*` / `db:*` IPC surface `preload.ts`
   hands to the renderer.

`packages/shared` holds the contracts every layer agrees on: TS `types.ts`
and — most importantly — `plugin-api.ts`, which defines the `HostApi` every
plugin receives.

## The plugin model (load-bearing)

`packages/shared/src/plugin-api.ts` **is the single source of truth** for what
plugins can do. Everything else is downstream. Read this file before changing
the renderer's `plugin-host/`, the `DataStore` adapter, or the event bus.

- A plugin is a single ES module `.js` file. Built-ins are static-imported
  from `packages/renderer/src/plugins/`; third-party plugins are URL-loaded
  by the host, cached in the `plugins` Dexie table (offline reuse),
  wrapped in a Blob URL, dynamic-`import()`ed, then `init(api)` / `load(api)`.
- The `api` object exposes `store` (data layer), `events` (typed bus), `ui`
  (slot registries: header/footer/table buttons, cell/row/table renderers,
  importers/exporters, drop handlers, URL sources, plus shell-dialog openers
  and a `Dialogs` surface for alert/confirm/prompt/choice/toast),
  `windows`, `backend.fetch` + `backend.saveFile`, `workspaceId()`, `selfUrl()`.
- Plugins **may monkey-patch `api.*` methods** to override defaults — this is
  contractual, not a bug. The host does not police it.
- **Built-in features ARE plugins.** The full built-in roster (`plugin-host/loader.ts`)
  is currently: `new-table-button`, `csv-import`, `json-import`, `sql-import`,
  `csv-export`, `dump-export`, `sql-export`, `gist-sync`, `server-sync`,
  `cell-color`, `cell-image`, `cell-link`, `cell-date`, `cell-datetime`,
  `cell-boolean`, `cell-tags`, `auto-renderer`, `preview`, `html-render`, `cell-markdown`,
  `delete-table`,
  `table-copy`,
  `import-data`, `auto-sync`, `views`, `settings`, `url-source`,
  `datasette-import` (+ `datasette-views`), `datasette-connect`, `connect-menu`,
  `projection`, `command-palette-button`, `electron-db`, `sqlitefile-source`.
  Don't add a feature to
  the core if it can be a plugin. (Exception: the Plugin Manager button is core
  chrome in `app-shell.ts`, not a plugin — it opens the manager that governs
  plugins.)
- `meta.optional = true` marks a built-in as user-toggleable. The Plugin
  Manager dialog surfaces these; disabled state is stored under the synthetic
  key `builtin:<name>` in the `plugins` collection.

## Projections bind to their sources BY NAME

A `ProjectionSpec` source carries `tableName` and nothing else — there is
deliberately no `tableId`. A projection has to survive its source table being
deleted and re-imported (the ordinary refresh loop for anything backed by a URL
or a Datasette instance), and the replacement is a new row with a new id under
the same name.

The consequence is that a RENAME is the one edit that can break a projection,
so the columns editor warns before it writes and then carries the references
across (`table/table-references.ts`, used by `new-table-dialog`'s `submit`).
View instances bind the same way and are repointed in the same place.

**Fields are name-bound too**, in three places: a projection's output fields
(`columns[].field`, which key its own `ColumnSpec`s), the source fields it reads
(`columns[].from.field`) and its join keys (`sources[].join.on`). So a FIELD
rename is carried across in the same `submit`, by `renameProjectionOutputs` /
`renameProjectionSourceFields`. Without it a renamed column came out empty — the
projection kept writing the old key while the renamed column read the new one —
and a join key left on the old name matched nothing.

## The DataStore abstraction (don't bypass it)

The renderer opens a Dexie database (`db/dexie-db.ts`) and wraps each Dexie
table in the minimal `DataCollection<T>` shape from `plugin-api.ts`
(`db/data-store-dexie.ts`). The wrapper is the only surface plugins see — the
storage layer remains swappable, and Electron proves it: there
`app-context.ts` builds the same contract over IPC instead
(`db/data-store-ipc.ts` → `packages/electron/src/sqlite-store.ts`). When
adding new collections, touch **four** places in lockstep:

1. Type → `packages/shared/src/types.ts`
2. Dexie schema + typed table → `packages/renderer/src/db/dexie-db.ts`
3. Plugin-facing wrapper → `packages/renderer/src/db/data-store-dexie.ts`
4. The IPC store's collection list → `packages/renderer/src/db/data-store-ipc.ts`
   and `packages/electron/src/sqlite-store.ts` (an unknown collection throws
   there rather than failing silently)

`store.rows(tableId)` returns a _view_ (not a separate Dexie table) that
auto-injects `tableId` into inserts and queries. There is one underlying
`rows` table indexed on `tableId`. The SQLite store keeps that same view
semantics, but each logical table there really is its own SQL table, so
`tableId` selects _which_ table rather than filtering a column.

Subscriptions use Dexie's `liveQuery`, which re-runs the query closure on any
write to the underlying table. Chrome callers consume the full result set
each time, so the coarse granularity is harmless. On the IPC path the main
process broadcasts `store:changed` per collection and the collection re-runs
its query — same coarse granularity, same contract.

## Cross-cutting gotchas

These have already bitten this codebase. Don't re-litigate them.

- **Lit + `useDefineForClassFields`:** Lit's `@property`/`@state` decorators
  clash with native class fields. The renderer's `tsconfig.json` sets
  `useDefineForClassFields: false` and `experimentalDecorators: true`. Do
  **not** change this without rewriting all Lit components to use the
  `declare` keyword. The shared/server/electron packages keep TS defaults.
- **Lit override modifiers:** `tsconfig.base.json` sets `noImplicitOverride`.
  `connectedCallback`, `disconnectedCallback`, `updated`, `render`, and
  `static styles` all need `override` (or `static override`).
- **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`:** Optional
  properties whose values can be `undefined` need an explicit `| undefined`
  in the type. Array indexing returns `T | undefined`. Don't paper over with
  `!` — handle the case.
- **No barrel-imports of Dexie outside `packages/renderer/src/db/`.** Plugins
  receive `DataStore` from `@easydb/shared`; if you find yourself reaching
  for `dexie` directly elsewhere, the abstraction is leaking.
- **URL-loaded plugins are self-contained ES modules.** They run via Blob
  URL dynamic-import and cannot use bare imports (`import x from 'lit'`).
  Built-in plugins, by contrast, freely import workspace packages.
- **Vite + dynamic blob imports:** the `import(blobUrl)` call needs a
  `/* @vite-ignore */` comment so Vite doesn't try to statically resolve it.

## What's intentionally not wired yet

Don't "fix" these without checking the plan section first:

- **Hono in the Electron main process** — Phase 8's other half. `main.ts` boots
  the storage IPC but does not mount `@easydb/server`, even though the package
  is already a dependency. (Storage itself IS wired — see the DataStore
  section.)
- **Live multi-device replication beyond the JSON-blob `/sync` route** —
  Phase 7. The current `server-sync` plugin and `/sync/:workspaceId` route
  push/pull the entire workspace as one document with ETag concurrency. SSE
  notifies of remote changes; full row-level replication is not yet wired.
- **Electron native saveFile / openFile** — the `backend.saveFile` plugin
  surface exists, but in Electron it still uses the browser `<a download>`
  fallback. `dialog.showSaveDialog` is already used for the `.db` file
  operations (`src/db-files.ts`); `backend.saveFile` has not been routed
  through it.
- **Migration from v1 minniDBMax localStorage** — Phase 9.

## Every test lives in root `test/`

No test file sits next to the code it covers. `test/renderer/` and
`test/server/` mirror the source tree of their package, so a new test for
`packages/renderer/src/util/ids.ts` goes to `test/renderer/util/ids.test.ts`
and imports the module by relative source path
(`../../../packages/renderer/src/util/ids.js`). Playwright specs go in
`test/e2e/`. Both runners are driven from the repo root — one
`vitest.config.ts` (`test/**/*.test.ts`) and `playwright.config.ts`
(`testDir: './test/e2e'`); the packages have no `test` script of their own.
See `docs/tech/TESTING.md`.

## Servers

To make testing easier we need each branch on a stable port. The convention is:

- main: http://localhost:5190
- todos1: http://localhost:5191
- todos2: http://localhost:5192

Don't let other branches run on these ports, only run on this ports (strict).

This is enforced, not just documented: `scripts/dev-port.mjs` resolves the
port for the current git branch (falling back to a stable hash-derived port
for any branch not listed above), and both `packages/renderer/vite.config.ts`
(`strictPort: true`) and the root `playwright.config.ts` use it — so `npm run
dev:renderer` and `npm run test:e2e` always agree on one port per branch and
never silently drift onto a neighboring branch's port. Override for a one-off
with `RENDERER_PORT=<n>`.

The **e2e backing Hono server** gets a per-branch port the same way, from
`resolveServerPort()` in that file: the renderer port **+ 1000** (main 6190,
todos1 6191, todos2 6192). `playwright.config.ts` starts the server on it and
`test/e2e/server-url.ts` hands the matching URL to the specs, so two worktrees can
run `npm run test:e2e` simultaneously — with a single shared port, the first
server to start locked the others out of the auto-sync / backend-proxy /
plugins-registry specs, because its `CORS_ORIGINS` only named its own
renderer origin. Override with `EASYDB_SERVER_PORT=<n>`.

## Pull request descriptions

Every PR description **starts with a live preview link** on the first line, e.g.:

```
**🔎 Live preview:** https://cawoodm.github.io/easydbaccess3/
```

Publish the branch's preview first (`npm run publish -- -Target easydbaccess<N>`,
which builds with `--base /easydbaccess<N>/` and deploys the folder to the
`cawoodm/cawoodm.github.io` Pages repo), then put that URL at the very top of the
PR body — above the summary — so reviewers can try the build before reading the
diff. Keep it there when updating an existing PR description.
