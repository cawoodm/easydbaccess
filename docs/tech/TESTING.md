# Testing

Two layers, run by two different tools, deliberately kept small in scope
each: [Vitest](https://vitest.dev/) for unit tests of pure logic, and
[Playwright](https://playwright.dev/) for end-to-end tests that drive the
real app in a real Chromium tab. There is no in-between "component test"
layer — Lit component *behavior* is covered by e2e, not by mounting
components in jsdom.

```bash
npm run test         # Vitest — every workspace package with a test script
npm run test:e2e     # Playwright — the e2e/ suite (34 specs)
npm run test:e2e:ui  # same, with Playwright's interactive UI
```

## Unit tests (Vitest) — one package at a time

`npm run test` is `npm run test --workspaces --if-present`: each package
runs its own `vitest run` independently — `packages/renderer`,
`packages/server` and `packages/electron` (`packages/shared` has no test
script; it's pure types, nothing to unit-test).

### `packages/renderer` — pure functions extracted for testability

There's no dedicated `vitest.config.ts` here; it runs on Vitest's defaults.
What makes this workable is a consistent pattern throughout the renderer:
**logic that doesn't strictly need the DOM or Dexie is pulled out into a
standalone, dependency-free module**, specifically so it can be unit-tested
without spinning up a browser. Examples scattered through this codebase:

| Test file | What it isolates |
|---|---|
| `window-mgr/geometry.test.ts` | `sanitizeGeometry()` — corrupt-geometry detection, extracted out of `jspanel-manager.ts` (see `WINDOWS.md`) |
| `window-mgr/panzoom.test.ts` | The pan/zoom transform math (`panBy`, `zoomAround`, `clampScale`) — no DOM, just coordinate arithmetic |
| `window-mgr/panel-title.test.ts` | `countSuffix()` — the `"(12)"` / `"(3/12)"` title formatting |
| `table/column-merge.test.ts` | Column-schema merge logic used by the column editor |
| `search/text-search.test.ts` | `parseSearchQuery`/`searchRows` — the AND/OR/phrase-fallback rules (see `DATA-TABLE.md`) |
| `views/view-render.test.ts` | `$TOKEN` substitution for View templates |
| `plugins/csv-import.test.ts`, `plugins/json-import.test.ts` | CSV/JSON parsing, type inference, dump-shape detection — see `PLUGINS.md` |
| `plugins/datasette-client.test.ts`, `plugins/datasette-collection.test.ts` | Datasette URL parsing, paging, column inference |
| `plugins/read-url.test.ts` | CORS-friendly URL rewriting |
| `db/routed-data-store.test.ts` | The row-source routing seam (see `STORAGE.md`) — verifies it's a strict no-op for tables with no `source` |
| `db/data-store-ipc.test.ts` | The Electron-side `DataStore`: that it satisfies the same `DataCollection<T>` contract over a fake IPC bridge, injects `tableId` on `rows(id)` writes, and re-runs subscriptions on a `store:changed` broadcast |
| `plugins/electron-db.test.ts` | The Open / Import decision tree with a fake `window.easydb.db` bridge — a `foreign` file offers Import instead of opening, an `unreadable` one is reported, and collisions map to Overwrite / Rename / Skip. The OS file dialog can't be scripted, so the flows are exported for exactly this |

None of these import Lit, Dexie, or the panel shell. When you're about to add logic
to a `.ts` file that's mostly DOM glue, ask whether the actual *decision*
(what geometry counts as corrupt, how a search query parses, how a column
merge resolves) can be pulled into a plain function next to it — that's
the difference between something Vitest can check in milliseconds and
something that only e2e can ever exercise.

### `packages/server` — real HTTP, real adapters, no mocks

`packages/server/vitest.config.ts` sets `pool: 'forks'` (SQLite's native
bindings don't play well with Vitest's default worker-thread pool) and
`EASYDB_LOG: 'quiet'` (so the request logger doesn't spam test output). Its
two suites (`test/sync.e2e.test.ts`, `test/plugins.e2e.test.ts`) are
E2E-style despite running under Vitest: each test boots the **real** `Hono`
app via `@hono/node-server` on an ephemeral port (`port: 0`), against a
**real** storage adapter pointed at a fresh `mkdtemp()` directory — both
`fs` and `sqlite` adapters are exercised — and talks to it over actual
`fetch()` calls, including reading a real SSE stream body for the
`/sync/:id/stream` route. Nothing about `createServer`/`StoreAdapter` is
mocked; see `SERVER.md` for what's actually being exercised here.

### `packages/electron` — the real store, real files, no Electron runtime

`packages/electron/vitest.config.ts` sets `pool: 'forks'`, for the same
reason the server's does: these suites open real SQLite databases through
`node:sqlite`. What makes them possible at all is that the store is **pure
Node** — `sqlite-store.ts`, `db-import.ts` and `sql-mapping.ts` never import
`electron`, so vitest exercises them directly with no BrowserWindow, no
`app`, and no display. The pieces that genuinely need Electron (the OS file
dialogs in `db-files.ts`) are the pieces left to manual testing; the decision
logic in front of them is tested from the renderer side instead
(`plugins/electron-db.test.ts` above).

Each test gets a **real temp file** via `mkdtempSync`, deliberately not
`:memory:` — the behaviour under test includes closing a store and reopening
the same file.

| Suite | Tests | What it covers |
|---|---|---|
| `sqlite-store.test.ts` | 42 | The schema is created idempotently and survives close/reopen; a user table becomes a real SQL table whose DDL matches its columns; unsafe names are sanitized; `ColumnSpec[]` round-trips verbatim (`renderer`, `hidden`, `width` and all); an unknown collection throws instead of degrading; name collisions and `_extra` overflow |
| `db-import.test.ts` | 13 | Importing a **foreign** database — `ColumnSpec`s inferred via `columnTypeFromSqlType`, BLOB/NULL/empty/zero values survive, an empty file doesn't crash — plus Overwrite / Rename / Skip against a colliding local table, a re-import of our own file recovering the exact `ColumnSpec`s affinity alone never could, fresh ids on import, and `probeDatabaseFile`'s three verdicts |
| `sql-mapping.test.ts` | 23 | The shared mapping in `@easydb/shared`: `quoteIdent` escaping, `sanitizeTableName`, `sqlAffinity` per `ColumnType`, and `encodeValue`/`decodeValue` round-trips |

That last suite covers `packages/shared/src/sql-mapping.ts`, which the
**server's** `storage/sqlite-store.ts` imports too — so the one convention
that keeps a `.db` written by either side identical has one set of tests.

## End-to-end tests (Playwright) — the real app, driven two ways

`e2e/` holds 34 numbered specs (`01-dialogs` through `34-resume-import`),
covering dialogs, the data table, column editing, cell editing, filters,
the window manager, import/export, auto-sync, SQL export, the backend
`/fetch` proxy, the plugin registry, mobile UI, loading bars, Datasette
import/connect, views, DB schema upgrades, and more — roughly one spec file
per feature area, growing as features are added.

**Isolation.** `playwright.config.ts` runs a single Chromium project,
`workers: 1`, `fullyParallel: false` — deliberately serial, not parallelized
across workers. Two dev servers are booted for the run: the renderer
(`npm run dev:renderer`) and a **throwaway** backend server
(`npm run dev:server`) pointed at `STORAGE_PATH=.playwright-storage` with `fs`
storage and a fixture-backed `PLUGINS_REGISTRY_PATH`, purely so the
sync/auto-sync/plugins-registry specs have a real backend to talk to.

**Neither port is hardcoded.** Both come from `scripts/dev-port.mjs`, keyed on
the current git branch — `resolveDevPort()` for the renderer (main 5190) and
`resolveServerPort()` for the backing server (renderer port + 1000, so main
6190). Specs that need the backend import `SERVER_URL` from
`e2e/server-url.ts`, which calls the same resolver, so the config and the
specs can't disagree. This is what lets two worktrees run `npm run test:e2e`
at the same time: with one shared server port, whichever run started first
owned it, and the other run's auto-sync / backend-proxy / plugins-registry
specs failed on CORS — the running server's `CORS_ORIGINS` named only the
first run's renderer origin. Pin both with `RENDERER_PORT` /
`EASYDB_SERVER_PORT` if you need a specific pair.

**Per-test isolation without wiping the whole database.** The `app` page
fixture (`e2e/fixtures.ts`) gives every test a unique `workspaceId`
(`e2e-<testId>-<nonce>`), and — belt-and-braces — deletes every IndexedDB
database via an injected `__easydbResetIDB()` before the app boots at all.
That combination means tests don't just avoid clobbering each other's data
inside one workspace; each test effectively starts from a blank slate.

**Driving the app two ways.** Every test navigates to
`/?test=1&space=<workspaceId>` — the `?test=1` flag is read once, in
`packages/renderer/src/main.ts`, and (only then) exposes the live
`AppContext` as `window.__easydb`, plus a `window.__autoSyncTick()` escape
hatch so the auto-sync spec can fire one sync cycle on demand instead of
waiting out the real 60-second interval. Tests then choose per-assertion
whether to:

- **drive real UI** — click buttons, type into inputs, drag column headers —
  for anything the test is actually about (the whole point of e2e), or
- **set up or verify state directly** through `e2e/helpers.ts` (`createTable`,
  `bulkAddRows`, `addRow`, `readTable`, `readRows`, `waitForPanel`) which
  calls straight through `window.__easydb.store`, bypassing clicks entirely.

The rule of thumb baked into `helpers.ts`'s own comment: anything that
doesn't *need* to be a click flow — arranging fixture data, or reading back
state for an assertion — should go through a helper, so a test's UI
interactions stay focused on the one behavior it's actually verifying
instead of re-deriving setup state through the UI every time.

One `helpers.ts` gotcha worth knowing: `createTable`'s `TestColumn.renderer`
is **not optional in practice** for an editable-cell test — since v0.0.5 the
app no longer auto-picks a cell renderer for a column, so a column created
with no `renderer` renders as read-only text (see `DATA-TABLE.md`'s cell
rendering section). A test that wants to type into a cell needs to pass
`renderer: 'link'` (plain string editing) or `'date'`/`'datetime'`/
`'boolean'` explicitly.

## Where a new test should go

- **Extracted a pure function out of DOM/store glue?** Add a `.test.ts`
  next to it and run it under Vitest — fast, isolated, no browser.
- **Added a server route or storage adapter behavior?** Add it to
  `packages/server/test/*.e2e.test.ts` — boot the real app, hit it over
  real HTTP, don't mock `StoreAdapter`.
- **Changed the desktop store, `.db` import, or the SQL mapping?** Add it to
  `packages/electron/src/*.test.ts` against a `mkdtempSync` temp file — no
  Electron runtime needed, because none of those modules import `electron`.
  Keep it that way: put anything that needs `dialog`/`app`/`BrowserWindow` in
  `db-files.ts`, and test the decision in front of it from the renderer side.
- **Added or changed user-visible behavior** (a new button, a dialog flow,
  a rendering change)? That's `e2e/`, in whichever numbered spec already
  covers the feature area, or a new one if it doesn't fit an existing file.
  Electron-only UI is the exception — Playwright drives the browser build, so
  cover it with a fake-bridge unit test as `plugins/electron-db.test.ts` does.
