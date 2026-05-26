# @easydb/server

A Hono app exported by `createServer({ store, fetchFn, ... })`. The *same*
exported app runs in two places:

- **Standalone** — `src/standalone.ts` wraps it in `@hono/node-server`. This
  is what `npm run dev:server` (tsx watch) and `npm start` boot.
- **In-process** — Electron's main process will call `createServer(...)` and
  mount it on a localhost port (Phase 8, not wired yet).

## Files

| File | Role |
|---|---|
| `src/index.ts` | `createServer(deps)` factory + `ServerDeps` shape. Mounts routes, configures CORS, logger, `/health`. |
| `src/standalone.ts` | Node entry: `.env` load, env-var parsing, port binding, SIGINT/SIGTERM shutdown. |
| `src/log.ts` | One-liner request/response logger. `EASYDB_LOG=quiet` silences it. |
| `src/routes/sync.ts` | Whole-workspace JSON push/pull + SSE stream. |
| `src/routes/fetch.ts` | Outbound URL proxy with allowlist + byte cap. |
| `src/routes/plugins.ts` | `/plugins/registry` — serves the JSON file at `PLUGINS_REGISTRY_PATH` (if set). Re-read per request so operators can edit without restart. |
| `src/storage/types.ts` | `StoreAdapter` — the only interface backends implement. |
| `src/storage/fs-store.ts` | One JSON file per workspace. Default. |
| `src/storage/sqlite-store.ts` | One SQLite DB per workspace, single-row blob table. |
| `src/storage/factory.ts` | `createStoreFromEnv` — switch via `STORAGE_KIND`. |

## The data model

**The server stores one JSON document per workspace.** It does not inspect
the shape, does not parse rows, does not index columns. The client decides
the document structure (the renderer's Dexie tables serialized into a
`{ tables: [...] }` wrapper — see `dump-export.ts`) and the merge semantics.
The server only enforces ETag-based optimistic concurrency.

This is deliberate — it means adding a new backend (Postgres, S3, etc.) is a
single `StoreAdapter` implementation, ~80 lines.

## Routes

```
GET  /health                        → { ok: true, version: '<n>S' }
GET  /sync                          → list workspace IDs (if adapter supports it)
GET  /sync/:workspaceId             → pull blob, returns ETag header
PUT  /sync/:workspaceId             → push blob, If-Match enforces concurrency (412 on conflict)
GET  /sync/:workspaceId/stream      → SSE: { event: change, data: {etag} }
POST /fetch                         → { url, method?, headers?, body? } proxy
GET  /plugins/registry              → operator-curated catalog (file-backed, see below)
```

ETag values are unquoted internally and quoted on the wire (`"abc123"`).
`stripEtagQuotes` in `sync.ts` handles inbound parsing — match that convention
if you add ETag-aware routes.

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `STORAGE_KIND` | `fs` or `sqlite` | `fs` |
| `STORAGE_PATH` | Directory holding workspace files. **Required.** | — |
| `CORS_ORIGINS` | `*`, comma list, or unset (= `*`) | `*` |
| `FETCH_ALLOWLIST` | Comma list of host suffixes for `/fetch` | unset (allow all) |
| `FETCH_MAX_BYTES` | Cap on `/fetch` response bodies | `5_000_000` |
| `PLUGINS_REGISTRY_PATH` | Path to a JSON file `{ plugins: [...] }` served by `/plugins/registry`. Same shape as `packages/renderer/public/plugins/catalog.json`. | unset → empty list |
| `EASYDB_LOG` | `quiet` to silence logger | unset |

`.env` is loaded from the package root via `process.loadEnvFile` (Node ≥20.12,
no dotenv dependency).

## SSE stream gotcha

`mountSync` falls back gracefully when the adapter doesn't implement
`watch()`: sends a single `unsupported` event and closes so the client polls
instead. If you add a new adapter, implementing `watch()` is optional — but
without it, clients won't get live cross-tab updates.

## Build / run

```bash
npm run dev:server      # tsx watch — picks up changes on save
npm run build           # tsc -b → dist/
npm start --workspace @easydb/server   # node dist/standalone.js
```

## Plugin registry — file lookup behaviour

`/plugins/registry` is a thin file-reader, not a database:

- `PLUGINS_REGISTRY_PATH` unset → `{ plugins: [], note: '...' }` (200).
- File missing at the configured path → empty list + note (200, not 500 —
  the renderer treats this as "nothing curated yet").
- File present but invalid JSON / missing `plugins` array → 500 with the
  parse error, so operators notice the misconfiguration.

The renderer's Plugin Manager dialog still falls back to the static
`packages/renderer/public/plugins/catalog.json` for the "Available from this
host" section. The server route is for operator-curated lists served from a
deployment.
