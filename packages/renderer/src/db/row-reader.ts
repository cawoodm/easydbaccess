/**
 * The one place that decides how much of a read the BACKEND does.
 *
 * `DataCollection.query` is optional, and even where it exists it cannot express
 * everything the grid can. So a caller that just used `find()` would keep paying
 * for whole tables, and a caller that just used `query()` would sometimes get an
 * answer narrowed by rules the backend read differently. This module resolves
 * both: it hands the backend exactly the predicates that provably mean the same
 * thing there, then finishes the job in memory.
 *
 * Three cases, in order:
 *
 *  1. **No `query` on the collection** (Dexie, a plugin's own provider) — read
 *     everything and apply the whole request here. Identical to today.
 *  2. **`query` exists and the request is fully pushable** — one narrow read,
 *     and `total` comes back without the rows being fetched.
 *  3. **`query` exists but part of the request is not pushable** — push what is,
 *     take the superset (`RowPage.partial`, or a predicate we chose to hold
 *     back), and re-apply the rest here.
 *
 * What is NOT pushable, and why:
 *
 *  - **Free-text search.** `searchRowsByField` supports `field:value` terms,
 *    boolean AND/OR, and a phrase→AND→OR fallback whose answer depends on
 *    whether the *previous* attempt matched anything. That last rule cannot be
 *    a WHERE clause; a backend guessing at it would return a different set. A
 *    single plain word means the same thing on both sides, so that one case is
 *    pushed and the rest is not.
 *  - **Computed (script) columns.** Their values do not exist until a script
 *    runs in the renderer. The SQLite store already reports this by setting
 *    `partial`.
 *  - **A slice on top of anything held back.** Rows have to be narrowed before
 *    they can be counted off, so `offset`/`limit` only go down when every
 *    predicate did.
 */

import type { ColumnSpec, DataCollection, Row, RowPage, RowQuery, SortSpec } from '@easydb/shared';
import { matchesColumnFilter } from '@easydb/shared';
import { searchRowsByField, type SearchField } from '../search/text-search.js';
import { sortRowsBySpecs } from '../table/row-sort.js';

/**
 * A read as the grid means it. Distinct from `RowQuery` — which is the wire
 * contract — because this carries the renderer's own richer `search` and the
 * `columns` needed to sort by type and to know what is searchable.
 */
