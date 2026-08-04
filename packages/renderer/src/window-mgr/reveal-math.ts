// Panning the canvas so a window is actually on screen.
//
// "Go to <table>" and Open on a view used to front a window and stop there. A
// window sitting outside the panned/zoomed viewport, or off the canvas edge,
// stayed invisible — the command read as doing nothing at all.
//
// Panning is the right answer rather than MOVING the window: geometry is
// persisted, so a "go to" that relocated the window would quietly dismantle a
// layout the user arranged.
//
// Pure, so the arithmetic is unit-tested without a canvas.

import type { PanZoomState } from './panzoom.js';

/** A panel's box in CANVAS coordinates (what `windowGeometry` stores). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Keep this much space between the window and the edge of the visible area. */
export const REVEAL_MARGIN = 12;

/**
 * The canvas transform that brings `rect` into the `viewW`×`viewH` visible area,
 * or null when it is already fully visible (so a "go to" on a window the user is
 * looking at does not jump the canvas by a pixel).
 *
 * `scale` is never changed: the user's zoom is their choice, and the caller only
 * asked to see a window. A window bigger than the viewport is pinned by its
 * top-left corner — that is where its titlebar is, the only handle it has.
 */
export function panToReveal(state: PanZoomState, rect: Rect, viewW: number, viewH: number, margin = REVEAL_MARGIN): PanZoomState | null {
  const x = axis(state.x, rect.x, rect.w, viewW, state.scale, margin);
  const y = axis(state.y, rect.y, rect.h, viewH, state.scale, margin);
  if (x === state.x && y === state.y) return null;
  return { ...state, x, y };
}

/**
 * One axis of {@link panToReveal}. The screen position of the rect's near edge is
 * `pos * scale + offset`; solve for the offset that puts the whole span inside
 * `[margin, view - margin]`, moving as little as possible.
 */
function axis(offset: number, pos: number, size: number, view: number, scale: number, margin: number): number {
  const near = pos * scale + offset;
  const span = size * scale;
  const far = near + span;
  const room = view - margin * 2;
  // Too big to fit: show the near edge (titlebar / left border) and let the rest
  // run off. Centring it would push the titlebar off the top. Already covering
  // the visible area edge to edge ⇒ nothing to do.
  if (span >= room) {
    const covers = near <= margin && far >= view - margin;
    return covers ? offset : margin - pos * scale;
  }
  if (near < margin) return margin - pos * scale;
  if (far > view - margin) return view - margin - span - pos * scale;
  return offset;
}
