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

import { arrayMembers } from '@easydb/shared';

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
 * The value(s) one cell contributes to a dropdown. An `array` column contributes
 * each MEMBER separately — a cell of `foo,bar,baz` is three options, not one —
 * which is the whole reason the type exists. Every other type contributes the
 * cell itself, or nothing when it is empty.
 */
function cellValues(value: unknown, type: string | undefined): string[] {
  if (type === 'array') return arrayMembers(value);
  return value == null || value === '' ? [] : [asText(value)];
}

/**
 * Is `field` worth offering a value list for? Every value in the first
 * {@link ELIGIBILITY_SAMPLE} rows must be shorter than `maxLen` — one long value
 * disqualifies the column, so a description field never fills a dropdown with
 * multi-line content. An empty row set is not eligible: there is nothing to show.
 *
 * An `array` column is judged by its longest MEMBER: a list of short tags easily
 * runs past the limit as one string, and would otherwise lose its dropdown
 * exactly when it has enough values to need one.
 *
 * A `text` column is never eligible, whatever the sample holds. The length rule
 * above reaches the same verdict for most prose, but it is decided from the
 * first {@link ELIGIBILITY_SAMPLE} rows — a body column whose first hundred rows
 * happen to be short would offer a dropdown that fills with one option per row
 * further down. The stored type is the column's own answer and does not depend
 * on which rows are loaded.
 */
export function facetable(rows: readonly HasData[], field: string, opts?: { maxLen?: number; type?: string | undefined }): boolean {
  if (opts?.type === 'text') return false;
  const maxLen = opts?.maxLen ?? FACET_MAX_LEN;
  if (rows.length === 0) return false;
  for (const r of rows.slice(0, ELIGIBILITY_SAMPLE)) {
    const v = r.data[field];
    if (v == null) continue;
    if (opts?.type === 'array') {
      if (arrayMembers(v).some((m) => m.length >= maxLen)) return false;
      continue;
    }
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
export function facetValues(rows: readonly HasData[], field: string, opts?: { maxLen?: number; maxOptions?: number; type?: string | undefined }): string[] {
  // Prose has no value list — see `facetable`.
  if (opts?.type === 'text') return [];
  const maxLen = opts?.maxLen ?? FACET_MAX_LEN;
  const maxOptions = opts?.maxOptions ?? FACET_MAX_OPTIONS;
  const seen = new Set<string>();
  for (const r of rows) {
    for (const s of cellValues(r.data[field], opts?.type)) {
      if (s.length >= maxLen) continue;
      seen.add(s);
      if (seen.size >= maxOptions) return [...seen].sort();
    }
  }
  return [...seen].sort();
}

/** One value of a field, with how many of the faceted rows carry it. */
export interface FacetCount {
  value: string;
  count: number;
}

/**
 * The same faceted list as {@link facetValues}, but counted and ordered for a
 * value PICKER: commonest first, ties alphabetical, plus how many rows are blank
 * (null / empty / whitespace) — the picker shows those as one "(Blanks)" entry.
 *
 * A `boolean` column always lists both sides, in `true`, `false` order, even
 * when the rows carry only one of them: a column of all-true rows would
 * otherwise leave no way to filter for false. A count of 0 says none are there.
 * Any other stored spelling (`yes`, `1`) keeps its own entry below.
 *
 * An `array` column counts each MEMBER, so the counts add up to more than the
 * row count — a row carrying `foo,bar` is one for `foo` AND one for `bar`. A
 * cell with no members at all counts as blank.
 */
export function facetCounts(rows: readonly HasData[], field: string, opts?: { type?: string | undefined }): { values: FacetCount[]; blanks: number } {
  // Prose has no value list — see `facetable`. Blanks are not counted either:
  // the picker they feed is never built for this column.
  if (opts?.type === 'text') return { values: [], blanks: 0 };
  const counts = new Map<string, number>();
  let blanks = 0;
  for (const r of rows) {
    const v = r.data[field];
    const values = opts?.type === 'array' ? arrayMembers(v) : v == null || asText(v).trim() === '' ? [] : [asText(v)];
    if (values.length === 0) {
      blanks++;
      continue;
    }
    for (const s of values) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let values = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  if (opts?.type === 'boolean') {
    const domain = ['true', 'false'].map((value) => ({ value, count: counts.get(value) ?? 0 }));
    values = [...domain, ...values.filter((v) => v.value !== 'true' && v.value !== 'false')];
  }
  return { values, blanks };
}
