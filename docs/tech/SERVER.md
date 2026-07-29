# The Server

`packages/server` is a small [Hono](https://hono.dev/) app whose entire job is
things the browser sandbox can't do on its own: hold a durable copy of a
workspace for multi-device sync, proxy URL fetches past CORS, and serve an
operator-curated plugin catalog. It does **not** know what a "table" or a
"row" is — see [`STORAGE.md`](./STORAGE.md) for where the real data model
lives (client-side Dexie) and [`SYNCH.md`](./SYNCH.md) for the push/pull
protocol this server implements. This page covers the server's own shape:
how it's assembled, how it's deployed in two different places, and its two
other routes (`/fetch`, `/plugins/registry`) that `SYNCH.md` doesn't cover.

## One app, two runtimes

`createServer(deps: ServerDeps)` in
[`packages/server/src/index.ts`](../../packages/server/src/index.ts) is the
**only** entry point — everything environment-specific is injected as a
dependency rather than imported directly, so the identical `Hono` app can be
mounted in two places:

- **Standalone** — [`src/standalone.ts`](../../packages/server/src/standalone.ts)
  wraps it with `@hono/node-server` and binds a port. This is what
  `npm run dev:server` and `npm start` boot.
- **In-process (Electron, Phase 8)** — Electron's main process will call
  `createServer(...)` directly and mount it on a localhost port instead of
  spawning a separate Node process, reusing `globalThis.fetch` for the fetch
  proxy instead of going through the network at all. Not wired yet; see the
  [rewrite plan](../../.claude/plans/2026-05-21-rewrite-architecture.md).

```ts
export interface ServerDeps {
  store: StoreAdapter;              // whole-workspace blob store
  fetchFn: typeof fetch;            // outbound fetch (proxied vs. direct)
  fetchAllowlist?: string[];        // /fetch host allowlist
  fetchMaxBytes?: number;           // /fetch response cap
  corsOrigins?: '*' | string[];     // '*' dev default, [] disables CORS entirely
  pluginsRegistryPath?: string;     // file backing /plugins/registry
}
```

Everything the app does — routing, CORS, request logging, `/health` — lives
in `index.ts`; `standalone.ts` only adds the Node-specific glue: loading
`.env` (via `process.loadEnvFile`, no `dotenv` dependency, Node ≥ 20.12),
translating environment variables into a `ServerDeps`, binding the port, and
wiring `SIGINT`/`SIGTERM` to flush the store and close the socket cleanly.

## Routes

```
GET  /health                        → { ok: true, version }
GET  /sync                          → list workspace IDs (adapter-dependent)
GET  /sync/:workspaceId             → pull blob, ETag header
PUT  /sync/:workspaceId             → push blob, If-Match enforces concurrency (412 on conflict)
GET  /sync/:workspaceId/stream      → SSE change notifications
POST /fetch                         → { url, method?, headers?, body? } outbound proxy
GET  /plugins/registry              → operator-curated plugin catalog (file-backed)
```

The `/sync*` family is the sync protocol proper — full request/response
shapes, ETag conventions, and the client-side push/pull/auto-sync logic that
drives it are documented in [`SYNCH.md`](./SYNCH.md). The two routes below
are unrelated to sync and exist to route around browser limitations.

### `POST /fetch` — the CORS escape hatch

A browser tab can't fetch an arbitrary third-party URL if that server
doesn't send permissive CORS headers — which most APIs don't. `/fetch`
proxies the request server-side instead: the renderer's `api.backend.fetch`
posts `{ url, method?, headers?, body? }`, the server issues that request
with `deps.fetchFn` (real `fetch` in standalone mode; in-process Electron
will pass `globalThis.fetch` directly, no network hop at all) and streams
the raw response body back with its original `content-type`.

Two guards protect the host running this proxy:

- **`fetchAllowlist`** (env: `FETCH_ALLOWLIST`, comma-separated host
  suffixes) — when set, only requests whose host equals or ends with
  `.{suffix}` for some allowed suffix are permitted; everything else gets a
  403. Unset means "allow any host," which is the Electron in-process
  default (there's no separate network-facing server to abuse) but is a
  real consideration for a publicly hosted standalone instance.
- **`fetchMaxBytes`** (env: `FETCH_MAX_BYTES`, default 5,000,000) — the full
  response is buffered into memory and checked against this cap *after* the
  fetch completes; an oversized body gets a 413 rather than being streamed
  through unbounded. Every plugin that imports from a URL (`import-data`,
  `datasette-import`) goes through this proxy in browser mode, so this cap
  is the actual ceiling on a single URL import, tighter than any client-side
  buffering limit those plugins add on top.

`url` must match `^https?://` or the request is rejected with 400 before any
fetch is attempted.

### `GET /plugins/registry` — the operator-curated catalog

A second, deployment-controlled source of installable plugins, distinct
from the static `packages/renderer/public/plugins/catalog.json` the Plugin
Manager dialog also reads. Configured via `PLUGINS_REGISTRY_PATH` pointing
at a JSON file shaped `{ plugins: [...] }` (same shape as the static
catalog); the file is **re-read on every request**, so an operator can edit
the curated list without restarting the server.

Behavior is deliberately layered so a missing/unconfigured registry never
looks like a server error to the renderer:

| Condition | Response |
|---|---|
| `PLUGINS_REGISTRY_PATH` unset | `200 { plugins: [], note: '...' }` |
| Path set but file missing (`ENOENT`) | `200 { plugins: [], note: '...' }` |
| File present, valid JSON, has a `plugins` array | `200`, the parsed JSON verbatim |
| File present but invalid JSON, or missing `plugins` | `500 { error: '...' }` — a real misconfiguration, surfaced loudly |

## Storage adapters

The server treats a workspace as one opaque JSON document — it never parses
rows or inspects columns; the client decides the document's shape
(`{ tables: [...] }`, the same shape `dump-export` produces — see
`STORAGE.md`) and all merge semantics. The server's only job is storing that
blob and enforcing ETag-based optimistic concurrency on writes. That
narrow interface is `StoreAdapter`
([`storage/types.ts`](../../packages/server/src/storage/types.ts)):

```ts
interface StoreAdapter {
  read(workspaceId): Promise<{ body: Json | null; etag: string | null }>;
  write(workspaceId, body, { ifMatchEtag }): Promise<WriteResult>; // conflict-checked
  watch?(workspaceId, fn): Unsubscribe;   // optional — powers the SSE route
  list?(): Promise<string[]>;             // optional — powers GET /sync
  close?(): Promise<void>;
}
```

Selected via `STORAGE_KIND` (`fs` default, or `sqlite`), both pointed at the
same `STORAGE_PATH` directory:

- **`fs`** ([`storage/fs-store.ts`](../../packages/server/src/storage/fs-store.ts))
  — one file per workspace, `${id}.db.json`, written atomically (temp file +
  rename) so a crash mid-write can never leave a corrupt/partial document.
  The ETag is `sha1` of the serialized JSON. Deliberately the same
  `.db.json` extension `dump-export` uses client-side — a file dropped into
  the storage directory by hand is a valid workspace, and a pulled workspace
  is a valid dump. `watch()` uses `fs.watch` with a 50ms per-workspace
  debounce (a single logical write can fire multiple raw fs events).
- **`sqlite`** ([`storage/sqlite-store.ts`](../../packages/server/src/storage/sqlite-store.ts))
  — one **real SQLite file** per workspace (`${id}.db`, via Node's built-in
  `node:sqlite`, loaded through `createRequire` so Vite/Vitest's bundler
  doesn't need to recognize it as a builtin), with the JSON blob
  *materialized* into actual SQL tables rather than stored as one big
  column: one SQL table per workspace table, column types mapped to SQLite
  affinities (`number`→`REAL`, `boolean`→`INTEGER`, everything else→`TEXT`),
  plus two system tables (`_easydb_meta` for the single etag/timestamp row,
  `_easydb_tables` recording each table's original name/column spec so a
  pull can reconstruct the exact JSON shape). Push is **clobber, not
  merge** — every write drops and rebuilds all of that workspace's SQL
  tables inside one transaction (`BEGIN IMMEDIATE` ⇒ commit or rollback),
  so a partial/interrupted push can't leave half-old, half-new tables. This
  adapter is strict about the body shape (rejects anything that isn't
  `{ tables: [{ name, columns, rows }] }`, and rejects table names starting
  with `_easydb_` to keep the system tables unambiguous) precisely because
  it has to interpret the JSON to build SQL, unlike the `fs` adapter which
  never looks inside the blob at all.

Adding a third backend (Postgres, S3, …) means implementing this one
interface — `createStore(kind, path)` in
[`storage/factory.ts`](../../packages/server/src/storage/factory.ts) is a
one-`case` switch.

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `PORT` | Standalone listen port | `3000` |
| `STORAGE_KIND` | `fs` or `sqlite` | `fs` |
| `STORAGE_PATH` | Directory holding workspace files. **Required.** | — |
| `CORS_ORIGINS` | `*`, a comma list, or unset (→ `*`) | `*` |
| `FETCH_ALLOWLIST` | Comma list of host suffixes `/fetch` may reach | unset (allow all) |
| `FETCH_MAX_BYTES` | Byte cap on a single `/fetch` response | `5,000,000` |
| `PLUGINS_REGISTRY_PATH` | Path to the `{ plugins: [...] }` catalog file | unset → empty list |
| `EASYDB_LOG` | Set to `quiet` to silence the request logger | unset |

## Request logging

Every request logs one line in (`<-- GET /path`) and one line out
(`--> GET /path 200 5ms`) through `src/log.ts`, unless `EASYDB_LOG=quiet` —
set that in test runs so Vitest/Playwright output isn't drowned in HTTP
noise.

## Build / run

```bash
npm run dev:server                       # tsx watch — reloads on save
npm run build --workspace @easydb/server # tsc -b → dist/
npm start --workspace @easydb/server     # node dist/standalone.js
```
