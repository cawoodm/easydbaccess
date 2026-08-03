# Projection — virtual tables (views / joins) design

**Status:** approved design, pre-implementation
**Date:** 2026-07-31

## Problem

easyDBAccess has no way to define a virtual table that derives its rows from
other tables — the equivalent of a database view, including a JOIN across
multiple tables. We want first-class objects that **look and act like tables**
(open in windows, sort/filter, export, get Views) but whose rows are computed
from one or more underlying tables rather than stored.

We call these **Projections**.

### Why "Projection" and not "View"

"View" is already taken in this codebase: a `ViewTemplate` / `ViewInstance` is
an HTML-template *presentation* of a single table (see
`packages/renderer/src/views/`). "Projection" avoids that collision and is
distinctive. (Relational-algebra purists: a JOIN is more than a projection;
the name is a product label, not an algebra claim.)

## Decisions (locked)

| Decision | Choice |
|---|---|
| Query definition | **Structured spec (JSON)** — no SQL engine, no free JS query |
| Freshness | **Live** — recompute whenever an underlying table changes |
| Writability | **Writeback only when unambiguous** (base-source, non-computed columns) |
| v1 operations | **Join (inner + left) + filters + column select/rename + computed columns** (no aggregation) |
| Source references | **By table name** (survives delete/recreate), `tableId` as a hint |

Explicitly deferred (YAGNI, each a clean later addition): aggregation /
GROUP BY, a SQL-string mode, writable secondary-source columns, a materialized
snapshot mode.

## Core model

A **Projection is an ordinary `Table`** that carries a `source` descriptor:

```
source: { type: 'projection', config: ProjectionSpec }
```

This reuses the existing row-source routing seam: when a `Table` has a
`source`, `store.rows(tableId)` is routed to the `RowCollectionProvider`
registered for `source.type` instead of local Dexie (see
`packages/renderer/src/db/routed-data-store.ts` and
`RowCollectionProvider` in `packages/shared/src/plugin-api.ts`). A new
`projection` provider computes the rows.

Because a Projection **is** a `Table`:

- It opens in a panel window, exports, and gets Views for free.
- Its `columns: ColumnSpec[]` (compiled from the spec at save time) drive
  renderers, width, hidden, and sort with no special-casing.
- The query definition lives in `source.config` — a plain JSON bag — so it
  **rides the existing gist/server sync** (`syncedTableFields` already
  includes `source`), and the computed rows are never persisted.

No new Dexie collection is introduced.

### The provider closes over the store — no `RowSourceCtx` change

`RowSourceCtx` is deliberately store-free (only `backend`, `events`,
`settings`, `workspaceId`) so remote providers stay storage-agnostic. A
projection is a *local* join and must read other local tables, but it does
**not** need this from `ctx`: the `projection` provider is registered from a
built-in plugin's `init(api)`, so it **closes over `api.store`** and reads the
underlying tables directly. `RowSourceCtx` is left unchanged.

## Data shapes

Added to `packages/shared/src/types.ts`:

```ts
export interface ProjectionSpec {
  version: 1;
  /** FROM + JOINs. sources[0] is the base (FROM) table. */
  sources: ProjectionSource[];
  /** SELECT list; array order is display order. */
  columns: ProjectionColumn[];
  /** Optional WHERE, keyed by OUTPUT field. Reuses the existing filter-substring shape. */
  filters?: Record<string, string> | undefined;
}

export interface ProjectionSource {
  /** Qualifies columns (e.g. "orders"); unique within the spec. */
  alias: string;
  /** Bound by NAME so it survives a source being deleted and recreated. */
  tableName: string;
  /** Fast-path resolution hint only; name wins if they disagree. */
  tableId?: string | undefined;
  /** Absent for sources[0]. Present for each JOIN. */
  join?:
    | {
        type: 'inner' | 'left';
        /** Equijoin keys: this source's `field` === already-introduced `eqAlias`.`eqField`. */
        on: Array<{ field: string; eqAlias: string; eqField: string }>;
      }
    | undefined;
}

export interface ProjectionColumn {
  /** Output field name; unique within the spec. */
  field: string;
  label: string;
  type: ColumnType;
  from:
    /** A real stored column — the only writeback candidate. */
    | { kind: 'source'; alias: string; field: string }
    /** Computed via `function render(row) { … }` — always read-only. */
    | { kind: 'script'; script: string };
}
```

Plus one small, reusable addition to `ColumnSpec`:

```ts
/** When true, the grid shows this column without an editor. Generalises the
 *  existing "scripted cells are read-only" behaviour to an explicit flag; used
 *  by Projections to mark non-writable (computed / secondary-source) columns. */
readonly?: boolean | undefined;
```

### Compiling the spec into `Table.columns`

At save time the editor compiles `ProjectionSpec.columns` into the Table's
`columns: ColumnSpec[]`:

- `field`, `label`, `type` copied through.
- `kind: 'script'` columns get `script` set (already read-only in the grid).
- Columns that are **not** writable per the rule below get `readonly: true`.

Nothing downstream needs to know a table is a projection — it sees an ordinary
`columns` array. `Table.readonly` (whole-table) is set only when **no** column
is writable (a fully-derived projection).

