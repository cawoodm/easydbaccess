# Datasette "Virtual" + "No Persist" — Design

**Status:** design (approved in brainstorming; no code yet)
**Date:** 2026-07-26
**Scope:** Two per-table options for Datasette (and, via a general contract,
any future live source): **virtual** (lazy, server-side, windowed loading for
big tables) and **no persist / no sync** (exclude the table from gist + server
sync). Surfaced in the Connect dialog and the column editor.

## Goal

Big remote tables (100k+ rows) are unusable today: connecting a live Datasette
table materialises **up to 10,000 rows into memory** and the grid sorts/filters
that whole snapshot client-side. Two options fix this:

- **Virtual** — load only what's needed: fetch the first page, lazily append
  the next page as the user scrolls toward the bottom, and push sort/filter to
  the server. Fetched pages are **kept in memory** for fast scrolling; changing
  the sort/filter (or pressing **Refresh**) clears the cache and re-fetches from
  page 0.
- **No persist (no sync)** — exclude the table from gist/server sync. The table
  definition still persists locally across reloads; live rows already never
  sync. Useful so a huge live table's definition doesn't bloat a gist.

## Decisions locked in brainstorming

1. **No persist** = a per-table flag that excludes the table from **gist and
   server sync only**. Definition still persists locally; reload keeps it.
2. **Virtual** = full lazy paging with **accumulation** (fetched pages stay
   resident — no eviction/scrollback refetch). Cache clears on sort/filter
   change or explicit Refresh.
3. `queryWindow` is a **general `DataCollection` capability**, feature-detected
   by the grid. Datasette is the only implementer for now.

## Data model (`packages/shared/src/types.ts`)

