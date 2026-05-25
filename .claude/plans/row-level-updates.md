# Row-level RxDB replication for easyDBAccess

## Context

The architecture plan (`.claude/plans/2026-05-21-rewrite-architecture.md`)
specified RxDB's HTTP replication protocol (per-doc pull/push with
checkpoints) as the multi-device sync mechanism. What landed is the simpler
**whole-workspace blob** path: `GET/PUT /sync/:workspaceId` with ETag
optimistic concurrency, plus SSE notifications (`docs/SYNCH.md`). The blob
path works but every edit eventually rewrites the entire workspace, and
conflict is whole-workspace (two devices editing different tables collide).

This change adds the row-level replication endpoints **alongside** the blob
path — both coexist on the same server, against the same per-workspace
SQLite file, selected per-workspace by a client setting. No existing routes
or storage layouts change.

## Reality checks vs. the draft

- The sqlite-store **is not a blob store** — it materialises `tables` /
  `rows` into real SQL tables (`_easydb_tables`, sanitised per-table). The
  new replication state lives in an **additive** system table inside the
  same per-workspace `.db` file and never touches the existing materialised
  tables.
- `mountSync` is registered with `mountSync(app, deps)` (routes attached
  directly to `app`), not `app.route('/sync', subapp)`. The new mount uses
  the same shape.
- The renderer has **one** `rows` RxCollection (Dexie), not one-per-table —
  `store.rows(tableId)` is a view that injects `tableId`. So one
  `replicateRxCollection` for `rows` is sufficient; per-table wire
  collections (`rows:<id>`) are not needed.
- Today's blob sync replicates **only** the workspace dump (tables + rows).
  `settings` / `plugins` / the `workspaces` collection are managed locally.
  Row replication keeps the same scope: only `tables` and `rows`.

## Shape

```mermaid
flowchart LR
  subgraph Renderer["Renderer (browser / Electron)"]
    rxdb[(RxDB Dexie<br/>workspaces · tables · rows · settings · plugins)]
    repctl[replication-controller.ts<br/>watches sync:mode setting]
    repdb[replication.ts<br/>replicateRxCollection × 2]
    rxdb --- repctl
    repctl -- starts --> repdb
  end

  subgraph Server["Hono server (createServer)"]
    routesync["/sync/* (existing)"]
    routerepl["/replicate/:wsId/:collection<br/>(new) pull · push · stream"]
    adapter[StoreAdapter +<br/>pullRows · pushRows · watchRows]
  end

  subgraph Sqlite["SQLite (one .db per workspace)"]
    legacy[_easydb_meta<br/>_easydb_tables<br/>&lt;materialised user tables&gt;]
    newtbl[_easydb_rows<br/>(collection, docId)<br/>rev · deleted · body · updatedAt]
  end

  repdb -- POST pull/push --> routerepl
  repdb <-- SSE change --> routerepl
  routerepl --> adapter
  adapter --> newtbl
  routesync --> legacy
```

The two server paths share nothing in storage — `_easydb_rows` is read/written
only by the new replicate routes; `_easydb_meta` / `_easydb_tables` only by
the existing sync routes. A workspace can use either; switching is a
client-side setting.

## Wire protocol

Three new endpoints, all under `/replicate/:workspaceId/:collection`:

```
POST /replicate/:workspaceId/:collection/pull
POST /replicate/:workspaceId/:collection/push
GET  /replicate/:workspaceId/:collection/stream
```

`:collection` values used by the renderer: `tables`, `rows`. The server is
agnostic to the value (validated only as `^[a-zA-Z0-9_:-]+$`).

`:workspaceId` validated identically to the existing routes (the same
`[A-Za-z0-9_.-]+` regex enforced by both adapters' `validate(id)` — port
the check into the route handler before touching the store).

### Envelope

```ts
export type RowEnvelope = {
  docId: string;       // value of the primary-key field
  rev: string;         // RxDB _rev
  deleted: boolean;    // RxDB _deleted
  updatedAt: number;   // millis; mirrors the indexed field on the schema
  body: unknown;       // full RxDocument JSON, opaque to server
};
```

### `POST /pull`

Req: `{ checkpoint: { updatedAt: number; docId: string } | null; batchSize: number }`

Res: `{ documents: RowEnvelope[]; checkpoint: { updatedAt: number; docId: string } | null }`

Server scans `_easydb_rows` for the workspace+collection ordered by
`(updatedAt asc, docId asc)`, starting strictly after the checkpoint,
limited by `batchSize`. New checkpoint = last envelope's `{updatedAt, docId}`
(null if no documents).

### `POST /push`

