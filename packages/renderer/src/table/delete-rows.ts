// packages/renderer/src/table/delete-rows.ts
//
// Deleting ROWS while keeping the table — the two data options behind the footer's
// trash button. Deleting the table itself is `window-mgr/table-window-manager.ts`.
//
// Kept out of the plugin so the counting and the chunking can be tested without a
// dialog, and so the one place that decides how much of a read a delete needs is
// the same module for both options.

import type { DataCollection, Row } from '@easydb/shared';
import { readRows, type RowRequest } from '../db/row-reader.js';

/**
 * Ids per `bulkRemove` call.
 *
 * One call with 609,283 keys is one transaction that neither reports progress nor
 * yields to the browser, so the tab looks hung for the whole delete. Chunking gives
 * up the thread between batches, which is what lets the progress bar move.
 */
export const DELETE_CHUNK = 5_000;

/** Told how far a delete has got, so a caller can drive a progress bar. */
export type DeleteProgress = (deleted: number, total: number) => void;

/** Remove rows by id, a chunk at a time. Returns how many went. */
export async function removeRowIds(coll: DataCollection<Row>, ids: string[], onProgress?: DeleteProgress): Promise<number> {
  for (let from = 0; from < ids.length; from += DELETE_CHUNK) {
    await coll.bulkRemove(ids.slice(from, from + DELETE_CHUNK));
    onProgress?.(Math.min(from + DELETE_CHUNK, ids.length), ids.length);
  }
  return ids.length;
}

/** Every row of the table. The table, its columns and its settings stay. */
export async function deleteAllRows(coll: DataCollection<Row>, onProgress?: DeleteProgress): Promise<number> {
  const rows = await coll.find();
  return removeRowIds(
    coll,
    rows.map((r) => r.id),
    onProgress,
  );
}

/**
 * The rows matching `req` — every match in the table, not the page on screen.
 *
 * "Visible" is the set the titlebar counts (`1,234/609,283`), so a windowed grid
 * showing 500 rows of a filtered table deletes all 1,234. Deleting the page would
 * be an action with no name the user could predict.
 *
 * The sort and the slice are dropped before the read. Neither changes WHICH rows
 * match, and a sort on a big table costs seconds in IndexedDB (there is no index
 * for a field inside `data`) — see `docs/tech/DATA-TABLE.md`. The read is uncapped
 * on purpose: `ROW_FETCH_CAP` protects a GRID from drawing too much, but a delete
 * that stopped at 20,000 would leave the rest behind and report success.
 */
export async function deleteVisibleRows(coll: DataCollection<Row>, req: RowRequest, onProgress?: DeleteProgress): Promise<number> {
  const { sort: _sort, offset: _offset, limit: _limit, countTotal: _countTotal, ...narrow } = req;
  const page = await readRows(coll, narrow, 0);
  return removeRowIds(
    coll,
    page.rows.map((r) => r.id),
    onProgress,
  );
}
