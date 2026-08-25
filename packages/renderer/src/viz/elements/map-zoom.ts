// packages/renderer/src/viz/elements/map-zoom.ts
//
// How far out a map may zoom.
//
// A web-mercator world is a SQUARE of `tileSize * 2^zoom` pixels, and a pane is
// almost never square. So "the whole world in view" is decided by the pane's
// SHORTER side: the world fits when it fits that, and the longer side is left with
// padding on both ends. A docked pane 900 by 200 shows the whole world at 128px
// with grey either side of it, which is the honest picture — 200px cannot hold
// more world than that.
//
// Two things this is NOT:
//
//  - It is not the zoom that FILLS the pane. That was the rule until v0.0.425, and
//    it meant the world could never be seen whole in anything but a square pane:
//    the floor stopped where the world was as WIDE as the pane, which on a short
//    pane crops the poles and on a tall one crops the edges.
//  - It is not what stops the world repeating. `noWrap` on the tile layer does
//    that, at every zoom, so zooming further out cannot bring a second copy of
//    Africa back — see `point-map.ts`.
//
// Pure, so the arithmetic is testable without Leaflet, a DOM or a network.

/** Web-mercator tile edge in CSS pixels — Leaflet's default. */
export const TILE_SIZE = 256;

/**
 * How far down the floor may go, however small the pane.
 *
 * The world is 16px at this zoom. A pane too small to hold that is too small to
 * hold a map, and an unbounded floor would hand Leaflet `2^-30` scale factors from
 * a pane that is one pixel tall mid-layout. The tile layer's own `minZoom` has to
 * be set this low too, or it draws no tiles at all below its default of 0.
 */
export const MIN_WORLD_ZOOM = -4;

/**
 * The zoom at which the whole world exactly fills the pane's shorter side.
 * Usually fractional, and often negative — a pane shorter than one tile holds the
 * whole world only below zoom 0.
 *
 * A pane with no size yet — hidden, or not laid out — answers 0 rather than
 * `-Infinity`, so a map built before layout still has a usable floor.
 */
export function zoomShowingWorld(widthPx: number, heightPx: number, tileSize: number = TILE_SIZE): number {
  const shortest = Math.min(widthPx, heightPx);
  if (!Number.isFinite(shortest) || shortest <= 0) return 0;
  return Math.log2(shortest / tileSize);
}

/**
 * The floor the map actually uses: the LARGEST whole zoom at which the whole world
 * still fits.
 *
 * Rounded DOWN, because rounding up is the one direction that breaks the promise —
 * at `ceil` the world is wider than the pane's short side and part of it is off
 * screen. One step above this floor the world always overflows, so this is the
 * furthest out worth going: below it the world only shrinks inside a frame that
 * already held all of it.
 *
 * It is a whole number because Leaflet only holds a fractional minimum with
 * `zoomSnap: 0`, and that option does not just relax the bound — it changes how far
 * one wheel tick moves. With the default snap of 1, `Math.ceil(d3 / snap) * snap`
 * rounds every tick up to a full level; with 0 the raw sigmoid gets through and a
 * trackpad flick moved about an eighth of a level (v0.0.421).
 */
export function wholeZoomShowingWorld(widthPx: number, heightPx: number, tileSize: number = TILE_SIZE): number {
  return Math.max(MIN_WORLD_ZOOM, Math.floor(zoomShowingWorld(widthPx, heightPx, tileSize)));
}

/**
 * The world, as far as web mercator draws it.
 *
 * ±85.051129° is where the projection runs out — the poles are at infinity — so
 * this is the whole map, not a crop of it. Used as `maxBounds`, which also does the
 * padding: when the world is smaller than the pane Leaflet centres it inside the
 * bounds rather than letting it be dragged into a corner.
 */
export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-85.05112878, -180],
  [85.05112878, 180],
];