Req: `{ rows: Array<{ assumedMasterState: RowEnvelope | null; newDocumentState: RowEnvelope }> }`

Res: `{ conflicts: RowEnvelope[] }`

Per row, in a single SQLite transaction: read current row by
`(collection, docId)`. If current `rev !== assumedMasterState?.rev` (treat
"no row" as `rev = null`), return current envelope as a conflict and skip.
Otherwise upsert. Empty conflicts ⇒ all clean.

### `GET /stream`

SSE. Mirrors `routes/sync.ts:95-180` line-for-line — same `init` event with
high-water checkpoint, same heartbeat loop, same `onAbort` cleanup, same
`unsupported` fallback when the adapter doesn't implement `watchRows`.
On each successful `push` for `(workspaceId, collection)`, emit
`event: change` with `data: { documents, checkpoint }` so subscribers don't
need a follow-up pull.

## Server changes

### `packages/server/src/storage/types.ts`

Add and export `RowEnvelope`. Extend `StoreAdapter` with three **optional**
methods (so `fs-store` can omit them):

```ts
export type RowCheckpoint = { updatedAt: number; docId: string };

pullRows?(
  workspaceId: string,
  collection: string,
  checkpoint: RowCheckpoint | null,
  batchSize: number,
): Promise<{ documents: RowEnvelope[]; checkpoint: RowCheckpoint | null }>;

pushRows?(
  workspaceId: string,
  collection: string,
  ops: Array<{ assumedMasterState: RowEnvelope | null; newDocumentState: RowEnvelope }>,
): Promise<{ conflicts: RowEnvelope[]; written: RowEnvelope[] }>;

watchRows?(
  workspaceId: string,
  collection: string,
  fn: (envelopes: RowEnvelope[]) => void,
): Unsubscribe;
```

`written` returned by `pushRows` is what `mountReplicate` re-emits over SSE.

### `packages/server/src/storage/sqlite-store.ts`

Extend the `open()` schema bootstrap (the `db.exec(\`CREATE TABLE IF NOT
EXISTS _easydb_meta ... _easydb_tables ...\`)` block at line ~65) with one
more table + index, in the same statement:

```sql
CREATE TABLE IF NOT EXISTS _easydb_rows (
  collection  TEXT NOT NULL,
  docId       TEXT NOT NULL,
  rev         TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  body        TEXT NOT NULL,
  updatedAt   INTEGER NOT NULL,
  PRIMARY KEY (collection, docId)
);
CREATE INDEX IF NOT EXISTS _easydb_rows_pull
  ON _easydb_rows (collection, updatedAt, docId);
```

No `workspaceId` column — the file already partitions by workspace.

Prepare three more statements on `Conn`:

```ts
selectRowsAfter: db.prepare(
  `SELECT docId, rev, deleted, body, updatedAt FROM _easydb_rows
   WHERE collection = ?
     AND (updatedAt > ? OR (updatedAt = ? AND docId > ?))
   ORDER BY updatedAt, docId LIMIT ?`,
);
selectRowOne:    db.prepare(`SELECT docId, rev, deleted, body, updatedAt FROM _easydb_rows WHERE collection = ? AND docId = ?`);
upsertRow:       db.prepare(
  `INSERT INTO _easydb_rows (collection, docId, rev, deleted, body, updatedAt)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(collection, docId) DO UPDATE SET
     rev=excluded.rev, deleted=excluded.deleted, body=excluded.body, updatedAt=excluded.updatedAt`,
);
```

Implement the three new methods on the returned adapter object:

- **`pullRows`**: open-or-skip-if-missing pattern (mirror `openIfExists`).
  Bind `(collection, checkpoint?.updatedAt ?? -1, checkpoint?.updatedAt ?? -1, checkpoint?.docId ?? '', batchSize)`.
  Each result row → envelope (`JSON.parse(body)`). Checkpoint = last row's
  `{updatedAt, docId}` or `null` if empty.
- **`pushRows`**: `db.exec('BEGIN IMMEDIATE')`. Per op, `selectRowOne.get`,
  compare `rev`; on mismatch push current envelope into `conflicts`,
  otherwise `upsertRow.run`. Commit. After commit, `emitter.emit(\`rows:${workspaceId}:${collection}\`, written)`.
  Return `{ conflicts, written }`.
- **`watchRows`**: same event-emitter fan-out used by `watch` (line ~228),
  keyed on `rows:${workspaceId}:${collection}`.

### `packages/server/src/storage/fs-store.ts`

No-op. Leave `pullRows`/`pushRows`/`watchRows` undefined — the route
returns 501 when absent.

