/**
 * The value list behind a filter dropdown: which values a field actually holds,
 * across the rows that pass every OTHER filter.
 *
 * Extracted from `<data-table>`'s column-filter combobox so a view window's
 * filter chip can offer the same list. That is the whole point of the chip menu:
 * a view's `$filter` pills OR-append, but once one value is filtered on, the
 * template no longer shows the rows carrying the sibling values — so without a
 * list to pick from, a second value on the same field is unreachable by clicking.
 */

/** Longest a value may be to appear in a dropdown. Beyond this a column is
 *  prose (a description, a body) and its "values" are not a list. */
export const FACET_MAX_LEN = 50;

/** Cap on the options offered. A column with more distinct values than this is
 *  not usefully browsable, and the list has to stay cheap to build on a keystroke. */
export const FACET_MAX_OPTIONS = 500;

/** How many rows decide whether a column is a value list at all. */
const ELIGIBILITY_SAMPLE = 100;

/** A row, as far as this module cares. */
interface HasData {
  data: Record<string, unknown>;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

/**
 * Is `field` worth offering a value list for? Every value in the first
 * {@link ELIGIBILITY_SAMPLE} rows must be shorter than `maxLen` — one long value
 * disqualifies the column, so a description field never fills a dropdown with
 * multi-line content. An empty row set is not eligible: there is nothing to show.
 */
export function facetable(rows: readonly HasData[], field: string, maxLen = FACET_MAX_LEN): boolean {
  if (rows.length === 0) return false;
  for (const r of rows.slice(0, ELIGIBILITY_SAMPLE)) {
    const v = r.data[field];
    if (v == null) continue;
    if (asText(v).length >= maxLen) return false;
  }
  return true;
}

/**
 * The distinct values of `field` in `rows`, sorted, blanks dropped, values at or
 * over `maxLen` skipped, capped at `maxOptions`.
 *
 * `rows` is the caller's business: pass the set that passes every filter EXCEPT
 * this field's own, and the list is faceted — picking a value in one column
 * narrows what the others offer, while this column keeps showing its siblings.
 */
export function facetValues(
  rows: readonly HasData[],
  field: string,
  opts?: { maxLen?: number; maxOptions?: number },
): string[] {
  const maxLen = opts?.maxLen ?? FACET_MAX_LEN;
  const maxOptions = opts?.maxOptions ?? FACET_MAX_OPTIONS;
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r.data[field];
    if (v == null || v === '') continue;
    const s = asText(v);
    if (s.length >= maxLen) continue;
    seen.add(s);
    if (seen.size >= maxOptions) break;
  }
  return [...seen].sort();
}
