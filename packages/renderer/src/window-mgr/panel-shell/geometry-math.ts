/**
 * Pure drag/resize math for the panel shell. Deltas are divided by the canvas
 * scale because panels live inside the pan/zoom-transformed viewport: a 30px
 * pointer move over a 2x-zoomed canvas is a 15px move in layout coordinates.
 * (jsPanel ignored this — dragging while zoomed drifted off the cursor.)
 * Positions are NOT clamped; off-screen geometry is a feature (see WINDOWS.md).
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every resizable edge and corner, in the order the shell creates its zones. */
export const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

export type Edge = (typeof EDGES)[number];

export function dragRect(start: Rect, dx: number, dy: number, scale: number): Rect {
  const s = scale > 0 ? scale : 1;
  return { ...start, x: start.x + dx / s, y: start.y + dy / s };
}

export function resizeRect(
  start: Rect,
  edge: Edge,
  dx: number,
  dy: number,
  scale: number,
  minW: number,
  minH: number,
): Rect {
  const s = scale > 0 ? scale : 1;
  const ddx = dx / s;
  const ddy = dy / s;
  let { x, y, w, h } = start;
  if (edge.includes('e')) w = Math.max(minW, start.w + ddx);
  if (edge.includes('s')) h = Math.max(minH, start.h + ddy);
  if (edge.includes('w')) {
    w = Math.max(minW, start.w - ddx);
    x = start.x + (start.w - w);
  }
  if (edge.includes('n')) {
    h = Math.max(minH, start.h - ddy);
    y = start.y + (start.h - h);
  }
  return { x, y, w, h };
}
