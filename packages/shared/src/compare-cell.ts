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

/** `YYYY-MM-DD`, and the date half of a naive datetime. */
const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const NAIVE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A cell or a bound as something two of its kind can be ordered by, or null
 * when it cannot be read as one.
 *
 * `date` and `datetime` come back as normalised ISO TEXT rather than an epoch
 * number, because ISO text sorts correctly as text and stays readable in a
 * failing test. A value carrying a zone is converted to **UTC** first — not to
 * the reader's local clock — so that this agrees with SQLite's `date()` /
 * `datetime()`, which is what the SQL pushdown uses. A local rule could not be
 * reproduced in SQL and the two answers would drift.
 */
export function compareKey(value: unknown, type: string | undefined): string | number | null {
  if (value == null) return null;
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
  }
  const s = String(value).trim();
  if (s === '') return null;
  if (type === 'date') return isoOf(s)?.slice(0, 10) ?? null;
  if (type === 'datetime') return isoOf(s);
  return s.toLowerCase();
}

/**
 * `YYYY-MM-DDTHH:mm:ss` in UTC, or the date alone when that is all there was.
 *
 * A date-only value is NOT put through `new Date(s)`: that parses as midnight
 * UTC, and west of Greenwich the round trip comes back a day early. The parts
 * are used as written — the classic date bug, avoided the same way
 * `renderer/util/local-datetime.ts` avoids it.
 */
function isoOf(s: string): string | null {
  if (DATE_ONLY.test(s)) return s;
  const naive = NAIVE.exec(s);
  if (naive && !ZONED.test(s)) return `${naive[1]}T${naive[2]}:${naive[3]}:${naive[4] ?? '00'}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

/**
 * Does `value` stand in relation `cmp` to `term`?
 *
 * False for a cell with no content, and for one whose key cannot be read: a
 * comparison against nothing is not an order relation, and the matcher's rule
 * is that an empty cell fails a positive test (and therefore passes its
 * negation, which the caller applies).
 *
 * On a `datetime` column a DATE-ONLY bound compares only the date part, so
 * `<=2026-08-01` covers all of that day rather than cutting at midnight — which
 * is what someone who typed a date meant.
 */
export function satisfiesCmp(value: unknown, term: string, cmp: FilterCmp, type: string | undefined): boolean {
  const bound = term.trim();
  if (bound === '') return false;
  const dateOnlyBound = type === 'datetime' && DATE_ONLY.test(bound);
  const keyType = dateOnlyBound ? 'date' : type;
  const a = compareKey(value, keyType);
  const b = compareKey(bound, keyType);
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  return order(a as string, b as string, cmp);
}

/**
 * The four operators, over any two already-comparable values.
 *
 * Generic because TypeScript refuses `<` between two `string | number` unions,
 * even once the caller has proved both sides have the same runtime type. The
 * caller's `as string` is a compile-time pin, not a conversion — two numbers
 * still compare as numbers at runtime.
 */
function order<T extends string | number>(a: T, b: T, cmp: FilterCmp): boolean {
  if (cmp === '>=') return a >= b;
  if (cmp === '<=') return a <= b;
  if (cmp === '>') return a > b;
  return a < b;
}
