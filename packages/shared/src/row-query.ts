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
 *   - the Electron SQLite store, where it becomes WHERE / ORDER BY / LIMIT;
 *   - Dexie in the browser, where the existing in-memory matcher applies it;
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
   * a titlebar count, a scrollbar's extent. Counting is far cheaper than
   * returning: `SELECT COUNT(*)` on a 609k-row table is milliseconds against
   * the ~1.5s it took to hand over 20,000 rows.
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

/** True when the query asks for nothing to be narrowed — a plain slice. */
export function isPlainSlice(q: RowQuery): boolean {
  const hasFilter = Object.values(q.filters ?? {}).some((v) => String(v).trim() !== '');
  return !hasFilter && !String(q.search ?? '').trim() && (q.sort ?? []).length === 0;
}
