// packages/shared/src/filter-range.ts
//
// A filter string, read as a RANGE plus everything else.
//
// A range picker — the date one, and a numeric one after it — needs three
// things a bare token list does not give it: which token is the lower bound,
// which is the upper, and what else is in the filter that it must not destroy.
// That last one is the reason this exists rather than living inside the date
// plugin: a picker opened on `>=2026-01-01 AND <=2026-06-01,!NULL` has to write
// the `!NULL` back untouched, and a second picker would otherwise need its own
// copy of the same reasoning.
//
// Only a POSITIVE comparison is a bound. `!>=2026-01-01` is an exclusion — it
// says "not on or after", which is not one end of a range — so it stays in
// `rest` and a picker leaves it alone.

import { composeColumnFilter, parseColumnFilter, type FilterToken } from './column-filter.js';

/** One end of a range. `strict` is `>` / `<` rather than `>=` / `<=`. */
export interface RangeBound {
  value: string;
  strict: boolean;
}

export interface FilterRange {
  from?: RangeBound | undefined;
  to?: RangeBound | undefined;
  /** Every token that is not part of the range, in their original order. */
  rest: FilterToken[];
}

/** Split a filter string into its range and everything else. */
export function readRange(filter: string): FilterRange {
  const out: FilterRange = { rest: [] };
  for (const t of parseColumnFilter(filter)) {
    if (!t.negate && (t.cmp === '>' || t.cmp === '>=') && !out.from) {
      out.from = { value: t.term, strict: t.cmp === '>' };
      continue;
    }
    if (!t.negate && (t.cmp === '<' || t.cmp === '<=') && !out.to) {
      out.to = { value: t.term, strict: t.cmp === '<' };
      continue;
    }
    out.rest.push(t);
  }
  return out;
}

/**
 * A range and its leftovers, back as a filter string.
 *
 * The two bounds are joined with `AND` because they must both hold of the same
 * cell; a comma would OR them and select everything. `composeColumnFilter`
 * drops an `and` flag on the first token it writes, so a to-only range or a
 * rest-only filter cannot come back starting with a dangling " AND ".
 */
export function composeRange(range: FilterRange): string {
  const tokens: FilterToken[] = [];
  if (range.from) tokens.push({ term: range.from.value, negate: false, cmp: range.from.strict ? '>' : '>=' });
  if (range.to) tokens.push({ term: range.to.value, negate: false, cmp: range.to.strict ? '<' : '<=', ...(range.from ? { and: true } : {}) });
  tokens.push(...range.rest);
  return composeColumnFilter(tokens);
}
