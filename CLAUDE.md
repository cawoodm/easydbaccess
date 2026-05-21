# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

easyDBAccess is a greenfield rewrite of [`minniDBMax`](C:\projects\Marc\minniDBMax) —
a local-first, plugin-extensible, multi-table database app that runs both as a
browser app and as an Electron desktop app, with a small loosely-coupled Node
backend for multi-device sync and URL-based data ingestion.

The canonical design lives at [`.claude/plans/2026-05-21-rewrite-architecture.md`](./.claude/plans/2026-05-21-rewrite-architecture.md).
Read it before making structural changes — it is more authoritative than this
file for the *why* behind the architecture. Phase tracking lives in the plan;
phases 1–2 are done, phases 3–10 are ahead.

## Commands

All scripts run from the repo root (`npm` workspaces).

| Command | What it does |
|---|---|
| `npm install` | Install all workspace dependencies. |
| `npm run dev:renderer` | Vite dev server at **`http://localhost:5190`** (port chosen to avoid clashing with the legacy `minniDBMax` on `:5173`). |
| `npm run dev:server` | `tsx watch` for the Hono server (`packages/server/src/standalone.ts`), defaults to port 3000. |
| `npm run dev:electron` | Electron shell (placeholder script — wiring lands in Phase 8). |
| `npm run build` | Build every workspace that defines a `build` script. |
| `npm run typecheck` | `tsc -b` across all project references. Run this before claiming work is done. |
| `npm run test` | Vitest unit suites (per package). |
| `npm run format` | Prettier across `packages/`. |

The `dev` script chains renderer + server with `&`; on Windows prefer running
`dev:renderer` and `dev:server` in separate terminals.

## Architecture in one paragraph

Three logical pieces:

1. **`packages/renderer`** — Lit web components for the chrome. Identical code
   runs in the browser (Vite-served) and inside the Electron renderer. Talks
   to RxDB locally; sync goes over HTTP to the server.
2. **`packages/server`** — A Hono app exposed by `createServer({ storage, fetchFn })`.
   The *same* exported app runs inside Electron's main process **and** as a
   remote peer (`packages/server/src/standalone.ts`). Routes: `/replicate/:collection/{pull,push}`,
   `/fetch` (URL proxy with allowlist + size cap), `/plugins/registry`.
3. **`packages/electron`** — Thin shell that boots the Hono server in-process
   plus a `BrowserWindow` loading the renderer. IPC bridge in `preload.ts`
   will expose an RxDB-IPC storage adapter so the renderer can talk to
   main-process RxDB-SQLite (Phase 8).

`packages/shared` holds the contracts every layer agrees on: TS `types.ts`,
RxDB JSON `schemas.ts`, and — most importantly — `plugin-api.ts`, which
defines the `HostApi` every plugin receives.

## The plugin model (load-bearing)

`packages/shared/src/plugin-api.ts` **is the single source of truth** for what
plugins can do. Everything else is downstream. Read this file before changing
the renderer's `plugin-host/`, the `DataStore` adapter, or the event bus.

- A plugin is a single ES module `.js` file loaded by URL. The host caches the
  body in localStorage, dynamic-`import()`s it, then calls `plugin.init(api)`
  and later `plugin.load(api)`.
- The `api` object exposes `store` (data layer), `events` (typed bus), `ui`
  (slot registries for buttons/renderers/importers/exporters/drop-handlers/url-sources),
  `windows`, `backend.fetch`.
- Plugins **may monkey-patch `api.*` methods** to override defaults — this is
  contractual, not a bug. The host does not police it.
- **Built-in features ARE plugins** (CSV import, default table view, etc.).
  This dogfoods the API and prevents the contract from rotting. Don't add a
  feature to the core if it can be a plugin.

## The DataStore abstraction (don't bypass it)

The renderer initializes RxDB directly (`db/rx-db.ts`), but **plugins must not
see RxDB**. `db/data-store.ts` wraps every RxCollection in the minimal
`DataCollection<T>` shape from `plugin-api.ts`. When adding new collections,
add them to **both** files in lockstep:

1. Schema → `packages/shared/src/schemas.ts`
2. Type → `packages/shared/src/types.ts`
3. RxDB registration → `packages/renderer/src/db/rx-db.ts`
4. Plugin-facing wrapper → `packages/renderer/src/db/data-store.ts`

`store.rows(tableId)` returns a *view* (not a separate RxDB collection) that
auto-injects `tableId` into inserts and queries. There is one underlying
`rows` collection.

## Cross-cutting gotchas

These have already bitten this codebase. Don't re-litigate them.

- **Lit + `useDefineForClassFields`:** Lit's `@property`/`@state` decorators
  clash with native class fields. The renderer's `tsconfig.json` sets
  `useDefineForClassFields: false` and `experimentalDecorators: true`. Do
  **not** change this without rewriting all Lit components to use the
  `declare` keyword. The shared/server/electron packages keep TS defaults.
- **RxDB numeric indexes:** Any field of `type: 'number'` listed in `indexes`
  must declare `multipleOf`, `minimum`, and `maximum`. The `updatedAt` field
  uses `{ multipleOf: 1, minimum: 0, maximum: 9999999999999 }`. Apply the
  same pattern to any new indexed numeric field.
- **Lit override modifiers:** `tsconfig.base.json` sets `noImplicitOverride`.
  `connectedCallback`, `disconnectedCallback`, `updated`, `render`, and
  `static styles` all need `override` (or `static override`).
- **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`:** Optional
  properties whose values can be `undefined` need an explicit `| undefined`
  in the type. Array indexing returns `T | undefined`. Don't paper over with
  `!` — handle the case.
- **No barrel-imports of RxDB into plugin code paths.** If you find yourself
  importing from `rxdb` outside of `packages/renderer/src/db/`, that's a
  smell — the storage layer is supposed to be swappable.

## What's intentionally not here yet

The skeleton has placeholders for things that arrive in later phases. Don't
"fix" them without a plan:

- `packages/server/src/routes/replicate.ts` returns `501` — real RxDB
  replication endpoints come in Phase 6/7.
- `packages/electron/src/main.ts` doesn't yet boot Hono or wire the IPC
  storage adapter — Phase 8.
- The renderer's `plugin-host/` directory is empty — Phase 3.
- jsPanel-style draggable windows aren't built yet (`window-mgr/`) — Phase 5.

When adding to any of these, check the matching plan section first.
