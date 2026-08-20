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

- **Plain table mode** (`viewInstanceId` empty) — column _definitions_,
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
export/sync. `sortedRows()` ranks emptiness as the _smallest_ value —
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
- **Free-text search** — a _local_ per-table query (from the window's own
  search box) and a _global_ query (from the app-wide header search) are
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
rows that pass every _other_ column's active filter — not column A's own —
via `rowsFacetedFor()`. That's what gives drill-down behavior: picking
`Country = Sweden` narrows the `City` dropdown to Swedish cities, while the
`Country` dropdown itself keeps showing every country (its own filter is
excluded from its own facet).

**`array` columns filter per member.** A cell of an `array` column holds several
values, written as a comma list (`foo,bar,baz`), a JSON array (`["Foo","Bar"]`),
the same thing single-quoted (`['Foo', 'Bar']` — Python's spelling, and what a
great many exported CSVs hold), or a real JS array from a JSON import. All four
are read by [`array-cell.ts`](../../packages/shared/src/array-cell.ts), and the
column's type — not the shape of the cell — is what turns member reading on.

**Which columns get typed `array` on import** is `looksLikeArrayColumn` in that
same module, used by both `csv-import` and `json-import`. The rule is a RUN:
`ARRAY_RUN` (5) consecutive non-empty cells that are all lists. It used to be
"every non-empty cell", which one `n/a` in ten thousand lists was enough to
defeat — leaving the column a `string`, its cells one long value, and its funnel
offering whole cells that a picked value can never equal. A column with fewer than
five values still has to be all lists, so a two-row import is unchanged. Prose is
safe either way: a bare comma list is deliberately NOT evidence, since ordinary
sentences are full of commas.

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

**A hidden column's filter needs a second way out.** `Table.filters` is keyed by
FIELD and survives the column being hidden, but the funnel that would clear it
lives in the header — which a hidden column does not have. The grid then narrows
with nothing on screen to say why. So the columns editor shows the same state:
`renderFilterState` in `new-table-dialog.ts` puts a blue funnel on every filtered
column and a click switches it off, stashed rather than deleted so a second click
puts it back, written on Save with everything else.

Being field-keyed makes the editor responsible for the KEYS too — a rename has to
carry its filter and a removed column has to lose it
([`table/filter-map.ts`](../../packages/renderer/src/table/filter-map.ts)). A
stale key is not loud: `row-reader.ts` drops a filter naming a field no column has
(it would match nothing and empty the grid), so the filter would simply stop
existing without anyone being told.

## What a Validate run adds to a cell

`cellClass` / `problemOf` put one more state on a `<td>`, ahead of the type-based
marking below: ` is-problem` for a cell the last ✓ run flagged, with the reason as
the cell's `title`. The reasons come from
[`table/row-errors.ts`](../../packages/renderer/src/table/row-errors.ts), a
per-table registry the Validate plugin publishes to — `row id + field → why`,
which is the half of a finding no store can hold, because a cell is wrong relative
to a RULE rather than by its value.

A finding beats the type-based marking on the same cell: an empty cell that broke
a Required rule is already pink from `is-null`, and `is-problem` is what puts a
reason in its tooltip and keeps the mark when the empty-cell highlight is off. The
pink is the same pink on purpose — "look here" is one idea, and the app should say
it one way.

The colour is a preference (`grid:highlightErrors`, default on). The TOOLTIP is
not: a reason nobody can read is a loss, not a taste.

The other half of a run — each row's whole verdict — is an ordinary hidden column,
`_error`, with ordinary stored values. Nothing in this element treats it specially
except that its filter is never persisted, because a hidden column has no funnel to
clear one from. See `docs/tech/PLUGINS.md` § _Checking every row_.

## The empty-cell highlight is a preference

`cellStateClass` marks a `<td>` from the STORED value — ` is-null` for empty,
` is-invalid` for a value that does not fit the column type — so the marking holds
whatever the renderer draws, including a checkbox or an image for an empty value.
A scripted column is exempt: its display is computed, so an empty stored value is
normal there and pink would flag every row.

