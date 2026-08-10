// packages/renderer/src/table/table-loading.ts
//
// The signal that puts a progress bar on ONE table's grid from outside it, and
// the record of which tables are currently loading.
//
// The record is the point. An importer that creates many tables writes the table
// records first, so all the windows appear together, and only then fills them one
// at a time. The window for table 12 therefore mounts LONG after the importer
// said "table 12 is loading", and an event alone is gone by then — the grid
// listened too late and showed nothing, which reads as "empty table", not
// "waiting its turn". So the state is kept here and a grid reads it on mount.
//
// Separate from `data-table.ts` so a reporter does not import Lit, and so the
// state can be asserted in a plain Node test.

export const TABLE_LOADING_EVENT = 'easydb:table-loading';

export interface TableLoadingDetail {
  tableId: string;
  loading: boolean;
  /** 0..1 when known. Absent ⇒ indeterminate: started, nothing measurable yet. */
  progress?: number | undefined;
}

/** Tables loading right now → their last reported fraction (null = indeterminate). */
const loadingTables = new Map<string, number | null>();

/**
 * Toggle the progress bar on the window for `tableId` from outside the grid.
 * An importer shows the window (an empty table record) immediately, calls this
 * with `true`, fetches rows in the background, then calls it with `false` once
 * the rows have landed — so the user sees the window + a progress bar before
 * any data arrives.
 */
export function setTableLoading(tableId: string, loading: boolean, progress?: number): void {
  if (!tableId) return;
  if (loading) loadingTables.set(tableId, typeof progress === 'number' ? progress : null);
  else loadingTables.delete(tableId);
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent<TableLoadingDetail>(TABLE_LOADING_EVENT, { detail: { tableId, loading, progress } }));
}

/**
 * What a grid mounting now should show: the fraction (null ⇒ indeterminate), or
 * `undefined` when this table is not loading at all.
 */
export function tableLoadingState(tableId: string): number | null | undefined {
  if (!loadingTables.has(tableId)) return undefined;
  return loadingTables.get(tableId) ?? null;
}
