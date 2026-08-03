# Projection — implementation plan

Companion to `docs/superpowers/specs/2026-07-31-projection-virtual-tables-design.md`.
Read the spec first; this plan assumes its decisions.

Each phase is independently verifiable and ends green (typecheck + its tests).
Every commit bumps the patch version via the pre-commit hook — that is expected.
Prefer test-first where a pure function or a clear contract exists.

## Phase 0 — Shared types (foundation)

**Files:** `packages/shared/src/types.ts`, `packages/shared/src/index.ts` (barrel).

- Add `ProjectionSpec`, `ProjectionSource`, `ProjectionColumn` exactly as in the
  spec's "Data shapes" section (respect `exactOptionalPropertyTypes`: every
  optional field carries an explicit `| undefined`).
- Add `readonly?: boolean | undefined` to `ColumnSpec` with the doc comment from
  the spec.
- Ensure all three interfaces are re-exported from the barrel.

**Verify:** `npm run typecheck` clean. No behavior change yet.

## Phase 1 — Pure compute module (test-first)

**Files:** `packages/renderer/src/plugins/projection-compute.ts` (+ `.test.ts`).

DOM- and Dexie-free. Export:

- `computeProjection(spec: ProjectionSpec, sourceRowsByAlias: Record<string, Row[]>): Row[]`
- `writebackTarget(spec, rowId, field): { baseTableId?: string; baseRowId: string; field: string } | null`
  (baseTableId resolution can be deferred to the provider; the pure fn returns
  `baseRowId` + `field` + whether the column is base-source & non-script.)
- A small `resolveWritability(spec): Set<outputField>` helper used by both the
  compiler (to set `ColumnSpec.readonly`) and `writebackTarget`.

**Write tests first**, covering:
1. Single source, select subset + rename → rows carry `id = \`${srcId}#0\``.
2. Inner join on a key → only matching rows; unmatched base rows dropped.
3. Left join with a base row matching 2 secondary rows → 2 output rows,
   ids `${baseId}#0`, `${baseId}#1`; left join with 0 matches → 1 row, secondary
   fields `undefined`.
4. Filter (substring, keyed by output field) narrows rows.
5. Computed column: `from.kind==='script'` runs `function render(row){…}` over the
   joined row; result placed in the output field.
6. `writebackTarget`: base-source col → target; script col → null; secondary
   col → null.

**Verify:** `npm run test` (renderer vitest) green for this file.

## Phase 2 — Row-source provider + writeback (integration-tested)

