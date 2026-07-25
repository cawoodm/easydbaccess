// packages/renderer/src/window-mgr/panel-title.ts
//
// Shared helpers for the row-count suffix shown in panel titlebars — used by
// both the table window manager (`jspanel-manager.ts`) and the view window
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

/** Dispatch a visible-count update for a table/view window title to pick up. */
export function emitVisibleCount(key: string, count: number, total: number): void {
  if (!key) return;
  document.dispatchEvent(
    new CustomEvent<VisibleCountDetail>(VISIBLE_COUNT_EVENT, {
      detail: { key, count, total },
    }),
  );
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
