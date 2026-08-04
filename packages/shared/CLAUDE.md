# @easydb/shared

The contracts every layer agrees on. Types, the plugin API, and the small
amount of pure logic that has to mean the SAME thing on every side of a wire.
No I/O, no DOM, no Node APIs — anything imported here must work in browser,
Node, and Electron main equally.

That last rule is why the filter language lives here. `column-filter.ts` used
to sit in the renderer, but the Electron main process has to narrow rows in SQL
using exactly the reading the renderer applies in memory, and a second
implementation would drift. Pure, deterministic, no-dependency logic of that
kind belongs here; anything else does not.

## Files

| File                   | What's in it                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`         | TS interfaces: `Workspace`, `Table`, `Row`, `ColumnSpec`, `ColumnType`, `WindowGeometry`, `Setting`, `PluginRecord`.                                                                                 |
| `src/plugin-api.ts`    | The `HostApi`, `PluginModule`, `DataCollection<T>`, `DataStore`, `EventBus`, `Dialogs`, `WindowManager`, `Backend`, registry specs, `AppEvents`. **Single source of truth for the plugin contract.** |
| `src/row-query.ts`     | `RowQuery` / `RowPage` — "these fields, this filter, this sort, this slice". The contract that lets a reader stop fetching whole tables, over IPC or HTTP.                                           |
| `src/column-filter.ts` | The filter LANGUAGE: parses an expression into `FilterToken[]` and matches it in memory. **The specification** every backend must agree with.                                                        |
| `src/array-cell.ts`    | How an `array` cell's members are read out of its three spellings (comma list, JSON-array text, real array). Here because `column-filter.ts` needs it — a filter token matches any one member.       |
| `src/filter-sql.ts`    | The same tokens as a SQL `WHERE` fragment. Cross-tested against the matcher.                                                                                                                         |
| `src/sql-mapping.ts`   | SQL type ↔ `ColumnType` mapping, shared by import and export.                                                                                                                                        |
| `src/index.ts`         | Just barrel re-exports.                                                                                                                                                                              |

## Hot rule: lockstep across packages

Adding or changing a field on a domain type touches **three places**, in this
order. Skip one and either Dexie rejects writes or plugins see a stale shape.

1. `packages/shared/src/types.ts` — the TS interface
2. `packages/renderer/src/db/dexie-db.ts` — Dexie schema string + typed accessor (only if it's a brand-new collection or an indexed field)
3. `packages/renderer/src/db/data-store-dexie.ts` — the plugin-facing wrapper (only if it's a brand-new collection)

Most field additions touch only step 1 — Dexie is schemaless for non-indexed fields.

## Schema versioning

Dexie tracks schema versions per-database. Bump `db.version(N).stores({...})`
in `dexie-db.ts` when adding/removing an **indexed** column. Field additions
to the JSON-stored payload don't need a version bump. Add an `.upgrade(tx => ...)`
callback if existing rows need rewriting.

## Plugin contract changes

`plugin-api.ts` is load-bearing — every plugin (built-in or URL-loaded) gets
the `HostApi` shape from here. Treat additions as a public-API change:
prefer optional properties, don't rename existing methods. The host
explicitly allows plugins to monkey-patch `api.*` methods; don't add
guards that would block that.

New events go on the `AppEvents` map, not on a sibling type — `EventBus.on`
is typed against this map and silently drops unknown keys.

`PluginModule.meta.optional = true` is the user-toggleable flag for built-ins.
The renderer's Plugin Manager dialog reads this; disabled state is stored
under the synthetic key `builtin:<name>` in the `plugins` collection. Don't
repurpose `optional` for other semantics.

## Build

`tsc -b` only. No bundler. Output goes to `dist/` and is consumed via the
workspace `*` dependency from renderer / server / electron.
