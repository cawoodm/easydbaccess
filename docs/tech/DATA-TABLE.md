# The Data Table

`<data-table>` ([`packages/renderer/src/table/data-table.ts`](../../packages/renderer/src/table/data-table.ts))
is the single Lit element that renders every table window's grid and — in a
different binding mode — every View window's read-only grid fallback. One
~1,300-line component owns cell editing, sort, per-column filters with
faceted suggestions, drag-to-reorder, drag-to-resize, row virtualization,
and two loading-bar sources. This page is the "how it actually works" tour;
for where its data comes from see [`STORAGE.md`](./STORAGE.md), for the
window chrome around it see [`WINDOWS.md`](./WINDOWS.md), and for how a
column gets a non-default renderer see [`PLUGINS.md`](./PLUGINS.md)'s Cell
Renderers section.

## Two binding modes, one element

`<data-table>` takes two properties: `tableId` (always) and `viewInstanceId`
(only when it's rendering inside a View window in "template off" grid
fallback — see `PLUGINS.md`'s Views section). Whichever is set changes what
`this.columns`/`sortColumn`/`filters` etc. actually mean:

- **Plain table mode** (`viewInstanceId` empty) — column *definitions*,
  sort, filters, and column widths all live on and are persisted straight to
  the `Table` record (`applyTable()`).
- **View-bound mode** (`viewInstanceId` set) — column **definitions** still
  come from the underlying `Table` (kept live via a `tables.subscribe()`, so
  a column rename/type-change flows through), but **presentation** — which
  columns show, their order, their widths, sort, and filters — is read from
  and written back to the bound `ViewInstance` instead (`applyView()`).
  `ViewInstance.visibleColumns` (an ordered field list) resolved against the
  table's column defs, with any `columnWidths` overlaid, is what actually
  renders; a column the user removed from the underlying table is silently
  skipped.

Both `bind()` paths subscribe to their respective collection so external
edits — the column editor, another device's sync pull, a script renderer
change — refresh the grid without a reload. A guard on both `applyTable`/
`applyView` skips overwriting `this.filters` from the store while a
debounced filter save is still pending (`filterSaveTimer != null`), so a
store emission that lands mid-keystroke can't revert what the user just
typed.

## Cell rendering — renderer name first, type as fallback

`renderCell()` looks up `col.renderer` (a string, independent of `col.type`)
in a snapshotted `Map` of the registered cell renderers
(`ctx.registries.cellRenderers`, re-snapshotted on `app:ready` so anything
that registers late is still picked up). A hit renders the matching custom
element via Lit's `unsafeStatic`/`staticHtml` (the only way to use a
runtime-determined tag name), passing `.value`, `.column`, and `.row` (the
full row data, for renderers like `script` that need neighbouring fields),
and wiring its `change` event to `setCell()`.

No renderer, or an unregistered name, falls back to a native editor chosen
by `col.type`: a checkbox for `boolean`, `<input type=date>` /
`datetime-local` for `date`/`datetime`, a plain text/number input
otherwise. **Renderers are purely a display concern** — every cell is
editable by default regardless of whether a custom renderer is registered.
Escape while editing (`cancelCellEdit`) reverts the input's displayed value
without committing and stops the keypress from bubbling to the panel's
titlebar/search shortcuts.

## Writing a cell — validated, not just saved

`commitCell()` runs the column's constraints before writing:

- `notnull` — rejects `null`/`undefined`/whitespace-only strings.
- `max` — a string longer than `max` chars, or a number greater than `max`.
- `unique` — rejects a value that already exists on another row of the same
  table (checked against `allRows`, excluding the row being edited).

A rejection pops an alert with the specific reason and forces a re-render so
the input snaps back to the stored value — nothing is silently dropped. A
write that fails after passing validation (a live/remote-backed table
rejecting it — read-only source, expired auth, a server error) surfaces the
same way instead of leaving an unhandled promise rejection and a
stale-looking cell.

## Sort

Header click cycles **none → asc → desc → none** (`toggleSort`). The sort
column/direction is persisted immediately to the `Table` (or, in view-bound
mode, the `ViewInstance`) so it survives a reload and rides along through
export/sync. `sortedRows()` ranks emptiness as the *smallest* value —
`null` sorts ahead of `''`, which sorts ahead of any real value — so the
rank, not the raw comparison, flips with direction: ascending floats
nulls-then-blanks to the top, descending sinks them to the bottom. Real
values compare through `compareValues()`, which is type-aware
(numeric compare for `number`, epoch compare for `date`/`datetime`, boolean
as 0/1, string `localeCompare` otherwise, falling back to string compare if
either side fails to parse as its declared type).

