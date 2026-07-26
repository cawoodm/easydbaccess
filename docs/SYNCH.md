# Sync Strategy

How easyDBAccess synchronises a workspace between a browser/Electron client
and the Hono backend.

## TL;DR

- The backend stores **one JSON document per workspace**, opaque to the
  server. Etag-based optimistic concurrency is the only guarantee.
- The client serialises the whole workspace (the `dump-export` shape) and
  PUTs it. Pull GETs that JSON back and rebuilds local state from scratch.
- All sync is **manual** today — the `server-sync` plugin exposes a single
  footer "Sync" menu button (Push / Pull, via the shared `AnchoredMenu` —
  see `DIALOGS.md`). No background poller (see `auto-sync` in `PLUGINS.md`
  for the opt-in exception), no automatic merge, no per-row replication.
  Simpler than a full replication protocol; smaller surface to maintain
  while we figure out what we actually need.

## Roles

```
┌─────────────────────────────────┐         ┌──────────────────────────────┐
│ Renderer (browser / Electron)   │         │ Hono server                  │
│                                 │  PUT    │                              │
│ Dexie                           │ ──────► │ /sync/:workspaceId           │
│   tables, rows, settings        │         │   (JSON body, If-Match etag) │
│                                 │  GET    │                              │
│ serializeWorkspace() (plugin)   │ ◄────── │ /sync/:workspaceId           │
│ parsedToTables()      (plugin)  │  SSE    │ /sync/:workspaceId/stream    │
│                                 │ ◄────── │   (init + change events)     │
│ server-sync plugin              │         │                              │
│   "Sync" menu → Push / Pull     │         │ StoreAdapter (fs / sqlite)   │
└─────────────────────────────────┘         └──────────────────────────────┘
```

## The data on the wire

The body is JSON. The shape is whatever `serializeWorkspace`
(`packages/renderer/src/plugins/dump-export.ts`) produces today:

```json
{
  "workspaceId": "ws-alpha",
  "exportedAt": 1716487200000,
  "tables": [
    { "name": "People", "columns": [...], "rows": [...] },
    ...
  ]
}
```

The server stores this verbatim. It never parses the contents beyond
"is this valid JSON?" — so if the client format evolves, no server change
is required.

## Concurrency model: etag + If-Match

```
client                                   server
┌──────┐                                ┌──────────┐
│ PUT  │ ───── If-Match: "abc" ─────►   │          │
│      │ ◄─── 200 ETag: "def"           │ stored   │
└──────┘                                └──────────┘

┌──────┐                                ┌──────────┐
│ PUT  │ ───── If-Match: "stale" ──►    │          │
│      │ ◄─── 412 { currentEtag } ──    │ unchanged │
└──────┘                                └──────────┘
```

- The server computes `sha1(canonical body bytes)` and returns it as `ETag`.
- The client remembers the etag in Dexie `settings`:
  `server-sync:etag:<workspaceId>`.
- On the next push, the client sends `If-Match: "<last-known-etag>"`. The
  server only writes if the current etag matches.
- On mismatch, the server returns `412 Precondition Failed` and the body
  `{ "conflict": true, "currentEtag": "…" }`. The store is untouched.
- A PUT **without** `If-Match` is an unconditional overwrite — the
  client's "force push" path uses this after the user confirms.
- `PUT` with no prior etag (first push of a workspace) is also
  unconditional and creates the document.

The server side is intentionally dumb: no schemas, no merge, no row-level
revisions. All conflict resolution lives in the client.

## Trigger model

Only manual today.

| Action | Client side | Server side |
|---|---|---|
| User picks **Push** from the Sync menu | Serialise workspace, PUT with If-Match | Validate JSON, etag-check, store, emit SSE `change` |
| User picks **Pull** from the Sync menu | GET, parse, replace local workspace | Read from store, return body + ETag |

No auto-push on edit. No periodic poll. No SSE subscription from the
renderer yet (the server's `/sync/:workspaceId/stream` endpoint is built
and tested, but no client connects to it).

## Push flow (client)

1. Resolve server URL from `settings[server-sync:url]`. If missing, prompt
   the user once and store the answer.
2. Resolve the current workspace ID via `api.workspaceId()`.
3. Serialise the workspace with `serializeWorkspace(api)`.
4. Read last known etag from `settings[server-sync:etag:<wsId>]`.
5. `PUT /sync/<wsId>` with `Content-Type: application/json` and, if an
   etag is known, `If-Match: "<etag>"`.
6. On `200 OK`: read the new `ETag` header and save it under
   `server-sync:etag:<wsId>`. Show success toast.
