// packages/renderer/src/search/column-filter.ts
//
// Per-column filter matching, shared by the table grid (live + faceted) and
// the read-only view windows. Pure and DOM-free so it's unit-testable.
//
// Semantics (case-insensitive):
//   • plain text        → substring match, as before.
//   • `!text`           → NOT substring — negates the match. Because a null or
//     empty cell never contains a non-empty term, `!true` on a boolean column
//     also surfaces the empty/null rows.
//   • `NULL`            → cell is null/undefined or (after trim) empty.
//   • `!NULL`           → cell has any non-empty value.
//   • `!` alone         → same as `!NULL` (cell has a value).
//   • empty query       → matches everything (no filter).
//
// `NULL` is matched as a whole token (case-insensitive), so a plain search for
// the literal text "null" inside a cell is intentionally not reachable — the
// null test wins.

/** Is a cell value considered empty/null for filtering purposes? */
function isNullish(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

/** Does `value` satisfy the per-column filter `rawQuery`? */
export function matchesColumnFilter(value: unknown, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (q === '') return true;

  let negate = false;
  let term = q;
  if (term.startsWith('!')) {
    negate = true;
    term = term.slice(1).trim();
  }

  // `NULL` token, or a lone `!` (read as "not null"): test emptiness directly.
  if (term.toUpperCase() === 'NULL' || term === '') {
    const nullish = isNullish(value);
    return negate ? !nullish : nullish;
  }

  const hit = String(value ?? '')
    .toLowerCase()
    .includes(term.toLowerCase());
  return negate ? !hit : hit;
}