## Filtering

Two independent layers narrow the row set, applied together in
`filteredRows()`:

**Which columns may be searched or filtered at all** is one rule, in
[`search/searchable-columns.ts`](../../packages/renderer/src/search/searchable-columns.ts),
shared by the grid and by `row-reader.ts`. `ColumnSpec.filterable === false` is
the explicit answer (the ⚲ box in the columns editor). On top of that, a
**scripted column that stores nothing** is dropped: its value is computed at
render time and never written back, so `row.data[field]` is empty for every row
and a search over it scans empties while the grid plainly SHOWS the value being
searched for. Such a column gets no funnel and is not a field the search looks
in.

That mark is DERIVED, never written onto the column. Storing `filterable: false`
would freeze a guess: a column that carried values before a script was added to
it, or one an import fills later, is searchable and must stay so. With no rows to
judge by (an empty table, a read still in flight) nothing is dropped — no
evidence is not evidence of emptiness.

- **Per-column filters** — a substring match typed into each column's
  header `<filter-combobox>`. Changes are debounced 250ms before persisting
  (`onFilterInput` → `saveFilters`), so typing doesn't hammer IndexedDB on
  every keystroke; the pending timer doubles as the "don't let a store
  refresh stomp what I'm mid-typing" guard mentioned above.
- **Free-text search** — a *local* per-table query (from the window's own
  search box) and a *global* query (from the app-wide header search) are
  each applied through `searchRows()` from
  [`search/text-search.ts`](../../packages/renderer/src/search/text-search.ts),
  a pure, DOM-free helper shared with the view window. Its rules: an
  uppercase standalone `AND`/`OR` in the query builds a boolean expression
  (`OR` binds loosest — `a AND b OR c` means `(a AND b) OR c`, no
  parentheses supported; lowercase `and`/`or` are ordinary search words, not
  operators). With no operators and multiple plain words, it tries the
  **whole phrase** first, then falls back to **AND of every word**, then to
  **OR of any word** — stopping at the first non-empty result set.

**Faceted filter suggestions.** Each column's filter dropdown is populated
by `computeFilterSuggestions()`: it samples the first 100 rows to decide
whether a column is "short enough" to suggest (every sampled value under 50
chars — long free-text columns get no dropdown at all), then collects up to
500 unique values. Critically, the value list for column A is computed over
rows that pass every *other* column's active filter — not column A's own —
via `rowsFacetedFor()`. That's what gives drill-down behavior: picking
`Country = Sweden` narrows the `City` dropdown to Swedish cities, while the
`Country` dropdown itself keeps showing every country (its own filter is
excluded from its own facet).

**`array` columns filter per member.** A cell of an `array` column holds several
values, written either as a comma list (`foo,bar,baz`) or as a JSON array
(`["Foo","Bar"]`, or a real JS array from a JSON import). All three are read by
[`array-cell.ts`](../../packages/shared/src/array-cell.ts), and the
column's type — not the shape of the cell — is what turns member reading on.

Both filter layers take the members instead of the whole cell: the dropdown
offers each member as its own option (with the count of rows that carry it, so
the counts add up to more than the row count), and a token matches when ANY
member matches it. That is what makes the dropdown work at all here: it writes
an EXACT token (`=Foo`), and a cell holding several values never equals one of
them. `NULL` means "no members", so `[]` counts as empty. The stored cell is
never rewritten — the type only changes how it is read.

A list with no members also SHOWS as an empty cell (pink, no tooltip) instead of
as the text it is stored in: `[]` is how an absent list arrives from most exports,
and two brackets read as content where there is none.

