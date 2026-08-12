// packages/renderer/src/window-mgr/panel-title.ts
//
// Shared helpers for the row-count suffix shown in panel titlebars — used by
// both the table window manager (`table-window-manager.ts`) and the view window
// manager (`view-window-manager.ts`) so tables and views format their counts
// identically.

/** Detail of the `easydb:visible-count` document event. */
export interface VisibleCountDetail {
  /** Table id (table window) or view-instance id (view window). */
  key: string;
  /** Rows currently visible after filters + search. */
  count: number;
  /** Total rows in the underlying table (before filters/search). */
  total: number;
}

export const VISIBLE_COUNT_EVENT = 'easydb:visible-count';

/**
 * The last count emitted per key, so a listener that mounts late still has one.
 *
 * The event only fires when the numbers change, so a panel footer built after its
 * grid settled would otherwise wait for the next write to learn anything. Same
 * reason `tableLoadingState` keeps the loading flags.
 */
const lastCount = new Map<string, VisibleCountDetail>();

/** Dispatch a visible-count update for a table/view window title to pick up. */
export function emitVisibleCount(key: string, count: number, total: number): void {
  if (!key) return;
  const detail: VisibleCountDetail = { key, count, total };
  lastCount.set(key, detail);
  document.dispatchEvent(new CustomEvent<VisibleCountDetail>(VISIBLE_COUNT_EVENT, { detail }));
}

/** The most recent count for `key`, or undefined if none has been emitted. */
export function visibleCountOf(key: string): VisibleCountDetail | undefined {
  return lastCount.get(key);
}

/**
 * Row-count suffix for a panel title: `" (12)"` when nothing is filtered, or
 * `" (3/12)"` when a search/filter has narrowed the set. Empty string until a
 * count is known (negative sentinel), so the bare name shows meanwhile.
 */
export function countSuffix(count: number, total: number): string {
  if (count < 0 || total < 0) return '';
  return count === total ? ` (${total})` : ` (${count}/${total})`;
}

/** Detail of the `easydb:import-progress` document event. */
export interface ImportProgressDetail {
  tableId: string;
  rows: number;
  total: number;
  done?: boolean;
}

export const IMPORT_PROGRESS_EVENT = 'easydb:import-progress';

/**
 * Progress suffix while a table's rows are being imported: `" (120,000/609,283
 * · 20%)"`. It replaces the row-count suffix for the duration, because during an
 * import the count IS the progress — and it shows on a minimized window too,
 * since a titlebar is all a minimized window has.
 */
export function importSuffix(rows: number, total: number): string {
  if (total <= 0) return ` (${rows.toLocaleString()})`;
  const pct = Math.min(100, Math.round((rows / total) * 100));
  return ` (${rows.toLocaleString()}/${total.toLocaleString()} · ${pct}%)`;
}
