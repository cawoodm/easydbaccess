/**
 * Last known row count per table, kept on the device.
 *
 * A big table's size is not free to ask for. IndexedDB has no count that skips the
 * rows: measured 14.0 s on 609,283 of them, which is why a windowed read asks for
 * the page and lets the count arrive afterwards. That leaves the first seconds of
 * every open with no total to show, and a title reading `(500)` on a table of
 * 609,283 rows is not an unfinished answer but a wrong one.
 *
 * So the count is remembered once it has been paid for. Kept in `localStorage`
 * rather than on the `Table` record for two reasons: it is derived data, not part of
 * what a table IS, and a synced field rewritten after every count would push a
 * workspace revision for a number no other device needs.
 *
 * A remembered count can be STALE — rows written by another device, or by an import
 * that this tab did not see. It is used only where a provisional answer is already
 * the design: the title, and the guess about whether to window. The background count
 * that every load starts corrects it within seconds of being wrong.
 */

const KEY = 'easydb:rowcounts';

function read(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {}; // private mode, disabled storage, or a blob someone else wrote
  }
}

/** The last count remembered for `tableId`, or 0 when none is. */
export function cachedRowCount(tableId: string): number {
  const n = read()[tableId];
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Remember `count` for `tableId`. A no-op when it is already what we hold. */
export function rememberRowCount(tableId: string, count: number): void {
  if (!tableId || !Number.isFinite(count) || count < 0) return;
  const all = read();
  if (all[tableId] === count) return;
  all[tableId] = Math.floor(count);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* out of quota or no storage — the count is a cache, so losing it costs a title */
  }
}

/** Drop a table's remembered count, for when the table itself goes. */
export function forgetRowCount(tableId: string): void {
  const all = read();
  if (!(tableId in all)) return;
  delete all[tableId];
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* see rememberRowCount */
  }
}
