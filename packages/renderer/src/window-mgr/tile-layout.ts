/**
 * Pure grid math for the three arrangements — "Tile windows", "Arrange in
 * columns" and "Arrange in rows" — plus the panel filter they share with
 * "Cascade windows". Kept free of the panel shell/DOM so it is directly
 * unit-testable; see `tile-layout.test.ts`.
 */

export interface ArrangeCandidate {
  status: string;
}

/**
 * Panels eligible to be cascaded/tiled. A minimized panel is deliberately
 * parked by the user (e.g. to keep a large table's data out of memory — see
 * the `?minimize` boot flag) and must not be forced back to normalized, nor
 * occupy a layout slot: both commands used to run over EVERY panel, which
 * un-minimized minimized windows and inflated the tile grid with empty holes
 * for windows that were never shown. `smallified` (the collapsed-header-only
 * state) stays on screen, so it IS still laid out.
 */
export function eligibleForArrange<T extends ArrangeCandidate>(panels: T[]): T[] {
  return panels.filter((p) => p.status !== 'minimized');
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The smallest cell either arrangement will produce.
 *
 * Enough for a title bar and its buttons. Without a floor, `count` past what the
 * rect can hold makes the arithmetic go negative, and a negative width is not a
 * small window — it is an invalid style the browser drops. Twenty windows in
 * columns across a laptop screen therefore overlap rather than vanish.
 */
export const MIN_CELL = 80;

/**
 * Slot geometry for a `cols` × `rows` grid inside `rect`, with `gap` px between
 * cells and around the outer edge. Filled in reading order — left to right, then
 * down — which is the order every caller assigns panels in.
 *
 * The one implementation behind all three arrangements: a tile is a square-ish
 * grid, a column is one row of `count`, a row is one column of `count`.
 */
export function gridSlots(count: number, rect: Rect, gap: number, cols: number, rows: number): Rect[] {
  if (count <= 0) return [];
  const across = Math.max(1, cols);
  const down = Math.max(1, rows);
  const cellW = Math.max(MIN_CELL, (rect.w - gap * (across + 1)) / across);
  const cellH = Math.max(MIN_CELL, (rect.h - gap * (down + 1)) / down);
  return Array.from({ length: count }, (_, i) => ({
    x: rect.x + gap + (i % across) * (cellW + gap),
    y: rect.y + gap + Math.floor(i / across) * (cellH + gap),
    w: cellW,
    h: cellH,
  }));
}

/**
 * A square-ish grid: as many columns as the square root of the count, rounded up.
 * What "Tile windows" has always done.
 */
export function tileSlots(count: number, rect: Rect, gap: number): Rect[] {
  const cols = Math.ceil(Math.sqrt(count));
  return gridSlots(count, rect, gap, cols, Math.ceil(count / cols));
}

/**
 * One column each, side by side across the rect, every one full height.
 *
 * For comparing tables column-for-column, which a square grid cannot do — half
 * the windows end up on a second row where nothing lines up.
 */
export function columnSlots(count: number, rect: Rect, gap: number): Rect[] {
  return gridSlots(count, rect, gap, count, 1);
}

/** One row each, stacked down the rect, every one full width. The other axis. */
export function rowSlots(count: number, rect: Rect, gap: number): Rect[] {
  return gridSlots(count, rect, gap, 1, count);
}