## Writeback rule ("unambiguous")

An edit to output cell (row `R`, column `C`) is written back **iff all** hold:

1. `C.from.kind === 'source'` (not a computed column), **and**
2. `C.from.alias` is the **base source** (`sources[0]`). Secondary-source
   columns are read-only in v1 because inner/left joins can fan out or be
   null, **and**
3. the provider resolves `R` back to the exact base `Row` and patches
   `data[C.from.field]` on it.

Every other output column is compiled with `readonly: true`.

### Row identity carries provenance

Each computed projection row's id encodes the base row it came from:

```
projectionRowId = `${baseRowId}#${ordinal}`
```

`#ordinal` disambiguates left-join fan-out (one base row producing several
output rows). Writeback parses the prefix to recover `baseRowId`
deterministically — no fragile in-memory map that a recompute could
invalidate. Fan-out duplicates all share one `baseRowId`, so an edit to a
base column is still unambiguous.

## Compute pipeline — `projection-compute.ts` (pure)

A DOM- and Dexie-free module, unit-testable in isolation:

- `computeProjection(spec, sourceRowsByAlias) => Row[]`
  1. resolve base rows,
  2. apply each JOIN (inner/left equijoin on `on` keys),
  3. apply `filters` (existing substring semantics, keyed by output field),
  4. build each output row by evaluating every `ProjectionColumn.from`
     (pluck a source field, or run the `function render(row)` script),
  5. stamp `id = ${baseRowId}#${ordinal}`.
- `writebackTarget(spec, rowId, field) => { baseTableId, baseRowId, field } | null`
  returns the underlying write target, or `null` when the column is read-only.

## Reactivity (live)

The provider's `DataCollection<Row>` implementation:

- `find()` — resolve sources by name → read their rows via the captured
  `api.store` → `computeProjection(...)`.
- `subscribe(fn)` — open `api.store.rows(srcId).subscribe(...)` for every
  resolved source **and** `api.store.tables.subscribe(...)` (to catch a source
  table being created/recreated and rebind by name). Any change → recompute →
  `fn(rows)`. This is exactly how the grid already consumes live data, so
  `data-table.ts` needs no change beyond honoring `ColumnSpec.readonly`.

Projection-on-projection composes naturally (a source's own provider routes
through the routed store), guarded by a **cycle check at save** and a
**runtime recursion-depth cap**.

## UI

- **`dialogs/projection-dialog.ts`** — the editor. Pick the base table → add
  joins (choose table + equality-key dropdowns from column fields) → select /
  rename columns per source (checkbox list, type, optional computed script) →
  optional filters. On save: build `ProjectionSpec`, compile `columns`, and
  `store.tables.insert` (new) / `patch` (edit) a Table with the `source`
  descriptor. `readonly` (table-level) set only if no column is writable.
- **`plugins/projection.ts`** (built-in plugin) — registers the row-source
  provider, a **"New Projection"** header button, and an **"Edit Projection"**
  table button with `visible: (t) => t.source?.type === 'projection'`.

### Source resolution by name

The provider resolves each `ProjectionSource.tableName` to a live table via
`api.store.tables.find({ workspaceId, name })`, using `tableId` as a fast-path
hint and falling back to name (mirroring the reconnect logic in
`window-mgr/view-window-manager.ts`).

## Sync & delete — no changes needed

- **Sync:** `source.config` is plain JSON on the Table and already synced via
  `syncedTableFields`. Computed rows are never written to Dexie, so there is
  nothing to push.
- **Delete:** `deleteTableCascade` already skips row removal for source-backed
  tables, so deleting a Projection just drops the Table record.

## Error handling

- **Missing source table / join key** — editor validation refuses the save; at
  runtime the projection renders empty with a banner ("source 'X' not found").
- **Duplicate output field names** — rejected at save.
- **Cyclic projections** — refused at save, with a runtime depth cap as a
  backstop.

## Files touched

| File | Change |
|---|---|
| `packages/shared/src/types.ts` | + `ProjectionSpec` / `ProjectionSource` / `ProjectionColumn`; + `ColumnSpec.readonly?` |
| `packages/renderer/src/plugins/projection-compute.ts` | new — pure compute + `writebackTarget` |
| `packages/renderer/src/plugins/projection.ts` | new built-in — provider + header/table buttons |
| `packages/renderer/src/dialogs/projection-dialog.ts` | new — the editor |
| `packages/renderer/src/table/data-table.ts` | honor per-column `ColumnSpec.readonly` (alongside scripted cells) |
| `packages/renderer/src/plugin-host/loader.ts` | register the `projection` plugin |
| tests | `projection-compute` unit; renderer integration; one Playwright e2e |

## Testing

- **Unit (`projection-compute`)** — inner join, left join (incl. fan-out id
  encoding), filters, select/rename, computed column, empty sources, missing
  keys; and `writebackTarget` for base-source vs computed vs secondary-source.
- **Integration (renderer + Dexie)** — define a projection over two real
  tables, assert grid rows; edit a base-source cell → underlying row updates;
  edit a computed / secondary-source cell → rejected.
- **E2e (Playwright)** — build a projection through the dialog and use it like
  a table (open window, sort, filter, open a View).
