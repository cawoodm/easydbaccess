# @easydb/shared

The contracts every layer agrees on. Pure types + JSON schemas + the plugin
API. No runtime logic, no I/O, no DOM, no Node APIs — anything imported here
must work in browser, Node, and Electron main equally.

## Files

| File | What's in it |
|---|---|
| `src/types.ts` | TS interfaces: `Workspace`, `Table`, `Row`, `ColumnSpec`, `ColumnType`, `WindowGeometry`, `Setting`, `PluginRecord`. |
| `src/schemas.ts` | RxDB JSON Schema documents. Must stay byte-compatible with the TS types. |
| `src/plugin-api.ts` | The `HostApi`, `PluginModule`, `DataCollection<T>`, `DataStore`, `EventBus`, `Dialogs`, `WindowManager`, `Backend`, registry specs, `AppEvents`. **Single source of truth for the plugin contract.** |
| `src/index.ts` | Just barrel re-exports. |

## Hot rule: lockstep across packages

Adding or changing a field on a domain type touches **four places**, in this
order. Skip one and either RxDB rejects the doc or plugins see a stale shape.

1. `packages/shared/src/types.ts` — the TS interface
2. `packages/shared/src/schemas.ts` — the matching JSON Schema property
3. `packages/renderer/src/db/rx-db.ts` — if it's a brand-new collection
4. `packages/renderer/src/db/data-store.ts` — the plugin-facing wrapper

## Schema versioning

`tableSchema.version` is bumped whenever the shape changes. Each bump needs a
`migrationStrategies[N]` entry in `rx-db.ts` — even an identity function
(`(doc) => doc`) — or RxDB refuses to open the DB on devices with the older
shape. See the `// v0 -> v1` comments in `schemas.ts` and `rx-db.ts` for the
existing chain.

## Indexed numeric fields

RxDB requires `{ multipleOf, minimum, maximum }` on every numeric field listed
in `indexes`. The `updatedAt` convention is
`{ multipleOf: 1, minimum: 0, maximum: 9999999999999 }` — copy it for any new
indexed timestamp.

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