export interface RowRequest {
  columns: readonly ColumnSpec[];
  /** Per-column filter expressions, keyed by field. */
  filters?: Record<string, string> | undefined;
  /** Free-text query in the grid's search language (see the note above). */
  search?: string | undefined;
  sort?: readonly SortSpec[] | undefined;
  /** Output fields; omitted means every column. */
  fields?: string[] | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

/**
 * True when `query` means the same thing to a backend as it does to
 * `searchRowsByField`: a single bare word, no `field:` term, no AND/OR. Anything
 * else stays in memory.
 */
export function isPushableSearch(query: string, fields: readonly SearchField[]): boolean {
  const raw = query.trim();
  if (raw === '') return true; // nothing to push
  const tokens = raw.split(/\s+/);
  if (tokens.length !== 1) return false; // multi-word: phrase→AND→OR fallback
  const one = tokens[0] ?? '';
  const colon = one.indexOf(':');
  if (colon > 0) {
    // `field:expr` only counts as a field term when the field is a real one;
    // otherwise it is ordinary text containing a colon.
    const name = one.slice(0, colon).toLowerCase();
    const known = fields.some((f) => f.field.toLowerCase() === name || f.label?.toLowerCase() === name);
    if (known) return false;
  }
  return true;
}

/** Fields a free-text search looks in — everything not flagged unfilterable. */
function searchFieldsOf(columns: readonly ColumnSpec[]): SearchField[] {
  return columns.filter((c) => c.filterable !== false).map((c) => ({ field: c.field, label: c.label }));
}

/** Per-column filters that are actually active and actually allowed to narrow. */
function activeFilters(req: RowRequest): Array<[string, string]> {
  // A column flagged `filterable: false` is excluded from the funnel as well as
  // from search — a stored filter predating the flag must not keep narrowing.
  const unfilterable = new Set(req.columns.filter((c) => c.filterable === false).map((c) => c.field));
  return Object.entries(req.filters ?? {}).filter(([field, q]) => q && q.trim().length > 0 && !unfilterable.has(field));
}

/**
 * The whole request applied to rows already in hand — the grid's own pipeline:
 * per-column filters, then free-text search, then sort, then the slice.
 *
 * `total` is the count AFTER narrowing and BEFORE the slice, which is what a
 * titlebar or a scrollbar needs.
 */
export function applyRowRequest(rows: Row[], req: RowRequest): RowPage {
  let out = rows;

  const active = activeFilters(req);
  if (active.length > 0) {
    // The column TYPE is part of the match, not decoration: on an `array` column
    // the matcher tests each MEMBER instead of the whole cell, so `=bar` and
    // `NULL` mean different things with it than without. Leaving it out filtered
    // `["a","b"]` as one string and quietly dropped rows the grid would keep.
    const typeOf = new Map(req.columns.map((c) => [c.field, c.type as string | undefined]));
    out = out.filter((r) => active.every(([field, q]) => matchesColumnFilter(r.data[field], q, { type: typeOf.get(field) })));
  }

  const term = (req.search ?? '').trim();
  if (term !== '') out = searchRowsByField(out, term, searchFieldsOf(req.columns));

  out = sortRowsBySpecs(out, req.sort ?? [], req.columns);

  const total = out.length;
  const from = Math.max(0, req.offset ?? 0);
  const to = req.limit != null && req.limit > 0 ? from + req.limit : undefined;
  if (from > 0 || to != null) out = out.slice(from, to);

  return { rows: projectFields(out, req.fields), total };
}

/** Drop every field the caller did not ask for. A no-op when it asked for all. */
function projectFields(rows: Row[], fields: string[] | undefined): Row[] {
  if (!fields || fields.length === 0) return rows;
  const wanted = new Set(fields);
  return rows.map((r) => ({
    ...r,
    data: Object.fromEntries(Object.entries(r.data).filter(([k]) => wanted.has(k))),
  }));
}

/**
 * Read rows for `req`, letting `coll` narrow as much of it as it soundly can.
 *
 * `capWhenReadingAll` bounds the fallback read — the collection is about to hand
 * over everything, and an unbounded fetch of a 609k-row table is what crashed
 * the app on boot. It is a cap, not a page: the rows that come back are a
 * TRUNCATION, which the result reports as `truncated` so a caller showing a
 * count can say "20,000+" rather than "20,000". Pass 0 for no cap.
 */
export async function readRows(coll: DataCollection<Row>, req: RowRequest, capWhenReadingAll = 0): Promise<RowPage> {
  const searchTerm = (req.search ?? '').trim();
  const pushSearch = isPushableSearch(searchTerm, searchFieldsOf(req.columns));

  if (!coll.query) {
    const all = await coll.find();
    const hit = capWhenReadingAll > 0 && all.length >= capWhenReadingAll;
    return { ...applyRowRequest(hit ? all.slice(0, capWhenReadingAll) : all, req), ...(hit ? { truncated: true } : {}) };
  }

  const q: RowQuery = {
    ...(req.fields ? { fields: req.fields } : {}),
    ...(Object.keys(req.filters ?? {}).length > 0 ? { filters: Object.fromEntries(activeFilters(req)) } : {}),
    ...(pushSearch && searchTerm ? { search: searchTerm } : {}),
    ...(req.sort && req.sort.length > 0 ? { sort: [...req.sort] } : {}),
  };
  // The slice only travels when everything above it did. Otherwise the backend
  // would count off rows from a set we are about to narrow further.
  const sliceIsSound = pushSearch;
  if (sliceIsSound) {
    if (req.offset != null) q.offset = req.offset;
    if (req.limit != null) q.limit = req.limit;
  } else if (capWhenReadingAll > 0) {
    q.limit = capWhenReadingAll;
  }

  const page = await coll.query(q);
  // Sound and complete: the backend's own answer, `total` included.
  if (sliceIsSound && !page.partial) return page;

  // A superset. Re-run the whole request over it — cheaper than it looks, since
  // whatever the backend DID apply has already thrown most of the rows away.
  const redone = applyRowRequest(page.rows, req);
  // `page.total` counted the backend's wider-than-asked set, so it is an upper
  // bound on the real total, not the total. The re-run's count is exact for the
  // rows we hold, and `truncated` is what says it may not be all of them —
  // which the cap we just imposed makes true.
  const cappedOut = !sliceIsSound && q.limit != null && page.rows.length >= q.limit;
  return {
    ...redone,
    ...(page.partial ? { partial: true } : {}),
    ...(page.truncated || cappedOut ? { truncated: true } : {}),
  };
}