### `packages/server/src/routes/replicate.ts` (new)

Shape mirrors `routes/sync.ts`:

```ts
export function mountReplicate(app: Hono, deps: { store: StoreAdapter }) { ... }
```

- Validate `:workspaceId` with the same `/^[A-Za-z0-9_.-]+$/` (factor a tiny
  `isValidWorkspaceId(id)` helper next to `stripEtagQuotes`; export from
  `sync.ts` or duplicate — both fine since the rule is durable).
- Validate `:collection` with `/^[A-Za-z0-9_:-]+$/`.
- For `pull`/`push`: if the corresponding adapter method is undefined,
  return 501 with `{ error: 'row replication requires sqlite backend' }`.
- For `stream`: reuse the entire SSE block from `sync.ts:98-178`, swapping
  the `unsubscribe` source to `store.watchRows(wsId, collection, ...)` and
  the queued payload to `{ documents, checkpoint }` (computed from the
  written envelopes — checkpoint = last envelope's `{updatedAt, docId}`).
- Use the existing `log('replicate', ...)` channel naming convention.

### `packages/server/src/index.ts`

Add one line next to `mountSync(app, { store: deps.store })`:

```ts
mountReplicate(app, { store: deps.store });
```

No `ServerDeps`, CORS, or logger changes.

### `packages/server/CLAUDE.md` & `docs/SYNCH.md`

Append `/replicate/*` to the route table and one paragraph noting:
schema-agnostic envelope, opaque body, sqlite-only, coexists with `/sync`.

### `packages/server/test/replicate.e2e.test.ts` (new)

Mirror `sync.e2e.test.ts`'s fixture (`startServer('sqlite')`). Cover:
push → pull round-trip with checkpoint, conflict on stale `rev`, 501 on
fs adapter, SSE `init` + `change` after push, multi-collection isolation
(pushing `tables` doesn't show up in a `rows` pull).

## Renderer changes

### `packages/renderer/src/db/rx-db.ts`

Register the replication plugin alongside dev-mode + migration:

```ts
const { RxDBReplicationPlugin } = await import('rxdb/plugins/replication');
addRxPlugin(RxDBReplicationPlugin);
```

No schema changes — `_rev`, `_deleted`, `_meta.lwt` are RxDB-internal and
already present on documents the handlers see.

### `packages/renderer/src/db/replication.ts` (new)

Factory `startReplication({ db, baseUrl, workspaceId })` returns a handle
`{ stop(): void }`. Internally creates two `replicateRxCollection` calls:

```ts
import { replicateRxCollection } from 'rxdb/plugins/replication';

const tables = replicateRxCollection({
  collection: db.tables,
  replicationIdentifier: `easydb:${baseUrl}:${workspaceId}:tables`,
  pull: { handler: pullHandler('tables'), batchSize: 100, stream$: pullStream$('tables') },
  push: { handler: pushHandler('tables'), batchSize: 50 },
  live: true,
  retryTime: 5_000,
});

const rows = replicateRxCollection({
  collection: db.rows,
  replicationIdentifier: `easydb:${baseUrl}:${workspaceId}:rows`,
  pull: { handler: pullHandler('rows'), batchSize: 200, stream$: pullStream$('rows') },
  push: { handler: pushHandler('rows'), batchSize: 100, modifier: filterPushToActiveWorkspace },
  live: true,
  retryTime: 5_000,
});
```

Handler details:

- **`pullHandler(collection)`**: POSTs `/replicate/:wsId/:collection/pull`
  with `{ checkpoint, batchSize }`. Returns `{ documents, checkpoint }`
  where `documents` are the *un-wrapped* `envelope.body` values — that's
  what RxDB's pull contract wants.
- **`pushHandler(collection)`**: POSTs `/replicate/:wsId/:collection/push`.
  Wraps each `{assumedMasterState, newDocumentState}` pair into RowEnvelopes
  using `extractEnvelope(doc)` (reads `doc.id`, `doc._rev`, `doc._deleted ?? false`, `doc.updatedAt`,
  body = the doc itself). Unwraps `conflicts` back into RxDB-shaped docs
  before returning.
- **`pullStream$(collection)`**: an `Observable` (use `rxjs/Subject`) driven
  by a single `EventSource` per collection at `/replicate/:wsId/:collection/stream`.
  Emits `{ documents, checkpoint }` from `change` events (unwrap), emits
  `'RESYNC'` on `error` / `unsupported` (RxDB's documented sentinel that
  triggers a checkpointed refetch).
- **`filterPushToActiveWorkspace`** (rows only): RxDB's push `modifier`
  receives each doc on its way out; return `null` for rows whose `tableId`
  is not in the active workspace's tables (membership computed once and
  refreshed via `db.tables.find({selector:{workspaceId}}).$.subscribe`).
  Workspace-A's rows therefore stay local even though `db.rows` is shared.

URL + auth helpers come from `plugins/server-sync-core.ts` (`loadServerUrl`,
matching `/+$/` stripping). `replication.ts` lives outside `plugins/`
because it is core infra, not a plugin — but reads the same setting key
`server-sync:url` for backwards compatibility (so users don't reconfigure).

### `packages/renderer/src/db/replication-controller.ts` (new)

The bridge between settings and the replicator factory. Pseudocode:

```ts
import { startReplication } from './replication.js';

const MODE_KEY = (wsId: string) => `sync:mode:${wsId}`; // 'blob' | 'rows'

export function installReplicationController(deps: { db, events, getWorkspaceId, getServerUrl }) {
  let handle: { stop(): void } | null = null;

  async function refresh() {
    handle?.stop();
    handle = null;
    const wsId = deps.getWorkspaceId();
    const url = await deps.getServerUrl();
    if (!wsId || !url) return;
    const mode = await readMode(wsId);
    if (mode !== 'rows') return;
    handle = startReplication({ db: deps.db, baseUrl: url, workspaceId: wsId });
  }

  deps.events.on('workspace:changed', refresh);
  // also re-evaluate when settings change — subscribe to db.settings for MODE_KEY/URL_KEY changes
  void refresh();
}
```

Wired from `app-context.ts:init()` after `loadBuiltinPlugins(api)` runs.
Per-workspace mode lives in the `settings` collection alongside
`server-sync:url`.

### Coexistence with `server-sync` / `auto-sync` plugins

Both existing plugins keep working unchanged against `/sync/*`. They become
no-ops when `sync:mode:<wsId> === 'rows'`:

- `server-sync.ts` push/pull buttons read the mode and toast "row mode
  active — use settings to switch back to blob sync".
- `auto-sync.ts:tick` short-circuits at the top if `mode === 'rows'`.

Default `mode` is `blob`, preserving current behaviour. The plugin manager
already has UI surface for adding workspace settings — opt-in via a single
checkbox in a settings panel is straightforward; spec'd loosely here, the
exact UI lands as a tiny follow-up.

## Verification

1. **Server unit/e2e** (`packages/server/test/replicate.e2e.test.ts`):
   push → pull round-trip; conflict path; SSE init+change; 501 on fs.
2. **Manual smoke**:
   - `STORAGE_KIND=sqlite STORAGE_PATH=./.easydb-store npm run dev:server`
   - `curl -s -X POST http://localhost:3000/replicate/demo/rows/pull -d '{"checkpoint":null,"batchSize":10}' -H 'Content-Type: application/json'`
     → `{"documents":[],"checkpoint":null}`.
   - push one envelope, pull again → see it; checkpoint equals envelope's
     `{updatedAt, docId}`.
3. **Renderer integration**: in a workspace with `sync:mode = 'rows'`, edit
   a cell in browser A → row appears in browser B within ~1s via the
   SSE-driven pull stream. Disconnect B, edit both sides, reconnect → both
   converge by last-write-wins on `updatedAt`.
4. **New-table propagation**: create a table in A → both `tables` and the
   relevant `rows` flow to B without any per-table replicator setup (one
   `rows` replicator serves all tables; the modifier scopes by membership).
5. **Coexistence**: with `sync:mode = 'blob'` `/replicate/*` is never hit;
   auto-sync continues polling `/sync/*`. Toggle the setting → next
   workspace event boots the replicators, blob plugins go quiet.
6. **fs-store fallback**: with `STORAGE_KIND=fs`, all `/replicate/*` calls
   return 501. The renderer surfaces this once on connect (toast) and stops
   the replicators.
7. `npm run typecheck` clean; `npm run test` green; `npm run test:e2e`
   green (existing auto-sync spec still passes — blob mode default).

## Out of scope

- A `conflict` collection / inspection UI. Resolution is enforced
  (last-write-wins by `updatedAt`); surfacing losers is a separate slice.
- Auth on `/replicate/*` (matches current `/sync/*`: none).
- Tombstone compaction.
- Migrating an existing blob-mode workspace into row-mode (a one-shot
  shred is straightforward but not needed to land the protocol).
- Removing the blob `/sync/*` path. Coexists indefinitely.
- The Electron-in-process Hono + better-sqlite3 storage (Phase 8) — row
  replication is shell-agnostic and will work once Phase 8 lands.
