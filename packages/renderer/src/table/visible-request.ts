// packages/renderer/src/table/visible-request.ts
//
// What "visible" currently means in one table window, published for the buttons
// that act on it — today the footer's "Delete Visible Data".
//
// A table's per-column FILTERS live on its record, so a caller could read them
// from the store. Its SEARCH does not: the header box and the panel box are live
// UI state, and a delete that ignored them would take rows the user cannot see.
// Only the grid holds the whole picture, so the grid publishes it here — the same
// arrangement as the counts it publishes through `window-mgr/panel-title.ts`, and
// for the same reason.
//
// In memory only, and never keyed by a view instance: a view is a read-only lens
// over a table and has no delete button.

import type { RowRequest } from '../db/row-reader.js';

const requests = new Map<string, RowRequest>();

/** Publish the request a table's grid is currently answering, unsliced. */
export function rememberRowRequest(tableId: string, req: RowRequest): void {
  if (!tableId) return;
  requests.set(tableId, req);
}

/** The last request published for `tableId`, or undefined if its grid never ran. */
export function rowRequestOf(tableId: string): RowRequest | undefined {
  return requests.get(tableId);
}

/** Drop a table's request — its window closed, or the table went. */
export function forgetRowRequest(tableId: string): void {
  requests.delete(tableId);
}

/**
 * Does this request show LESS than the whole table?
 *
 * A sort and a slice are not narrowing: they change the order and the page, not
 * which rows match. So "Delete Visible Data" is only a different action from
 * "Delete All Data" when a filter or a search is on, and the footer offers it only
 * then — two options that delete the same rows are worse than one.
 */
export function narrowsRows(req: RowRequest | undefined): boolean {
  if (!req) return false;
  if ((req.search ?? '').trim() !== '') return true;
  return Object.values(req.filters ?? {}).some((q) => q != null && q.trim() !== '');
}
