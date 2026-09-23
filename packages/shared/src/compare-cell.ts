// packages/shared/src/compare-cell.ts
//
// Order comparison for one cell against one filter term — the `>=` `<=` `>` `<`
// half of the filter language.
//
// Separate from `column-filter.ts` because the answer depends on the COLUMN
// TYPE in a way no other token does: `'10' >= '9'` is false as text and true as
// a number, and both readings are right for some column. `column-filter.ts`
// owns the grammar; this file owns what the grammar's comparison MEANS.
//
// Type-aware keys arrive in the next task. Today every type compares as
// lowercased text, which is what the grammar did before comparisons existed.

import type { FilterCmp } from './column-filter.js';

/**
 * Does `value` stand in relation `cmp` to `term`?
 *
 * False for a cell with no content: a comparison against nothing is not an
 * order relation, and the matcher's rule is that an empty cell fails a positive
 * test (and therefore passes its negation, which the caller applies).
 */
export function satisfiesCmp(value: unknown, term: string, cmp: FilterCmp, _type: string | undefined): boolean {
  if (value == null) return false;
  const a = String(value).trim();
  if (a === '') return false;
  const b = term.trim();
  if (b === '') return false;
  return order(a.toLowerCase(), b.toLowerCase(), cmp);
}

/** The four operators, over any two already-comparable values. */
function order<T extends string | number>(a: T, b: T, cmp: FilterCmp): boolean {
  if (cmp === '>=') return a >= b;
  if (cmp === '<=') return a <= b;
  if (cmp === '>') return a > b;
  return a < b;
}
