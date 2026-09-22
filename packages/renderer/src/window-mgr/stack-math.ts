// packages/renderer/src/window-mgr/stack-math.ts
//
// The arithmetic behind a docked pane's height. Pure, so vitest can check the
// decisions a pointer drag makes without a pointer — the same split
// `panel-shell/geometry-math.ts` and `window-mgr/geometry.ts` already use.
//
// One rule drives all of it: **the primary content must never be squeezed out.**
// A grid with two charts docked above it can end up with no room at all, and a
// window showing only its decorations reads as a bug. So a pane's height is
// clamped against what the other panes have already taken plus a floor for the
// grid, rather than against the container alone.

/** Smallest useful pane. Below this a chart is a coloured smear. */
export const MIN_PANE_H = 48;
/** Smallest useful primary area — about a header plus two grid rows. */
export const MIN_PRIMARY_H = 80;

/**
 * The height a pane may actually have.
 *
 * `available` is the stack's inner height; `otherPanes` is the total height of
 * every OTHER pane (splitters included by the caller, since their size is a CSS
 * concern). Returns at least `MIN_PANE_H` even when that overflows — a container
 * too short for its panes is the user's next resize to fix, and silently
 * collapsing a pane to zero hides the fact that it is there at all.
 */
export function clampPaneSize(requested: number, available: number, otherPanes: number, minPrimary = MIN_PRIMARY_H): number {
  const room = available - otherPanes - minPrimary;
  if (!Number.isFinite(requested)) return MIN_PANE_H;
  return Math.max(MIN_PANE_H, Math.min(Math.round(requested), Math.max(MIN_PANE_H, Math.round(room))));
}

/**
 * A pane's new height mid-drag.
 *
 * `dy` is the pointer delta in px. The sign flips with the edge: dragging a
 * splitter DOWN grows a pane docked above it and shrinks one docked below,
 * because the splitter sits between the pane and the primary content in both
 * cases but the pane is on the other side of it.
 */
export function resizedPaneSize(startSize: number, dy: number, edge: 'above' | 'below', available: number, otherPanes: number, minPrimary = MIN_PRIMARY_H): number {
  const delta = edge === 'above' ? dy : -dy;
  return clampPaneSize(startSize + delta, available, otherPanes, minPrimary);
}

/**
 * Shrink panes to fit a container that got shorter, by capping the tall ones.
 *
 * Two tempting approaches are both wrong. **Proportional** shrinking takes room
 * from a 50px pane that has none to give while a 300px one keeps most of its own.
 * **Taking the whole excess off the largest** floors that pane while its
 * neighbour keeps nearly everything — two 300px panes in a 400px window became
 * 48 and 272, which is not "shrink to fit", it is "delete one".
 *
 * So: find the tallest cap every pane can be held to that still fits, and cap
 * each pane at it. Panes already shorter than the cap are untouched — a small
 * pane never pays for a big one — and equally tall panes end up equal. That is
 * "keep every pane usable for as long as possible" actually implemented.
 */
export function fitPanes(sizes: readonly number[], available: number, minPrimary = MIN_PRIMARY_H): number[] {
  const want = sizes.map((s) => Math.max(MIN_PANE_H, Math.round(s)));
  if (want.length === 0) return want;
  const budget = Math.round(available - minPrimary);
  const totalAtFloor = MIN_PANE_H * want.length;
  // Not even the floors fit: hand back the floors. The window is too short for
  // what is docked in it, which is a resize away from fixed either way.
  if (budget <= totalAtFloor) return want.map(() => MIN_PANE_H);
  if (want.reduce((a, b) => a + b, 0) <= budget) return want;

  const capped = (cap: number): number => want.reduce((sum, s) => sum + Math.min(s, cap), 0);
  // `capped` is monotonic in `cap`, so binary-search the largest cap that fits.
  let lo = MIN_PANE_H;
  let hi = Math.max(...want);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (capped(mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return want.map((s) => Math.min(s, lo));
}

/** Panes on one edge, in display order. Stable for equal `order` values. */
export function orderPanes<T extends { order: number }>(panes: readonly T[]): T[] {
  return [...panes]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.order - b.p.order || a.i - b.i)
    .map(({ p }) => p);
}

// -- rows of panes ---------------------------------------------------------

/** Narrowest useful pane in a row. Below this a chart has no room for an axis. */
export const MIN_PANE_W = 80;

/** What the row maths needs off a pane. `row`/`weight` absent ⇒ the old layout. */
export interface RowMember {
  order: number;
  row?: number | undefined;
  weight?: number | undefined;
}

/**
 * Which row a pane is in.
 *
 * `row` absent falls back to `order`, which is the whole of the compatibility
 * story: before panes could share a row, `order` WAS the row index, so a dock
 * written by an older version groups into one pane per row and nothing changes
 * on screen.
 */
export function rowOf(p: RowMember): number {
  return p.row ?? p.order;
}

/**
 * Panes on one edge, grouped into rows and ordered within each.
 *
 * Rows come back in ascending row index and are RENUMBERED as they are grouped —
 * the caller gets a dense list, so a gap left by a pane that moved away does not
 * become an empty band. The row index a pane carries is therefore a sort key, not
 * a coordinate, which is what makes the moves in `viz-dock.ts` able to insert
 * between two rows with a fraction.
 */
export function paneRows<T extends RowMember>(panes: readonly T[]): T[][] {
  const byRow = new Map<number, T[]>();
  for (const p of panes) {
    const key = rowOf(p);
    const list = byRow.get(key);
    if (list) list.push(p);
    else byRow.set(key, [p]);
  }
  return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => orderPanes(list));
}

/**
 * The flex weights for one row, normalised.
 *
 * A pane with no weight of its own takes an equal share of what the weighted
 * panes have left, so a row that nobody has dragged divides evenly and a row
 * where one pane was dragged keeps the others equal to each other. Weights are
 * floored, because `flex-grow: 0` is a pane of no width at all and a pane the
 * user cannot see is one they cannot get back.
 */
export function rowWeights(panes: readonly RowMember[]): number[] {
  if (panes.length === 0) return [];
  const each = 1 / panes.length;
  const raw = panes.map((p) => (typeof p.weight === 'number' && Number.isFinite(p.weight) && p.weight > 0 ? p.weight : each));
  const total = raw.reduce((a, b) => a + b, 0);
  if (total <= 0) return panes.map(() => each);
  return raw.map((w) => w / total);
}

/**
 * Move width between two neighbours in a row, and only those two.
 *
 * `dx` is the pointer delta in px and `width` the row's inner width. The pair's
 * combined share is fixed, so the rest of the row does not reflow under a drag —
 * dragging one splitter must not shuffle a pane three columns away.
 *
 * Both sides are held at `MIN_PANE_W`, expressed as a share of the row, so a
 * drag past the end stops rather than collapsing a pane to nothing.
 */
export function resizedRowWeights(left: number, right: number, dx: number, width: number): [number, number] {
  const pair = left + right;
  if (!(width > 0) || !(pair > 0) || !Number.isFinite(dx)) return [left, right];
  const floor = Math.min(MIN_PANE_W / width, pair / 2);
  const wantLeft = left + dx / width;
  const nextLeft = Math.max(floor, Math.min(pair - floor, wantLeft));
  return [nextLeft, pair - nextLeft];
}
