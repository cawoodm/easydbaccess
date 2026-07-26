# Local Storage

How easyDBAccess persists data on one device. For moving a workspace
*between* devices, see [`SYNCH.md`](./SYNCH.md); for the plugin surface that
sits on top of this layer, see [`PLUGINS.md`](./PLUGINS.md).

## At a glance

Everything lives in one browser-native IndexedDB database, accessed through
[Dexie](https://dexie.org/), a thin wrapper that adds `liveQuery` reactivity
and explicit versioned schema migrations on top of the raw IndexedDB API.
There is no server-side database today — a device with no network access
still has a fully working, persistent app. `packages/server`'s `/sync` route
stores workspace *snapshots* (JSON blobs), not a live copy of this data; see
`SYNCH.md`.

```
Plugin
  │  (never touches Dexie directly)
  ▼
DataStore  ──  packages/shared/src/plugin-api.ts (the contract)
  │  createDataStore()
  ▼
data-store-dexie.ts  ──  wraps each Dexie table in DataCollection<T>
  │
  ▼
dexie-db.ts  ──  getDexie() — one Dexie() instance, one IndexedDB database "easydb"
  │
  ▼
IndexedDB (browser) — persists across reloads, scoped to the origin
```

Electron today reuses this exact path (the renderer is the same bundle
running inside Electron's renderer process, IndexedDB and all). Phase 8 of
the [rewrite plan](../.claude/plans/2026-05-21-rewrite-architecture.md) will
swap Electron's storage to an IPC bridge into a main-process
`better-sqlite3` file — the point of the `DataStore` abstraction below is
that this swap touches nothing above it.

## Why Dexie, not a bigger database engine

The storage layer is hidden behind `DataStore`, so the choice of engine is an
implementation detail plugins never see. Dexie was picked over something
like RxDB because the app doesn't need schema validation or a built-in
replication protocol — sync is a separate, app-owned HTTP concern (see
`SYNCH.md`) — and a thin, predictable IndexedDB wrapper with explicit
migrations is easier to reason about than a heavier reactive-database layer
bringing along conventions of its own.

## The Dexie schema

Declared once in
[`packages/renderer/src/db/dexie-db.ts`](../packages/renderer/src/db/dexie-db.ts),
one IndexedDB database named `easydb`:

| Dexie table | Schema string | Primary key | Indexed fields |
|---|---|---|---|
| `workspaces` | `id` | `id` | — |
| `tables` | `id, workspaceId, updatedAt` | `id` | `workspaceId`, `updatedAt` |
| `rows` | `id, tableId, updatedAt` | `id` | `tableId`, `updatedAt` |
| `settings` | `key` | `key` | — |
| `plugins` | `url` | `url` | — |
| `viewTemplates` | `id, workspaceId` | `id` | `workspaceId` |
| `viewInstances` | `id, workspaceId, tableId` | `id` | `workspaceId`, `tableId` |

Dexie's schema string syntax: the first column is the primary key, the rest
are secondary indexes. Non-indexed fields on a record (e.g. `Table.columns`,
`Row.data`) live in the record's serialized value and don't need a schema
entry — only fields you plan to `.where(...)` on do.

**Schema versioning:** `raw.version(1).stores({...})` / `raw.version(2)
.stores({...})` — Dexie carries earlier versions' stores forward
automatically, so a later `version()` block only needs to declare *new or
changed* stores (the `viewTemplates`/`viewInstances` v2 bump adds two stores
without touching v1's). Adding or removing an **indexed** field bumps the
version; adding a plain JSON field on an existing record does not. A schema
change that needs existing rows rewritten (not just re-indexed) uses an
`.upgrade(tx => ...)` callback inside the relevant `version()` block — none
exists yet because nothing has needed one so far.

**Multi-tab upgrade safety:** an IndexedDB version bump can only run inside a
`versionchange` transaction, which blocks while any other tab still holds the
database open at the old version. `dexie-db.ts` handles both sides of that:
a tab notified of `versionchange` closes its own connection (and reloads if
another tab is genuinely upgrading the schema, so it comes back running the
new code rather than a dead handle); a tab whose own upgrade is `blocked` by
a stale tab shows a full-screen "close your other tabs" message instead of
hanging silently.

## The one `rows` table, many logical tables

There is **no per-user-table Dexie table**. Every row of every table the user
creates lives in the single `rows` Dexie table, disambiguated by the
`tableId` index. `DataStore.rows(tableId)` — the only way plugins ever touch
rows — returns a *view* over that one table, not a separate collection:

- Reads are `rows.where('tableId').equals(tableId)`.
- Writes (`insert`/`bulkInsert`/`upsert`) auto-stamp `tableId` onto the
  document before writing, so a plugin can never accidentally write a row
  into the wrong logical table.
- `subscribe()` runs a `liveQuery` scoped to that same `where` clause.

This is why adding a user-facing "table" never touches the Dexie schema —
only a `Table` record (in the `tables` store) is created; its rows are just
more documents in the shared `rows` store carrying that table's `id`.

## `DataStore` — what plugins actually see

[`data-store-dexie.ts`](../packages/renderer/src/db/data-store-dexie.ts)
wraps every Dexie table in the minimal `DataCollection<T>` shape from
[`plugin-api.ts`](../packages/shared/src/plugin-api.ts):
`find`/`findOne`/`insert`/`bulkInsert`/`upsert`/`patch`/`remove`/
`bulkRemove`/`subscribe` (+ optional `refresh`). Plugins receive this
wrapper, never raw Dexie — the storage engine can change without a plugin
noticing, and a third-party URL-loaded plugin can't reach into IndexedDB
directly even if it wanted to.

`subscribe()` is backed by Dexie's `liveQuery`, which **re-runs the whole
query closure on any write to the underlying table** — there's no
fine-grained diffing. This is intentionally coarse: every chrome component
that subscribes (the table list, a data-table's row set, footer state)
consumes the full result set on every change anyway, so the extra
re-evaluation cost is harmless and the implementation stays simple.

## Row-source routing — when a "table" isn't local at all

A `Table` may carry an optional `source: TableSource` descriptor
(`{ type, config, writable?, serverQuery? }`). When present,
`createRoutedDataStore` (a decorator `app-context.ts` wraps around the plain
Dexie-backed store) hands `rows(tableId)` to whatever
`RowCollectionProvider` a plugin registered for that `type` via
`api.registerRowSource(...)` — e.g. the `datasette-source` plugin's live,
read-write Datasette connector — instead of the local `rows` Dexie table.

This routing is a **strict no-op for every ordinary table**: no `source`, an
unregistered `source.type`, or a table not yet primed into the routing
seam's synchronous cache all fall straight through to the plain local
collection, byte-for-byte identical to a table with no seam involved at all.
A snapshot *import* from Datasette (via the `import-data` plugin) is a
different, unrelated path — it copies rows once into the local `rows` table
with `origin` (not `source`) recorded, so it's an ordinary local table
afterward.

## Non-row collections

- **`workspaces`** — one record per workspace (`id`, `name`, `createdAt`,
  `pluginUrls: string[]`). `pluginUrls` is what makes an installed
  third-party plugin follow the workspace across devices via sync.
- **`tables`** — one record per user-facing table: name, `columns`
  (`ColumnSpec[]` — field/label/type/renderer/width/etc.), sort/filter
  state, `windowGeometry`, and the optional `source`/`origin`/`info`
  descriptors above.
- **`settings`** — a flat `key → value` bag for plugin and app
  configuration. No namespacing enforced beyond convention (plugins key
  their own settings, e.g. `gist:<workspaceId>`, `server-sync:url`,
  `server-sync:etag:<workspaceId>`) — **anything stored here is plaintext**;
  there is no encryption layer, so credentials like the `gist-sync` GitHub
  token sit in IndexedDB exactly as entered (see `PLUGINS.md`'s Sync
  section).
- **`plugins`** — one record per installed third-party plugin URL, keyed by
  the URL itself: `enabled`, `lastFetched`, `cachedBody` (the fetched module
  source, so boot never blocks on a network fetch — see below), and
  `lastError`. Disabled state for an *optional built-in* is also stored here
  under the synthetic key `builtin:<name>`, reusing the same collection
  rather than adding a new one.
- **`viewTemplates`** / **`viewInstances`** — the View system's
  workspace-global HTML templates and their per-table bindings (see
  `PLUGINS.md`'s Views section).

## Boot sequence and workspace resolution

`app-context.ts`'s `init()` runs once per page load (memoized behind
`getContext()`):

1. Open the Dexie database, wrap it in `DataStore`, wrap *that* in the
   row-source-routing decorator.
2. Resolve which workspace to open, in priority order: a `?space=NAME` URL
   param (creating that workspace if it doesn't exist yet) → the
   last-active workspace, remembered in **`localStorage`** under
   `eda:lastWorkspaceId` (the one piece of local persistence outside
   IndexedDB) → the first existing workspace → a freshly-created `default`
   workspace.
3. Build the `HostApi`, then `init()` every built-in plugin synchronously,
   followed by every URL-loaded plugin.
4. On a `queueMicrotask`, emit `app:ready` and run every plugin's `load()`.

Third-party plugins persist their fetched module body to `plugins.cachedBody`
on first install. Every later boot loads from that cache instantly and kicks
off a non-blocking background re-fetch to refresh it for next time — so the
app boots without a network round trip, and stays working even if the
plugin's original URL later goes offline.

## Practical implications

- **Per-origin, per-browser.** IndexedDB data is scoped to the browser
  profile + origin. Opening the app in a different browser, a private
  window, or after clearing site data starts from an empty database — this
  is exactly what `SYNCH.md`'s server sync and the `gist-sync` plugin exist
  to bridge.
- **No built-in encryption or backup.** Everything above — table data,
  plugin settings, cached plugin source, sync tokens — is plain IndexedDB,
  inspectable and editable via DevTools → Application → IndexedDB. Losing
  the browser's storage (profile deletion, private-mode exit, "clear
  browsing data") loses everything not separately synced or exported.
- **Adding a new persisted field to an existing type** touches at most one
  place (`packages/shared/src/types.ts`) if the field isn't indexed. Adding
  a **new collection**, or indexing an existing field, touches three places
  in lockstep — the type, the Dexie schema + typed accessor in
  `dexie-db.ts`, and the `DataStore` wrapper in `data-store-dexie.ts` — see
  `packages/shared/CLAUDE.md`.