- **Virtual** reuses the existing `TableSource.serverQuery?: boolean` (already
  documented as "provider applies sort/filter server-side; snapshot is only the
  current window"). Add two optional tuning fields:
  - `TableSource.pageSize?: number` — rows per fetch (default 100).
- **No sync** — new `Table.noSync?: boolean`. Absent/false ⇒ current behaviour
  (synced). This is additive; no Dexie index change, no schema-version bump
  (non-indexed JSON field).

No other domain-type changes.

## Provider contract (`packages/shared/src/plugin-api.ts`)

Extend `DataCollection<T>` with one **optional** method:

```ts
export interface QueryWindowArgs {
  sort?: string | undefined;        // column field, or undefined for natural order
  sortAsc?: boolean | undefined;
  filters?: Record<string, string> | undefined; // field -> substring/value
  cursor?: string | undefined;      // opaque provider token; undefined = first page
}
export interface QueryWindowResult<T> {
  rows: T[];
  nextCursor?: string | undefined;  // absent ⇒ no more pages
  total?: number | undefined;       // filtered total when the provider knows it cheaply
}
interface DataCollection<T> {
  // …existing…
  /**
   * Optional: server-side windowed query. Present only on providers that page
   * server-side (a "virtual" source). The grid feature-detects it and, when a
   * table's `source.serverQuery` is set, drives paging/sort/filter through it
   * instead of sorting/filtering the full in-memory snapshot. Cursor is the
   * provider's own paging token (opaque to the grid).
   */
  queryWindow?(args: QueryWindowArgs): Promise<QueryWindowResult<T>>;
}
```

Rationale: keeps the storage abstraction intact and additive — non-virtual
(Dexie, snapshot, non-virtual Datasette) collections simply don't implement it
and behave exactly as today.

## Datasette provider (`plugins/datasette-collection.ts`, `datasette-client.ts`)

- **`datasette-client.ts`**: add server-side query params to the row fetch —
  `_sort` / `_sort_desc` for sort, and column filters (`col__contains` for text,
  `col__exact` otherwise) from the grid's per-column filters; page with
  Datasette's opaque `next` token (`?_next=`). Return `{ rows, next, total }`
  where `total` comes from `filtered_table_rows_count` when present.
- **`datasette-collection.ts`**: when `src.serverQuery`, expose `queryWindow`
  which maps args → client call → `{ rows, nextCursor, total }`. The non-virtual
  paths (`find`, `loadAll`, writes, `subscribe`) are unchanged for non-virtual
  tables. `refresh()` in virtual mode signals the grid to reset (see below); no
  server-side state is held in the collection — the **grid** owns the page cache
  so accumulation and reset live in one place.

## Grid (`table/data-table.ts`)

- Detect virtual mode: `table.source?.serverQuery === true` **and** the routed
  collection exposes `queryWindow`.
- **Virtual render path:**
  - Maintain `loadedRows: Row[]` (accumulated pages), `nextCursor`, `total?`,
    `loading`.
  - On mount / sort change / filter change: **reset** (`loadedRows = []`,
    `cursor = undefined`) then fetch page 0 via `queryWindow`.
  - Bypass the client-side `filteredRows()` sort/filter — the server already
    ordered/filtered; render `loadedRows` directly through the existing
    row-virtualization.
  - **Lazy append:** when the viewport scrolls within ~1 page of the bottom and
    `nextCursor` exists, fetch the next page and append. A small sentinel /
    scroll listener drives this (the grid already tracks scroll for
    virtualization).
  - Sort click and filter change re-issue `queryWindow` from page 0 (cache
    clears). Refresh (existing per-table button → `collection.refresh()`) resets
    and refetches page 0.
  - Title row count: `"N loaded"` or `"N loaded of M"` when `total` is known.
- Non-virtual tables are completely untouched (the branch only activates on
  `serverQuery` + `queryWindow`).

## No-sync enforcement

- **Gist** (`gist-sync.ts` / `dump-export.ts` serializer): skip tables with
  `noSync === true` from the pushed dump (both whole-workspace push and the
  per-table gist button should refuse/skip a no-sync table with a toast).
- **Server sync** (`server-sync-core.ts serializeWorkspace`): same — omit
  no-sync tables from the workspace blob.
- Pull/import is unaffected (nothing to exclude on the way in).

## UI surfacing

- **Connect dialog** (`plugins/datasette-source.ts`): two checkboxes below the
  connection fields — **"Virtual (windowed, server-side — for big tables)"** and
  **"Exclude from sync"**. Virtual sets `source.serverQuery = true`; Exclude sets
  `table.noSync = true`. Both default **off**. A one-line hint explains virtual
  is recommended for very large tables.
- **Column editor** (`dialogs/new-table-dialog.ts` edit mode): the same two
  toggles in a table-level settings row, so an existing table can be switched
  after the fact. Toggling virtual on/off patches `source.serverQuery`; the grid
  re-inits its data path on the table update.

## Edge cases

- **Writes on a virtual table:** unchanged write API; after a successful write,
  reset the grid cache and refetch page 0 (a write may reorder/paginate). Keep
  it simple — no optimistic in-window patching.
- **Unknown `total`:** scrollbar can't be pre-sized; that's fine — the grid
  grows as pages load (append model), and the count shows "N loaded".
- **Filters the server can't express:** the grid's per-column substring filters
  map to `col__contains`; anything unmapped falls back to server `contains`.
  (No client-side post-filtering in virtual mode — keep semantics honest.)
- **`serverQuery` set but provider lacks `queryWindow`:** fall back to the
  existing full-snapshot path (defensive; shouldn't happen for Datasette).

## Non-goals (v1 / YAGNI)

- Page **eviction** / bounded resident memory (user chose accumulation).
- Random-access "jump to row 50,000" (Datasette cursors are forward-only).
- Virtual for the **snapshot Import** path (this is the live Connect flow).
- A generic non-Datasette virtual provider implementation (contract only).

## Testing

- **Unit** (`datasette-client.test.ts`, `datasette-collection.test.ts`): query
  params built correctly (`_sort`/`_sort_desc`, `col__contains`), cursor paging
  advances via `next`, `total` parsed from `filtered_table_rows_count`,
  `queryWindow` shape. All via a fake fetch (no network).
- **e2e**: connect a table as virtual → only the first page loads → scroll to
  append a second page → sort a column (cache resets, server re-orders) → mark a
  table no-sync and confirm the gist/server dump omits it.

## Lockstep checklist (for the implementation plan)

1. `shared/types.ts` — `TableSource.pageSize?`, `Table.noSync?`.
2. `shared/plugin-api.ts` — `QueryWindowArgs`, `QueryWindowResult`,
   `DataCollection.queryWindow?`.
3. `datasette-client.ts` — server-side sort/filter params + cursor paging +
   total.
4. `datasette-collection.ts` — `queryWindow` in virtual mode.
5. `table/data-table.ts` — virtual render/paging path (feature-detected).
6. `plugins/datasette-source.ts` — Connect-dialog checkboxes.
7. `dialogs/new-table-dialog.ts` — column-editor toggles.
8. `gist-sync.ts` / `dump-export.ts` / `server-sync-core.ts` — honour `noSync`.
9. Unit + e2e tests.
