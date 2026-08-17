/**
 * The row-reading contract: "give me these fields, filtered, sorted, this slice".
 *
 * Every reader in this app currently asks for a whole table and does the work
 * itself. That is what makes a large table slow, and the cost is not in the
 * work — it is in the data. Measured opening one 609,283-row table (already
 * capped at 20,000): 1483ms, of which the main process spends 200ms decoding,
 * ~270ms serialising, and the renderer another ~270ms deserialising a 15.4 MB
 * payload — to display about 30 rows. The same query for 200 rows takes 13ms.
 * The grid already virtualises; it is the FETCH that is eager.
 *
 * A projection is worse: it holds no rows of its own, so it reads every source
 * table whole and joins in the renderer.
 *
 * So this is deliberately expressed as a QUERY rather than a window over a
 * fetched array. It has to survive three different backends without changing
 * meaning:
 *   - the SQLite store, where it becomes WHERE / ORDER BY / LIMIT — the same
 *     store on the desktop and in the browser;
 *   - the in-memory matcher, which finishes whatever the store reported it
 *     could not express (a computed or `array` column);
 *   - HTTP — the sync server, or a Datasette instance, where it becomes query
 *     parameters.
 *
 * Neither HTTP implementation exists yet, and there is a trap in the obvious
 * candidate: `plugins/datasette-client.ts`'s `translateQuery` looks like this
 * translation but does NOT agree with `column-filter.ts`. It reads a filter as a
 * comparison ladder (`>n`, `<=n`, `=v`) that the matcher has never had, maps a
 * comma list to Datasette's `__in` (exact equality) where the matcher means
 * substring, and uses case-sensitive `__exact`. Each of those is NARROWER than
 * the matcher, so wiring it would drop rows the user did not exclude — the one
 * failure `partial` cannot rescue, since that promises a superset. It has no
 * callers today. Reconciling it needs the treatment `filter-sql.ts` got: every
 * case run both ways and required to agree.
 *
 * Being serialisable is therefore part of the contract, not a convenience:
 * `filters` and `search` stay in the app's own filter LANGUAGE (the strings
 * `search/column-filter.ts` parses) rather than a pre-parsed tree, because that
 * language is what the UI produces, what a view persists, and what every
 * translator already knows how to read.
 */

import type { Row, SortSpec } from './types.js';

export interface RowQuery {
  /**
   * Output fields. Omitted means every column — a caller that needs only three
   * columns of a forty-column table should say so, since payload size is the
   * cost being avoided.
   */
  fields?: string[] | undefined;
  /**
   * Per-column filter expressions, keyed by field, in the app's filter language
   * (`^` prefix, `=` exact, `!` negate, `,` OR, `AND`, `NULL`). An empty or
   * absent expression filters nothing.
   */
  filters?: Record<string, string> | undefined;
  /** Global search across the filterable columns, same language. */
  search?: string | undefined;
  /** Sort keys, most significant first. */
  sort?: SortSpec[] | undefined;
  /** Rows to skip. Counted AFTER filtering and sorting. */
  offset?: number | undefined;
  /** Maximum rows to return. Omitted means every matching row — say a number. */
  limit?: number | undefined;
  /**
   * Count the matching rows as well as returning them. Default true.
   *
   * A HINT, not an instruction: a store where counting is free (`SELECT COUNT(*)`)
   * should ignore it and count anyway. It exists for the store where counting is
   * NOT free. IndexedDB has to walk the index to count a range: measured **14.0 s**
   * on 609,283 rows, against **0.3 s** to read the 500-row page it accompanies. A
   * raw `IDBIndex.count(range)` is no faster, so there is no better path to find.
   *
   * A grid drawing thirty rows needs the rows now and the total shortly. Waiting for
   * the count cost that 14 s twice over — once to choose the read's shape, once
   * inside the paged read to fill in `total`.
   *
   * A store that honors it sets {@link QueryPage.total} to `-1`.
   */
  countTotal?: boolean | undefined;
}

/**
 * One page of an answer. Generic because `DataCollection<T>.query` is generic —
 * rows are the case that matters, but a collection of any shape can answer one.
 */
