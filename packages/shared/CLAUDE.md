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
| `src/row-query.ts`     | `RowQuery` / `RowPage` — "these fields, this filter, this sort, this slice" — and `DistinctQuery` / `DistinctPage`, one column's values for a funnel. What lets a reader stop fetching whole tables. |
| `src/column-filter.ts` | The filter LANGUAGE: parses an expression into `FilterToken[]` and matches it in memory. **The specification** every backend must agree with.                                                        |
| `src/array-cell.ts`    | How an `array` cell's members are read out of its three spellings (comma list, JSON-array text, real array). Here because `column-filter.ts` needs it — a filter token matches any one member.       |
| `src/filter-sql.ts`    | The same tokens as a SQL `WHERE` fragment. Cross-tested against the matcher.                                                                                                                         |
| `src/sql-mapping.ts`   | SQL type ↔ `ColumnType` mapping, shared by import and export.                                                                                                                                        |
| `src/index.ts`         | Just barrel re-exports.                                                                                                                                                                              |

## Hot rule: lockstep across packages

Adding a FIELD to a domain type touches one place: `src/types.ts`. Documents are
stored as JSON, so a new field needs no schema change anywhere.

Adding a **collection** touches three, in this order:

1. `packages/shared/src/types.ts` — the TS interface
2. `packages/renderer/src/db/data-store-bridge.ts` — the plugin-facing wrapper
3. `packages/shared/src/edb-store.ts` — `DOC_COLLECTIONS`. A collection the
   store does not know about **throws** there; it does not degrade quietly.

## Format versioning

There is no per-database schema version to bump. The `.edb` file carries a
format stamp — `EDB_FORMAT_VERSION` in `src/edb-store.ts`, currently 2 — and v2
is the only format that opens. See `docs/tech/EDB.md`.

## Plugin contract changes

`plugin-api.ts` is load-bearing — every plugin (built-in or URL-loaded) gets
the `HostApi` shape from here. Treat additions as a public-API change:
prefer optional properties, don't rename existing methods. The host
explicitly allows plugins to monkey-patch `api.*` methods; don't add
guards that would block that.

New events go on the `AppEvents` map, not on a sibling type — `EventBus.on`
is typed against this map and silently drops unknown keys.

`PluginModule.meta.fixed = true` marks a built-in the user cannot turn off;
every other built-in is toggleable and defaults to enabled. The renderer's
Plugin Manager dialog reads this; disabled state is stored under the synthetic
key `builtin:<name>` in the `plugins` collection. Don't repurpose `fixed` for
other semantics.

## Build

`tsc -b` only. No bundler. Output goes to `dist/` and is consumed via the
workspace `*` dependency from renderer / server / electron.
