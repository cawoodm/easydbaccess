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

/** Squared distance between two rect centers. Squared is enough to compare. */
function moveCost(a: Rect, b: Rect): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return dx * dx + dy * dy;
}

/**
 * Which slot each window should take, so that the windows move as little as
 * possible.
 *
 * The slots come out in reading order, and the arrangements used to hand them
 * out in panel order — which is the stacking order. So a user who had already
 * built a grid by hand, and then ran "Tile windows" to line it up, got the whole
 * layout shuffled: every window landed in a slot chosen by how recently it was
 * touched, not by where it already was. The tidy grid was correct and unusable.
 *
 * `current[i]` is where window `i` is now. The result maps the same index to an
 * index in `slots`. A window with no slot gets `-1`, which only happens if the
 * caller passes fewer slots than windows.
 *
 * Two passes, both cheap at these counts (a workspace has tens of windows, not
 * thousands):
 *
 * 1. Greedy — take the closest window/slot pair that is still free, over and
 *    over. Ties break on the lower index, so the result never depends on the
 *    sort being stable.
 * 2. Swap — exchange any two windows whose slots are better the other way
 *    round, until no exchange helps. This repairs the one thing greedy gets
 *    wrong: an early pair takes a slot that a later pair needed more.
 */
export function nearestSlots(current: readonly Rect[], slots: readonly Rect[]): number[] {
  const taken: number[] = current.map(() => -1);
  const pairs: { i: number; j: number; cost: number }[] = [];
  for (let i = 0; i < current.length; i++) {
    for (let j = 0; j < slots.length; j++) pairs.push({ i, j, cost: moveCost(current[i]!, slots[j]!) });
  }
  pairs.sort((a, b) => a.cost - b.cost || a.i - b.i || a.j - b.j);

  const usedSlot = new Set<number>();
  for (const pair of pairs) {
    if (taken[pair.i] !== -1 || usedSlot.has(pair.j)) continue;
    taken[pair.i] = pair.j;
    usedSlot.add(pair.j);
  }

  // Bounded by the window count: one full sweep with no swap ends it, and each
  // swap strictly lowers the total, so it cannot cycle.
  for (let sweep = 0; sweep < current.length; sweep++) {
    let swapped = false;
    for (let a = 0; a < current.length; a++) {
      for (let b = a + 1; b < current.length; b++) {
        const sa = taken[a]!;
        const sb = taken[b]!;
        if (sa === -1 || sb === -1) continue;
        const now = moveCost(current[a]!, slots[sa]!) + moveCost(current[b]!, slots[sb]!);
        const swap = moveCost(current[a]!, slots[sb]!) + moveCost(current[b]!, slots[sa]!);
        if (swap < now) {
          taken[a] = sb;
          taken[b] = sa;
          swapped = true;
        }
      }
    }
    if (!swapped) break;
  }
  return taken;
}
