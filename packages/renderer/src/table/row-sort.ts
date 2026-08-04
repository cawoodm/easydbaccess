/**
 * Row sorting, by the grid's rules.
 *
 * Extracted from `data-table.ts` because a second caller now needs the SAME
 * order: `db/row-reader.ts` re-sorts in memory whenever the backing store could
 * not sort a query itself (a computed column, or a store with no `query` at
 * all). Two implementations of "how this app orders rows" would drift, and the
 * drift would show up as rows jumping when a table is opened one way rather
 * than another.
 */

import type { ColumnSpec, ColumnType, Row, SortSpec } from '@easydb/shared';

/**
 * One sort key applied to one pair of rows, direction included, so several keys
 * can be walked in priority order.
 *
 * Emptiness is ranked as the *smallest* value: null < blank < present. The rank
 * rides the direction flip, so ascending floats empties to the top (nulls first,
 * then blanks) and descending sinks them to the bottom. null and blank are
 * DISTINCT — a null cell is "no value" and sorts ahead of an empty string.
 */
export function compareBySortKey(av: unknown, bv: unknown, type: ColumnType, factor: number): number {
  const rank = (v: unknown): number => (v == null ? 0 : v === '' ? 1 : 2);
  const ar = rank(av);
  const br = rank(bv);
  if (ar !== 2 || br !== 2) return (ar - br) * factor;
  return compareValues(av, bv, type) * factor;
}

// Compares two PRESENT (non-empty) values by column type. Empty handling is
// the caller's job — `compareBySortKey` deals with blanks before this runs.
export function compareValues(a: unknown, b: unknown, type: ColumnType): number {
  switch (type) {
    case 'number': {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
      return na - nb;
    }
    case 'boolean':
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 'date': {
      const ta = new Date(String(a)).getTime();
      const tb = new Date(String(b)).getTime();
      if (Number.isNaN(ta) || Number.isNaN(tb)) return String(a).localeCompare(String(b));
      return ta - tb;
    }
    default:
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
}

/**
 * `rows` ordered by `specs`, most significant key first. Returns a new array;
 * an empty `specs` returns the input untouched, so callers can pass it blind.
 */
export function sortRowsBySpecs(rows: Row[], specs: readonly SortSpec[], columns: readonly ColumnSpec[]): Row[] {
  if (specs.length === 0) return rows;
  // Resolve each key's column type once, not per comparison.
  const keys = specs.map((s) => ({
    field: s.field,
    factor: s.asc ? 1 : -1,
    type: (columns.find((c) => c.field === s.field)?.type ?? 'string') as ColumnType,
  }));
  const arr = [...rows];
  arr.sort((a, b) => {
    // Walk the keys in order; the next one only speaks when the previous ties.
    for (const k of keys) {
      const cmp = compareBySortKey(a.data[k.field], b.data[k.field], k.type, k.factor);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  return arr;
}

/**
 * The sort keys of a table or view instance: the `sortBy` list when present,
 * else the single legacy `sortColumn`/`sortAsc` pair (a workspace written before
 * multi-sort, or a view whose sort bar still sets one column).
 */
export function readSortSpecs(rec: { sortBy?: SortSpec[] | undefined; sortColumn?: string | undefined; sortAsc?: boolean | undefined }): SortSpec[] {
  if (rec.sortBy?.length) return rec.sortBy.map((s) => ({ field: s.field, asc: s.asc !== false }));
  if (!rec.sortColumn) return [];
  return [{ field: rec.sortColumn, asc: rec.sortAsc !== false }];
}