export interface QueryPage<T> {
  rows: T[];
  /**
   * Rows matching the filter and search, IGNORING offset and limit.
   *
   * Needed separately because the caller has to show a total it did not fetch —
   * a titlebar count, a scrollbar's extent. Counting is cheaper than returning, but
   * how much cheaper depends entirely on the store: `SELECT COUNT(*)` on a 609k-row
   * table is milliseconds against the ~1.5s it took to hand over 20,000 rows, while
   * the same count in IndexedDB is 14 seconds. Which is why
   * {@link RowQuery.countTotal} exists.
   *
   * `-1` means NOT COUNTED — the caller passed {@link RowQuery.countTotal} `false`
   * and this store honored it. The same negative sentinel `countSuffix` and the
   * view-window manager already use for "no count yet". Never treat it as a number.
   */
  total: number;
  /**
   * Set when the backend could NOT apply every predicate, so `rows` is a
   * superset of the answer and the caller must filter it again itself.
   *
   * This exists because the alternative is silent wrongness. Datasette allows one
   * operator per column, so `!NULL AND Biden` is inexpressible there; a computed
   * (script) column cannot be filtered or sorted in SQL at all. A backend that
   * quietly dropped such a predicate would return rows the user excluded and look
   * like it had worked. Saying so lets the caller narrow what it got — which is
   * what the Datasette client already does — and lets `total` be understood as an
   * upper bound rather than a count.
   */
  partial?: boolean | undefined;
  /**
   * Set when the backend stopped short of the full answer — a row cap, a paging
   * limit, an instance that refuses to count past ~10k. `total` is then a FLOOR.
   *
   * Distinct from `partial`, and both can be true at once: `partial` is about
   * which PREDICATES were applied (rows are too many, filter again), `truncated`
   * is about how many rows came back (rows are too few, there is more out there).
   * A caller showing a count needs to say "20,000+" rather than "20,000".
   */
  truncated?: boolean | undefined;
}

export type RowPage = QueryPage<Row>;

/**
 * "Give me the distinct values of this field, with the other filters in place."
 *
 * The funnel's value list. It is asked for separately from the rows because a grid
 * holding one PAGE can only offer the values ON that page, and a list that changes
 * as you scroll is worse than one that says it is incomplete. So the page stays the
 * default and this is what the refresh icon asks for.
 *
 * Deliberately says nothing about HOW: `GROUP BY` in SQLite, a facet query at a
 * Datasette instance, a scan over rows already in hand. The caller must not be
 * able to tell which.
 */
export interface DistinctQuery {
  /** The field whose values are wanted. */
  field: string;
  /**
   * The OTHER columns' filters and the search, so the list stays FACETED.
   *
   * Which filters those are is the caller's rule, not the store's: a column's own
   * filter is left out of its own list, or picking one value would narrow the list
   * to that value and there would be no way back. `offset`/`limit` here are
   * meaningless and ignored — use {@link DistinctQuery.limit}.
   */
  where?: RowQuery | undefined;
  /** Cap on how many values come back. Absent means the store's own cap. */
  limit?: number | undefined;
}

/** One distinct value and how many rows carry it. */
export interface DistinctValue {
  value: unknown;
  count: number;
}

export interface DistinctPage {
  /** Commonest first, ties alphabetical — the order a value picker wants. */
  values: DistinctValue[];
  /**
   * Rows whose cell holds nothing, which a picker offers as one "(blanks)" entry.
   * Separate from `values` because "empty" is a filter option, not a value.
   */
  blanks?: number | undefined;
  /**
   * More distinct values exist than came back, or the store read only part of the
   * table to find them. Either way the list is incomplete and must say so.
   */
  truncated?: boolean | undefined;
  /**
   * The store could not apply all of `where`, so the counts are over a wider set
   * than the caller asked about. Same meaning as on {@link QueryPage}: the values
   * are a superset, and a count is an upper bound.
   */
  partial?: boolean | undefined;
  /**
   * These are whole CELLS of an `array` column, not its members: a SQL `GROUP BY`
   * over `"a,b"` groups the cell, because SQL cannot see inside it. The caller
   * takes them apart (`arrayMembers`) and adds the cell counts up per member.
   *
   * A separate flag rather than `partial`, so `partial` keeps one meaning. Both can
   * be true, and telling them apart is what lets the caller fix the members without
   * also claiming a filter was dropped.
   */
  cells?: boolean | undefined;
}

/** True when the query asks for nothing to be narrowed — a plain slice. */
export function isPlainSlice(q: RowQuery): boolean {
  const hasFilter = Object.values(q.filters ?? {}).some((v) => String(v).trim() !== '');
  return !hasFilter && !String(q.search ?? '').trim() && (q.sort ?? []).length === 0;
}