The `tags` renderer (`plugins/cell-tags.ts`) draws one pill per value, and an
`array` column gets it automatically at import time (`csv-import`'s
`rendererForType`, `auto-renderer`'s `inferRenderer`). Its pencil edits the raw
list, not the pills, so an edit never rewrites one spelling into the other.

Type inference marks a column `array` for a real array or a JSON-array text,
**never** for bare commas: ordinary prose is full of commas. A comma list becomes
an `array` column when the user picks the type in the columns editor or a CSV
header says so (`tags:Tags:array`).

## Column reorder and resize

**Reorder** is native HTML5 drag-and-drop, deliberately scoped to a small
`.col-grip` handle rather than the whole `<th>` — an earlier version made
the entire header cell draggable, which both hijacked the resize gutter's
pointer drag and ate the sort click. Dropping left-or-right-of-center on the
target header (`onColDragOver` computes `before`/`after` from the drop
x-position vs. the target's midpoint) reorders `this.columns` and persists
either the table's whole `columns` array (plain mode) or just the
`ViewInstance.visibleColumns` field order (view-bound mode).

**Resize** is pointer-event based (`onResizeStart`), not native drag, since
it needs continuous `pointermove` deltas rather than drop semantics. The
tricky part: under `table-layout: auto` (the default), the browser ignores
`<col>` widths whenever content demands more room — so setting one column's
width live would silently do nothing on a wide, many-column table. The fix
is `freezeColumnWidths()`: the instant a resize starts, every *visible*
column's currently-rendered width is snapshotted into `this.columns` (only
for columns that don't already carry an explicit width) and the table flips
to `table-layout: fixed` (triggered in `render()` whenever any column has a
`width`) — under which `<col>` widths are authoritative, so the drag tracks
the pointer exactly. On pointer-up, *all* frozen widths are persisted (not
just the dragged column), because the fixed layout needs every column's
width to reproduce the same rendering after a reload.

## Row virtualization

Tables under `VIRT_THRESHOLD` (200 rows) always render every row — cheap
enough not to bother. Above that, `virtualSlice()` computes which rows are
actually in view from the host's own `scrollTop` (`:host` has
`overflow: auto`, so `<data-table>` itself is the scrolling container) and
a measured `rowHeight` (sampled once from the first rendered `<tr>`, then
reused as a constant — rows are assumed uniform height). It renders only
`ceil(viewportHeight / rowHeight) + 2×OVERSCAN` rows (`OVERSCAN` = 8 rows
above and below) and fills the gap with two spacer `<tr>`s sized to
`topPad`/`bottomPad` pixels, so the scrollbar's total scroll range stays
correct without every row existing in the DOM.

## Two independent loading bars

The sticky header loading bar (`.load-bar`) can be driven by either of two
unrelated signals, tracked as separate `@state` flags so they don't
interfere:

- **The grid's own fetch** (`loading`) — set only if `rowColl.find()` takes
  longer than `LOAD_BAR_DELAY_MS` (200ms), so a fast local load never
  flashes it. Always indeterminate — a Dexie/local read has no incremental
  progress signal to report.
- **An external producer** (`externalLoading`/`externalProgress`) — driven
  by the document-level `easydb:table-loading` custom event, matched by
  `tableId`, so a window can show progress **before its rows exist at all**
  (e.g. a Datasette snapshot import filling the table in the background).
  When the event carries a numeric `progress`, the bar becomes determinate
  (width ∝ fraction); otherwise it runs the same indeterminate sliver
  animation as the local case.

## Row count → panel title

After every render, `emitCount()` compares the just-rendered visible row
count and the underlying total against what was last emitted, and — only on
a change — dispatches the shared `easydb:visible-count` event (from
[`window-mgr/panel-title.ts`](../../packages/renderer/src/window-mgr/panel-title.ts),
see `WINDOWS.md`) keyed by either the view instance id (view-bound mode) or
the table id, so the enclosing panel's title bar can show
`"Name (12)"` or `"Name (3/12)"` when a filter/search has narrowed the set.
The grid has no direct reference to its own panel — this decoupling is why
the event goes through `document` rather than a callback prop.

## Practical implications

- **A column's `type` still matters even with a custom renderer set.** Type
  drives sort comparison, SQL export typing (see `sql-export` in
  `PLUGINS.md`), and cell *editing* when no renderer is registered —
  `renderer` only changes how the value is *displayed*.
- **Widths are sticky once frozen.** The first resize on a wide table
  freezes every visible column's width, not just the one being dragged —
  don't be surprised that resizing one column locks the whole row's layout
  from `auto` to `fixed` from then on.
- **Faceted suggestions silently opt a column out** once any sampled value
  in the first 100 rows hits 50 characters — a long-text/description column
  simply gets no filter dropdown, by design, not as a bug.