The pink one is behind `grid:highlightNulls` (Settings → Table grid, default on);
the red one is not, and deliberately so. A gap is normal and someone whose table
is mostly gaps can fairly call the colour noise, while "this value does not fit
its type" is a fault they must be able to see. The flag reaches the class through
a `@state()` field kept fresh by `easydb:settings-changed` — see `SETTINGS.md`'s
"Telling a reader a setting changed" for why a render cannot just read the store.

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
is `freezeColumnWidths()`: the instant a resize starts, every _visible_
column's currently-rendered width is snapshotted into `this.columns` (only
for columns that don't already carry an explicit width) and the table flips
to `table-layout: fixed` (triggered in `render()` whenever any column has a
`width`) — under which `<col>` widths are authoritative, so the drag tracks
the pointer exactly. On pointer-up, _all_ frozen widths are persisted (not
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

## Windowed reads: virtualising the FETCH, not just the paint

Virtualisation above only decided what was DRAWN. The fetch stayed eager: one
measured 609,283-row table cost **1483 ms** and a **15.4 MB** IPC payload to put
about thirty rows on screen, where the same query for 200 rows takes **13 ms**.

So a big table is now read one PAGE at a time.

Everything below is measured on the same 609,283-row table in the browser, Dexie over
IndexedDB (`test/e2e/zz-bigtable-perf` is not committed — it seeds for 22 minutes):

| Operation | Cost |
| --- | --- |
| Open the window, first row on screen | **191 ms** (from navigation, including boot) |
| The same, with a SAVED SORT on a column | **128 ms** to first row, sorted rows 5.4 s later |
| The same, with a SAVED FILTER | **5.2 s** — a filter cannot be windowed, see below |
| Read one 500-row page | ~300 ms |
| `count()` the table | 14.0 s |
| `subscribe` — the whole table, to be told one row changed | 25.0 s |
| `watch` — the same signal, no rows | **1 ms** |
| `find()` the whole table | 21.6 s (5.3 s of it the raw read, the rest narrowing) |
| Sort 609,283 rows already in memory | 0.3 s |
| A 500-row page at offset 500,000 | 25.7 s (see the cursor note below) |

- **The threshold is a setting** — `grid:windowRowsFrom` on the Table grid tab,
  default **50 000**, `0` never windows
  ([`table/grid-settings.ts`](../../packages/renderer/src/table/grid-settings.ts)).
  50 000 rather than something smaller so every table that works well today keeps
  the code path it already has, and only the ones that hurt change.
- **Three conditions, all deliberate** (`shouldWindow`): the collection must
  implement `query`, the setting must be on, and `tableTotal` must reach the
  threshold. Both stores answer a `query` now, so this works in the browser and on
  the desktop. The first two are `canWindow` — they are known without touching data,
  which is what lets an unmeasured table be read as a page before anything counts it.
- **Nothing waits for a count.** This was the opposite of the original design, and
  the original design was wrong about one fact: counting is NOT cheap. `SELECT
  COUNT(*)` is, but IndexedDB has to walk the whole `tableId` range. Measured on
  609,283 rows: **14.0 s to count, against 0.3 s to read the 500-row page**, and a
  raw `IDBIndex.count(range)` is no faster — so there is no better path to find. The
  grid was paying that 14 s twice before it drew a row: once in `loadRows` to pick
  the shape, once inside Dexie's paged `query` to fill in `total`.

  So `RowQuery.countTotal: false` exists, a windowed read always passes it, and
  `QueryPage.total` comes back as `-1` — the same "unknown count" sentinel
  `countSuffix` already used. The rows paint, and the size follows from `countSoon`.
  It is a HINT: the SQLite store ignores it and counts anyway, because there it
  really is free.
- **The window shape is a guess until something counts.** An unmeasured table is read
  as a page on the assumption that it is big. Three things then settle it:
  a page that comes back SHORT at offset 0 is the whole answer (`windowed` goes back
  to false and the count is exact — no background count at all); a read that returned
  a real `total` settles it inline; anything else gets `countSoon`. `settleWindow`
  re-reads the table when the guess was wrong — one extra read, of a table small
  enough for the read to be cheap by definition.
- **`countSoon` throttles, and stands aside for an import.** A total on screen only
  has to keep up, not be exact to the write, so a burst of writes costs one count
  (`COUNT_REFRESH_MS`, 5 s, trailing). While `externalLoading` is set an importer is
  filling the table and publishing its own progress in the titlebar — counting
  between its chunks would cost more than the import.
- **`matchingTotal` never shrinks below a size already measured.** An uncounted page
  at offset 5,000 only proves 5,500 rows exist, and a scrollbar that shrank under the
  hand holding it is worse than one that is briefly short.
- **The threshold read is awaited in `connectedCallback`.** Fired and forgotten, it
  lands after the first fetch — so the first read of a big table is the eager one,
  followed by a second to correct it. Both of the reads this exists to avoid.
- **`PAGE_ROWS` is 500** and the offset is snapped down to a whole page, so
  scrolling a few rows re-uses the page in hand. The span covers the viewport
  wherever it sits inside that page, or a viewport straddling a boundary would show
  a gap at every 500th row.
- **`bind` runs ONCE, and that is load-bearing.** A panel sets `tableId` before the
  element connects, so `connectedCallback` bound and Lit's first `updated` bound again.
  Everything doubled: two subscriptions, two initial loads, two row collections. The
  second collection is what hurt — `countNow` used to drop its answer when the
  collection it counted was no longer `this.rowColl`, and `store.rows(id)` builds a
  fresh wrapper on every call, so the re-bind won the race against a 14 s count every
  time. **A big table therefore never learned its own size at all**, and its titlebar
  showed the page in hand as the whole table: `(500)` on 609,283 rows. Two guards now:
  `bind` returns early when already bound to that key (set before its first `await`),
  and `countNow` compares the TABLE, not the collection object.
- **A saved SORT does not hold up the first paint.** Nothing in IndexedDB can order
  rows by a field inside `data`, so a sorted page means reading every row — 20 s to
  first paint, against 193 ms for the unsorted page beside it. So a windowed grid with
  a saved sort and nothing filtered reads the PLAIN page first, shows it, and re-draws
  in order when the sorted read lands (`shouldPrepaint` / `prepaint`). The rows on
  screen meanwhile are real rows of the table in storage order, and the loading bar
  stays up until the order is right.

  Deliberately NOT done for a filter: an unfiltered page shown under an active filter
  is not an unfinished answer, it is a wrong one, and no progress bar makes it honest.
- **A narrowed read teaches nothing about the table's size.** It measures its MATCHES.
  Settling the window on that compared `windowed` against a `tableTotal` still at 0 —
  which never reaches the threshold, so the mismatch never resolved and each re-read
  started another. A big filtered table re-read all 609,283 of its rows **every five
  seconds, without end**. It now asks for a count instead, which is the one number that
  ends it.
- **Identical reads in flight are shared** (`readPage`), keyed by the whole request.
  Over-keying only costs a missed share, which is the safe direction.

Three things then mean something different, and each is handled where it is read:

| Reader | Un-windowed | Windowed |
| --- | --- | --- |
| `virtualSlice` extent | `rows.length` | `matchingTotal` — else a 609k table scrolls 500 rows and stops |
| Slice indices | absolute | absolute minus `windowOffset` (0 un-windowed, so it is the same arithmetic) |
| Panel title count | rows in hand | `matchingTotal` — "500 of 609,283" would read as a filter nobody applied |

`virtualSlice` also pads for rows the page does not hold yet — the moment between
scrolling and the next page landing. Without that the table shrinks under the
scroll position and the view jumps back.

**Facets say so, and offer to fix it.** The funnel's value list is built from the
rows in memory, which windowed is one page, so the popover carries a note — "Values
from the rows loaded so far — there may be more" — and a REFRESH icon beside it.
Pressing it asks the store for the real list. Never automatic: a funnel click has to
stay instant, and the page usually already holds the value being looked for.

The contract is one optional capability, `DataCollection.distinct?({ field, where,
limit })` → `{ values, blanks, truncated, partial, cells }`, and it deliberately
says nothing about HOW: `GROUP BY` in SQLite, a scan in Dexie, a facet query at a
Datasette instance. `where` carries the OTHER columns' filters and the search, so
the list stays faceted — leaving a column's own filter out is the CALLER's rule
(`readDistinct` in `data-table.ts`), the same rule `rowsFacetedFor` follows for the
in-memory list.

Four things had to be got right, or the refreshed list would not agree with the one
it replaces:

- **Blanks are counted by their own query.** Left in the `GROUP BY`, the blank group
  takes a slot in the `LIMIT`: it can push a real value out of the list, and be
  missed entirely when it sorts past the limit itself.
- **An `array` cell is not its values.** `GROUP BY` over `"a,b"` groups the cell, so
  the store answers with `cells: true` and the renderer splits the members and adds
  the cell counts up — the same arithmetic `facetCounts` does.
- **`cells` is not `partial`.** Folding them together made the note claim a filter
  had been dropped when nothing had. `partial` keeps one meaning: a predicate had no
  SQL form.
- **A `boolean` column offers both sides at a count of 0**, or a column of all-true
  rows leaves no way to filter for false. `facetCounts` does that in memory; a
  `GROUP BY` cannot, so `readDistinct` puts the domain back.

Dexie's own `distinct` calls `facetCounts`, so on that path none of the four can
drift apart at all.

**Dexie answers a `RowQuery` in two ways**, because IndexedDB can honor one of them
and not the other
([`db/data-store-dexie.ts`](../../packages/renderer/src/db/data-store-dexie.ts)).

- A **plain slice** — no filter, no search, no sort (`isPlainSlice`) — is a real
  windowed read: `offset().limit()` walks the `tableId` index and reads only the
  page. This is the case that matters, because a big table is scrolled far more often
  than it is filtered. It honors `countTotal: false` and answers `total: -1`, which is
  what keeps the count off the path to first paint.

  **`offset` is a cursor walk, one step per row skipped**, because nothing indexes a
  row's POSITION. The first page costs ~300 ms and a page at offset 500,000 costs
  **25.7 s** — so scrolling to the far end of a 609k-row table is still slow, even
  though opening it no longer is. Fixing that needs keyset paging (continue from the
  last key of the previous page instead of counting off from the start), which needs a
  compound `[tableId+id]` index and so a Dexie schema bump. Not done.
- **Anything else** has to read the rows to match them: our filter language is not
  an IndexedDB query, and nothing indexes the fields inside `data`. That read is
  capped at `ROW_FETCH_CAP` and a capped answer reports `truncated`.

The narrowing path calls `applyRowRequest`, the same function the reader uses on the
rows it holds. That is deliberate: a filter which means one thing in the store and
another in the renderer returns a wrong answer that looks right, and one shared
implementation cannot disagree with itself.

**A sort or filter that arrives from the STORE refetches.** The header click and the
filter box always did. The other ways in — the columns editor's filter toggle, a
commandlet, a view patch, a sync from another device — set the state and left the
rows alone, which was harmless while the grid held every row and re-narrowed in
memory. Holding a page, re-sorting sorts 500 rows out of 609,283. `adoptQueryState`
compares before it adopts, so the grid's own write coming back through the
subscription is not a change and does not start a second read.

**Nothing else reads the table to learn one number.** Two readers used to, and both
were a second copy of the read the grid had just been taught to avoid:

- The **panel footer**'s row count called `subscribe`, which materializes the whole
  collection so it has an array to hand over, and keeps only `.length` — a full read
  on open and another on every write. The grid already publishes the same figure for
  the titlebar (`easydb:visible-count`), so the footer listens for that instead and
  reads nothing at all. `panel-title.ts` remembers the last count per key, because the
  event only fires on a change and a footer can mount after its grid has settled.
- **`auto-renderer`** ran `find()` and kept the first 50 rows, so a 609,283-row import
  paid for a whole extra read of itself the moment it finished. It asks `readRows` for
  a page of 50 now.

The Dexie rows collection also implements **`watch`** — the bare change signal, with
no rows attached — over `Dexie.on('storagemutated')`, the event `liveQuery` itself
listens to. This code once carried a comment explaining why that was impossible: a
cheap `liveQuery` key would stay silent when a cell is edited in place. True of a key,
and beside the point — `storagemutated` fires on the write itself, before any query
re-runs, so an in-place edit signals like any other mutation. The grid had been paying
a whole-table read per write for the privilege of being told about it.

**A view window collapses overlapping reads** (`view-window.ts`'s `loadRows`). The
rows subscription delivers once on connect — the same read `reload` has already
started — and once per write after that, and on the Dexie path every delivery costs a
full read of the table. A 20 000-row view read it four times over while it opened,
about five seconds. A request arriving mid-read is not dropped: it becomes one more
read after the current one, so the last state still wins.

**The cap bounds what comes BACK, not what is looked at.** `ROW_FETCH_CAP` is applied
to the RESULT of a filter, search and sort, never to the rows going in. The other way
round answers "these of the first 20,000" to a question about the table: a row
matching at row 30,000 is simply absent, and the grid looks like it filtered
correctly. That is the one failure `truncated` cannot rescue, because the answer is
not a superset of the right one — it is a different one. `total` is then every match,
so the truncation note can say how many were left out.

This holds in both places that cap: `readRows`'s no-`query` fallback and the Dexie
`query`. The rows were already read whole in both, so narrowing first costs nothing
and is the only correct order. The SQLite store never had the problem — a `WHERE`
runs before its `LIMIT`.

**A slice is only ever pushed with every predicate.** `readRows` refuses otherwise
(`sliceIsSound`), and if a backend applies the slice but reports `partial`, the
answer is re-read WITHOUT the slice and the whole request re-applied in the
renderer. Slicing a superset again would count off a second time — page 2 of page
2 — and nothing in the rows says which ones went missing.

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

The event and its `setTableLoading` reporter live in
[`table/table-loading.ts`](../../packages/renderer/src/table/table-loading.ts),
which also **remembers which tables are loading**. That memory is what makes a
multi-table import readable: the importer creates every table record up front
(so all the windows appear together) and marks them all loading, then fills them
one at a time — so most of the grids mount long after their own event was sent.
Each one calls `tableLoadingState(tableId)` on mount and when its `tableId`
lands, and starts flashing straight away instead of looking like an empty table.
`data-table.ts` re-exports `setTableLoading` for the importers that already
imported it from there.

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

Counts over three digits are grouped by the reader's own locale (`609,283`, or
`609’283` in Swiss German), as the import suffix already grouped them.

**A windowed grid may have no total to give**, and says so rather than substituting
the page in hand. `emitCount` sends `-1` while `windowed` is set and nothing has
counted, and `countSuffix` renders that as `" (500…)"` — a floor. It used to send
`max(tableTotal, matchingTotal, rows.length)`, which on an uncounted big table is the
500 rows on screen, so the title read `" (500)"` on a table of 609,283 rows. That is
not an unfinished answer but a wrong one. (Until the `bind` fix above, it also never
stopped being wrong, because no count ever landed.)

An unfiltered windowed table shows the TABLE's size once known — `" (609,283)"`, not
`" (500/609,283)"`. The 500 is a page the user scrolls through, not a match, and a
slash in this app means a filter narrowed the set.

**The size is remembered per table**
([`table/row-count-cache.ts`](../../packages/renderer/src/table/row-count-cache.ts)),
in `localStorage` under `easydb:rowcounts`, so the next open shows the total from the
first paint instead of a floor for however long a 14 s count takes. It is kept off the
`Table` record on purpose: it is derived data, and a synced field rewritten after every
count would push a workspace revision for a number no other device needs. A remembered
count can be stale — another device's writes, an import this tab never saw — so it only
feeds the title and the window decision, both already provisional, and the count every
load starts corrects it. `deleteTableCascade` forgets it.

## Three deletes, one button

The footer's trash button asks WHAT should go, because "delete" means three
different things on a table: **Delete All Data** (the rows, keeping the table and
its columns), **Delete Visible Data** (the rows a filter or a search left on
screen) and **Delete Table**. The button used to assume the third one, so there
was no way to empty a table you wanted to keep. The flow is in
[`plugins/delete-table.ts`](../../packages/renderer/src/plugins/delete-table.ts);
the row work is in
[`table/delete-rows.ts`](../../packages/renderer/src/table/delete-rows.ts).

The CHOICE is the confirmation. Each option names its action and how many rows it
takes, and Cancel sits in the dialog header, so a second yes/no dialog would only
add a click to every delete. The counts come from what the grid already published
for the titlebar, so opening the dialog costs no read; a big table still counting
shows no number rather than a wrong one.

**"Delete Visible Data" is listed first when it is offered**, because the first
option is the dialog's default — the one Enter submits — and it is the smallest of
the three deletes. With nothing narrowing the table it is not offered at all, so
"Delete All Data" becomes the default there.

**A row delete wakes only its own grid.** There is one `rows` table in IndexedDB
for every logical table, so a write to any of them used to re-read every open
window. Row writes are announced per table now — see `STORAGE.md` § "A row write
wakes one table".

**"Visible" is every matching row, not the page on screen.** A windowed grid holds
500 rows of a filtered table, and deleting those would leave the rest — an action
with no name the user could predict. So the read is uncapped: `ROW_FETCH_CAP` stops
a GRID drawing too much, but a delete that stopped at 20,000 would report success
and leave rows behind. The sort and the slice are dropped before it, since neither
changes which rows match.

**The grid has to publish what "visible" means**
([`table/visible-request.ts`](../../packages/renderer/src/table/visible-request.ts)).
A table's filters live on its record, but its SEARCH does not — the header box and
the panel box are live UI state — so a delete reading only the store would take
rows the user cannot see. The request is published from `updated()`, beside
`emitCount`, and NOT from `loadRows`: a filter change does not always reach the
store (the refetch it schedules is dropped if the grid disconnects before the timer
fires, and the in-memory pass still narrows what is drawn), so a request published
per load could say "unfiltered" about a grid showing 2 rows of 4. Every narrowing
input is a `@state`, so `updated` is the one hook that cannot miss one.

`narrowsRows` is what decides whether "Delete Visible Data" is OFFERED at all: with
nothing narrowing, it would delete exactly what the option above it deletes, which
is a trap rather than a choice. An empty table is offered no data options.

## Practical implications

- **A column's `type` still matters even with a custom renderer set.** Type
  drives sort comparison, SQL export typing (see `sql-export` in
  `PLUGINS.md`), and cell _editing_ when no renderer is registered —
  `renderer` only changes how the value is _displayed_.
- **Widths are sticky once frozen.** The first resize on a wide table
  freezes every visible column's width, not just the one being dragged —
  don't be surprised that resizing one column locks the whole row's layout
  from `auto` to `fixed` from then on.
- **Faceted suggestions silently opt a column out** once any sampled value
  in the first 100 rows hits 50 characters — a long-text/description column
  simply gets no filter dropdown, by design, not as a bug.
