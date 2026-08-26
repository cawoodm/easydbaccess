/**
 * Pure grid math for "Tile windows", plus the panel filter shared with
 * "Cascade windows". Kept free of the panel shell/DOM so it's directly
 * unit-testable — see `tile-layout.test.ts`.
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
 * Grid slot geometry for each of `count` panels laid out into `rect`, with
 * `gap` px between cells and around the outer edge. Returns one `Rect` per
 * index, in the same reading order `tileAllWindows` assigns panels to slots.
 */
export function tileSlots(count: number, rect: Rect, gap: number): Rect[] {
  return gridSlots(count, rect, gap, Math.ceil(Math.sqrt(count)));
}

/**
 * Every window side by side, each the full height of the visible area.
 *
 * "Tile" squares the grid up, which is what you want for a lot of windows and
 * not what you want for three tables you are reading across: those want columns.
 */
export function columnSlots(count: number, rect: Rect, gap: number): Rect[] {
  return gridSlots(count, rect, gap, count);
}

/** The same, stacked: every window full width, one under the other. */
export function rowSlots(count: number, rect: Rect, gap: number): Rect[] {
  return gridSlots(count, rect, gap, 1);
}

/**
 * `count` slots in `rect`, `cols` per row, `gap` px between cells and around the
 * outer edge. The one piece of arithmetic behind all three arrangements — they
 * differ only in how many columns they ask for.
 */
export function gridSlots(count: number, rect: Rect, gap: number, cols: number): Rect[] {
  if (count <= 0) return [];
  // A column count outside 1..count would put slots outside the rect (or divide
  // by zero). Every caller passes something sane; this keeps it that way.
  cols = Math.max(1, Math.min(Math.floor(cols) || 1, count));
  const rows = Math.ceil(count / cols);
  const cellW = (rect.w - gap * (cols + 1)) / cols;
  const cellH = (rect.h - gap * (rows + 1)) / rows;
  return Array.from({ length: count }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      x: rect.x + gap + col * (cellW + gap),
      y: rect.y + gap + row * (cellH + gap),
      w: cellW,
      h: cellH,
    };
  });
}
