// packages/renderer/src/search/searchable-columns.ts
//
// Which columns a free-text search may look in.
//
// `ColumnSpec.filterable === false` is the explicit answer, set by the ⚲ box in
// the columns editor. This module adds the one case the app can work out for
// itself: a SCRIPTED column that stores nothing.
//
// A scripted column's value is computed from the row at render time and never
// written back, so `row.data[field]` is empty for every row. Searching it can
// only ever match nothing — while the grid plainly SHOWS the value the user is
// searching for. That is the whole defect: the column offers a funnel and a
// `field:value` term, and both silently fail.
//
// Derived rather than stored: writing `filterable: false` onto the column would
// be a guess frozen into the model, and it would be wrong the moment the column
// does hold data (a column that carried values before a script was added to it,
// or an import that filled it). Recomputed per read, it corrects itself — and an
// explicit `filterable: false` still wins, because that is the user's own answer.

import type { ColumnSpec, Row } from '@easydb/shared';

/** Does any row hold a non-empty value for `field`? */
export function hasStoredData(rows: readonly Row[], field: string): boolean {
  return rows.some((r) => {
    const v = r.data[field];
    return v != null && v !== '';
  });
}

/**
 * True when this column is scripted AND no row stores anything for it — so a
 * search over it would scan empties and match nothing.
 *
 * With NO rows to look at the answer is `false`: an empty table (or a read that
 * has not landed yet) is not evidence that the column is empty, and quietly
 * dropping a column from search on no evidence is the worse mistake.
 */
export function isComputedOnly(col: ColumnSpec, rows: readonly Row[]): boolean {
  if (!col.script?.trim()) return false;
  if (rows.length === 0) return false;
  return !hasStoredData(rows, col.field);
}

/**
 * The columns a free-text search should look in: everything the user has not
 * flagged unfilterable, minus the computed-only ones.
 */
export function searchableColumns(columns: readonly ColumnSpec[], rows: readonly Row[]): ColumnSpec[] {
  return columns.filter((c) => c.filterable !== false && !isComputedOnly(c, rows));
}
