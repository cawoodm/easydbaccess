/**
 * Pure grid math for "Tile windows", plus the panel filter shared with
 * "Cascade windows". Kept free of jsPanel/DOM so it's directly
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
 * for windows that were never shown. `smallified` (jsPanel's collapsed-header
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
  if (count <= 0) return [];
  const cols = Math.ceil(Math.sqrt(count));
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