**Files:** `packages/renderer/src/plugins/projection.ts` (provider portion), test in
`packages/renderer/src/plugins/projection.integration.test.ts` (fake-indexeddb,
mirror an existing renderer integration test's setup).

- In the plugin's `init(api)`, capture `api.store` and call
  `api.registerRowSource({ type: 'projection', create })`.
- `create(table, ctx)` returns a `DataCollection<Row>`:
  - Resolve each `ProjectionSource` by name via `api.store.tables.find({ workspaceId, name })`,
    preferring `tableId` when it still maps to the same name (mirror
    `view-window-manager.ts` reconnect).
  - `find()` → read `api.store.rows(srcId).find()` per source → `computeProjection`.
  - `subscribe(fn)` → subscribe to every source's `rows` **and** `api.store.tables`
    (rebind on create/recreate); on any change recompute and `fn(rows)`. Debounce
    microtask to coalesce multi-source bursts.
  - `patch(rowId, patch)` / `upsert` → for each changed field, `writebackTarget`;
    if a base target, `api.store.rows(baseTableId).patch(baseRowId, { data })`;
    if null (read-only), throw a clear error. `insert`/`remove` throw
    ("projection rows are derived").
  - `refresh()` → recompute + notify (feature-detected by callers).
- **Cycle guard:** while resolving sources, track the projection-id chain; if a
  source resolves to a projection already on the chain, throw at compute and cap
  recursion depth (e.g. 8) as a backstop.

**Tests:** create two local tables + rows; insert a projection Table with a
`source` spec; assert `store.rows(projId).find()` matches expected; mutate a base
row → subscription re-emits; `patch` a base-source cell → underlying row updated;
`patch` a computed/secondary cell → rejected.

**Verify:** `npm run test` green.

## Phase 3 — Grid honors per-column `readonly`

**Files:** `packages/renderer/src/table/data-table.ts` (+ existing table test).

- Where the grid decides a cell is non-editable for a scripted column, also treat
  `column.readonly === true` as non-editable (no editor, display value only).
  Single predicate, reused by both cases.

**Test:** a column with `readonly:true` renders no editor even when the table is
otherwise editable.

**Verify:** `npm run test` green.

## Phase 4 — Editor dialog + entry points

**Files:** `packages/renderer/src/dialogs/projection-dialog.ts` (new),
`packages/renderer/src/plugins/projection.ts` (UI portion),
`packages/renderer/src/plugin-host/loader.ts` (register),
small routing tweak in `panel-footer.ts` / the `edit-columns` handler.

- **Dialog** (a Lit element the plugin opens directly by appending to the DOM —
  keep it plugin-owned, no new core `ui.open*` method): base-table picker → add
  JOIN rows (table select + equality-key selects from column fields) → column
  picker per source (checkbox, editable label, type, optional computed-script
  editor) → optional filters. On save: build `ProjectionSpec`, compile
  `columns: ColumnSpec[]` (set `script` for computed, `readonly` per
  `resolveWritability`), set table-level `readonly` only if the writable set is
  empty, then `store.tables.insert` (new) or `patch` (edit) with the `source`
  descriptor.
- **Buttons** (in `projection.ts`): `registerHeaderButton` "New Projection";
  `registerTableButton` "Edit Projection" with
  `visible: (t) => t.source?.type === 'projection'`.
- **Route edit-columns:** when the generic column-editor action fires for a table
  whose `source?.type === 'projection'`, open the projection dialog instead (so a
  projection's structure is only ever edited through its own editor, never the raw
  column editor which would desync it from the spec).
- Register the plugin in the `builtins` array. Mark `meta.optional` per taste
  (recommend non-optional for v1; it adds no cost to plain tables).

**Verify:** `npm run typecheck && npm run lint && npm run test` green.

## Phase 5 — End-to-end

**Files:** `e2e/projection.spec.ts` (mirror an existing spec's harness).

- Create two tables with a shared key, open "New Projection", build a left join
  selecting columns from both + one computed column, save.
- Assert the projection window opens and shows expected rows; sort a column;
  apply a filter; open a View on it. Assert a base-source cell is editable and a
  computed cell is not.

**Verify:** `npm run test:e2e` green (or the single spec via `-g`).

## Phase 6 — Ship a preview

- Full gate: `npm run typecheck && npm run lint && npm run test && npm run build`.
- Publish the branch's Pages preview (`npm run publish -- -Target easydbaccess<N>`
  — confirm `pwsh` availability first; if absent, replicate its build+deploy steps
  manually: build renderer with the `--base /easydbaccess<N>/` and push the output
  to the `cawoodm/cawoodm.github.io` Pages repo).
- Hand the user the public URL.

## Risks / watch-items

- **`RowSourceCtx` is store-free by design** — the provider must use the captured
  `api.store`, not `ctx`. Do not widen `RowSourceCtx`.
- **liveQuery fan-out** — subscribing to `tables` recomputes on unrelated table
  writes; acceptable (coarse granularity is already the norm here), but debounce.
- **Row-id encoding** — `${baseRowId}#${ordinal}` assumes base row ids never
  contain `#`. Row ids are app-minted (uuid-like); assert this in a test and, if
  ever untrue, switch the separator.
- **Sync** — verify a projection round-trips through `dump-export` / gist without
  emitting rows (it must carry `source` + compiled `columns`, zero rows).