7. On `412`: prompt the user: "force overwrite?" — if confirmed, retry
   without `If-Match`. If declined, store the server's `currentEtag` so
   the next push starts from the right baseline, and surface a warning
   toast suggesting Pull first.
8. On any other non-2xx: surface as a toast.

## Pull flow (client)

1. Resolve server URL + workspace ID (as above).
2. Confirm with the user — pull replaces local data.
3. `GET /sync/<wsId>`.
4. On `404`: tell the user "workspace doesn't exist on the server yet".
5. On `200 OK`: parse the JSON via `parsedToTables` (the same parser used
   for JSON file imports). For each parsed table:
   - Wipe all existing tables and their rows in the local workspace.
   - Insert the new tables/rows with fresh IDs.
6. Save the response `ETag` to `settings[server-sync:etag:<wsId>]`.

This is the simplest correct behaviour. It's not a merge — it's a
replace. The next iteration of this strategy is where merge logic might
live (see "Open questions" below).

## Conflict cases

| Situation | Today's behaviour |
|---|---|
| First push of a workspace | No If-Match; server creates document. Etag stored. |
| Push when nobody else changed it | If-Match matches; 200; etag rotated. |
| Push after someone else pushed | 412; user prompted to force-overwrite or pull-then-retry. |
| Pull when local has unsaved edits | User is warned via the confirm dialog. Local wins are lost if they Pull. |
| Pull when local is up to date | No-op result; local rebuilt from server (idempotent). |

## Where the bits live

| Concern | File |
|---|---|
| Server contract | `packages/server/src/routes/sync.ts` |
| Storage interface | `packages/server/src/storage/types.ts` |
| Filesystem adapter | `packages/server/src/storage/fs-store.ts` |
| SQLite adapter (`node:sqlite`) | `packages/server/src/storage/sqlite-store.ts` |
| Adapter selection from env | `packages/server/src/storage/factory.ts` |
| CORS configuration | `packages/server/src/index.ts` |
| Server e2e tests | `packages/server/test/sync.e2e.test.ts` |
| Sync menu (Push/Pull) | `packages/renderer/src/plugins/server-sync.ts` |
| Outgoing serialisation | `packages/renderer/src/plugins/dump-export.ts` (`serializeWorkspace`) |
| Incoming parser | `packages/renderer/src/plugins/json-import.ts` (`parsedToTables`) |

## Configuration

Renderer (stored in Dexie `settings`):

| Key | Value |
|---|---|
| `server-sync:url` | Base URL of the Hono server, e.g. `http://localhost:3000` |
| `server-sync:etag:<workspaceId>` | Last-known server etag for this workspace |

Server (env vars consumed by `standalone.ts`):

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `STORAGE_KIND` | `fs` | `fs` \| `sqlite` |
| `STORAGE_PATH` | *(required)* | Directory holding per-workspace files. FS: `<id>.db.json` (same extension the dump-export plugin uses). SQLite: `<id>.db` (one SQLite database per workspace). |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins for CORS, or `*` for any. Empty disables CORS. |

## Running it end-to-end

In two terminals:

```bash
# Terminal 1
STORAGE_KIND=fs STORAGE_PATH=./.easydb-store npm run dev:server

# Terminal 2
npm run dev:renderer
```

Open `http://localhost:5190`, click the footer **Sync** button → **Push**,
enter `http://localhost:3000` when prompted. Inspect
`./.easydb-store/<workspaceId>.db.json` to see the body the server stored.
Click **Sync** → **Pull** to pull it back.

## Open questions / not done yet

These are deliberately left open until we hit a concrete need.

- **Per-row merge.** Today pull is a full replace; a user editing both
  laptop and desktop will lose one side. The cure is a real merge —
  client-side, comparing `updatedAt` per row. Plausible but not built.
- **Live updates.** The server's SSE stream is implemented and tested.
  No renderer client subscribes yet. Adding "auto-pull on `change` event"
  is a small follow-up.
- **Auto-push on edit.** A debounced push after each Dexie write would
  feel magical but complicates the conflict story. Deferred.
- **Auth.** Every request currently accepts any `workspaceId`. A
  `ServerDeps.authorize?(ctx)` hook can be added without changing route
  shapes.
- **Adapter zoo.** Mongo, Couch, MySQL, S3, git adapters are pattern-
  established but not written. Each is a single file implementing
  `StoreAdapter` plus one `case` in `storage/factory.ts`.
- **Compression.** Workspaces with thousands of rows are heavy as
  uncompressed JSON. `Content-Encoding: gzip` on the wire and a
  gzip-on-disk option in the FS adapter are both small additions.
