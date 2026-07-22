# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

easyDBAccess is a greenfield rewrite of [`minniDBMax`](C:\projects\Marc\minniDBMax) —
a local-first, plugin-extensible, multi-table database app that runs both as a
browser app and as an Electron desktop app, with a small loosely-coupled Node
backend for multi-device sync and URL-based data ingestion.

The canonical design lives at [`.claude/plans/2026-05-21-rewrite-architecture.md`](./.claude/plans/2026-05-21-rewrite-architecture.md).
Read it before making structural changes — it is more authoritative than this
file for the *why* behind the architecture. Phases 1–6 are landed (skeleton +
shared types + Dexie + plugin host + built-in plugins + jsPanel windows +
standalone Hono server with `/sync`, `/fetch`, `/plugins/registry`). Phase 7
(live multi-device replication beyond whole-workspace blob push/pull), Phase 8
(Electron-in-process Hono + Dexie-over-IPC + better-sqlite3 storage), Phase 9
(migration from v1 localStorage), and Phase 10 (polish) are ahead.

## Commands

All scripts run from the repo root (`npm` workspaces). Node ≥24 required
(`engines.node`); the server's `process.loadEnvFile` and Electron 33 expect it.

| Command | What it does |
|---|---|
| `npm install` | Install all workspace dependencies. |
| `npm run dev:renderer` | Vite dev server at **`http://localhost:5190`** (port chosen to avoid clashing with the legacy `minniDBMax` on `:5173`). |
| `npm run dev:server` | `tsx watch` for the Hono server (`packages/server/src/standalone.ts`), defaults to port 3000. |
| `npm run dev:electron` | Vite + Electron with live reload (`scripts/dev.cjs` boots renderer first, then launches Electron pointed at it). |
| `npm run build` | Build every workspace that defines a `build` script. |
| `npm run typecheck` | `tsc -b` across all project references. Run this before claiming work is done. |
| `npm run lint` | ESLint over `packages/`. |
| `npm run test` | Vitest unit + integration suites (per package; the server package has e2e-style HTTP tests). |
| `npm run test:e2e` | Playwright suite under `e2e/` (13 specs covering dialogs, table, columns editor, cells, import/export, filters, window manager, auto-sync, sql-export, backend proxy, plugins registry). |
| `npm run test:e2e:ui` | Same, with Playwright's interactive UI. |
| `npm run format` | Prettier across `packages/`. |
| `npm run package:electron` | `package-electron.ps1 -Installer` — builds renderer + electron, runs `electron-builder` for the Windows installer. |
| `npm run publish` | `publish.ps1` — release script. |

The `dev` script chains renderer + server with `&`; on Windows prefer running
`dev:renderer` and `dev:server` in separate terminals.

## Versioning

**Every commit bumps the patch version**, and the version shown in
`packages/renderer/index.html`'s `<title>` is always kept in sync with
`package.json` (the single source of truth). This is automated by
`.githooks/pre-commit`, which runs `scripts/bump-version.mjs` (increments
`package.json` `version`, rewrites the `<title>`, and stages both). Enable the
hook in a fresh clone with `git config core.hooksPath .githooks` (git config is
local, so it must be re-run per clone). If you commit somewhere the hook isn't
active, run it manually first: `node scripts/bump-version.mjs` (or
`--sync-only` to only repair index.html drift without bumping). The publish
scripts read the version from `package.json`.

## Architecture in one paragraph

Three logical pieces:

1. **`packages/renderer`** — Lit web components for the chrome. Identical code
   runs in the browser (Vite-served) and inside the Electron renderer. Talks
   to Dexie/IndexedDB locally; sync goes over HTTP to the server.
2. **`packages/server`** — A Hono app exposed by `createServer({ store, fetchFn, ... })`.
   The *same* exported app is designed to run inside Electron's main process
   **and** as a remote peer (`packages/server/src/standalone.ts`). Routes:
   `/health`, `/sync` (whole-workspace JSON blob push/pull with ETag), `/sync/:workspaceId/stream`
   (SSE), `/fetch` (URL proxy with allowlist + size cap), `/plugins/registry`
   (operator-curated catalog file).
3. **`packages/electron`** — Thin shell that loads the renderer (Vite in dev,
   built `frontend/index.html` in prod). IPC bridge in `preload.ts` will later
   expose a storage adapter so the renderer can talk to a main-process
   better-sqlite3 store (Phase 8 — not yet wired).

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
  is currently: `new-table-button`, `csv-import`, `json-import`, `csv-export`,
  `dump-export`, `sql-export`, `gist-sync`, `server-sync`, `plugin-manager-button`,
  `cell-color`, `cell-image`, `import-data`, `auto-sync`. Don't
  add a feature to the core if it can be a plugin.
- `meta.optional = true` marks a built-in as user-toggleable. The Plugin
  Manager dialog surfaces these; disabled state is stored under the synthetic
  key `builtin:<name>` in the `plugins` collection.

## The DataStore abstraction (don't bypass it)

The renderer opens a Dexie database (`db/dexie-db.ts`) and wraps each Dexie
table in the minimal `DataCollection<T>` shape from `plugin-api.ts`
(`db/data-store-dexie.ts`). The wrapper is the only surface plugins see — the
storage layer remains swappable. When adding new collections, touch **three**
places in lockstep:

1. Type → `packages/shared/src/types.ts`
2. Dexie schema + typed table → `packages/renderer/src/db/dexie-db.ts`
3. Plugin-facing wrapper → `packages/renderer/src/db/data-store-dexie.ts`

`store.rows(tableId)` returns a *view* (not a separate Dexie table) that
auto-injects `tableId` into inserts and queries. There is one underlying
`rows` table indexed on `tableId`.

Subscriptions use Dexie's `liveQuery`, which re-runs the query closure on any
write to the underlying table. Chrome callers consume the full result set
each time, so the coarse granularity is harmless.

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

- **Electron in-process Hono + Dexie-over-IPC + better-sqlite3 storage** — Phase 8.
  `packages/electron/src/main.ts` is still a plain `BrowserWindow` loader;
  the renderer continues to use Dexie/IndexedDB inside Electron.
- **Live multi-device replication beyond the JSON-blob `/sync` route** —
  Phase 7. The current `server-sync` plugin and `/sync/:workspaceId` route
  push/pull the entire workspace as one document with ETag concurrency. SSE
  notifies of remote changes; full row-level replication is not yet wired.
- **Electron native saveFile / openFile** — the `backend.saveFile` plugin
  surface exists, but in Electron it still uses the browser `<a download>`
  fallback. Native `dialog.showSaveDialog` lands with Phase 8.
- **Migration from v1 minniDBMax localStorage** — Phase 9.
