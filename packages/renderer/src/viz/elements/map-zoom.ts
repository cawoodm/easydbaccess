// packages/renderer/src/viz/elements/map-zoom.ts
//
// How far out a map may zoom before it starts repeating itself.
//
// A web-mercator world is `tileSize * 2^zoom` pixels wide, so a pane wider than
// that has room for more than one copy of it — and Leaflet fills that room by
// repeating the tiles. `noWrap` stops the repetition but leaves the world adrift
// in empty space instead. The answer to both is a floor on the zoom: never go out
// past the point where the world is exactly as wide as the pane.
//
// Pure, so the arithmetic is testable without Leaflet, a DOM or a network.

/** Web-mercator tile edge in CSS pixels — Leaflet's default. */
export const TILE_SIZE = 256;

/**
 * The zoom at which the whole world is exactly `widthPx` wide. Usually fractional.
 *
 * A pane with no width yet — a hidden or unmeasured container — answers 0 rather
 * than `-Infinity`, so a map built before layout still has a usable floor.
 */
export function zoomFittingWidth(widthPx: number, tileSize: number = TILE_SIZE): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0;
  return Math.max(0, Math.log2(widthPx / tileSize));
}

/**
 * The same floor, rounded UP to a whole zoom — which is the one the map uses.
 *
 * Rounding up keeps the guarantee: at `ceil(fit)` the world is `256 * 2^ceil(fit)`
 * wide, which is at least the pane, so there is no room beside it for a second
 * copy. Rounding down would leave exactly that room.
 *
 * It is whole because the alternative cost more than it bought. Leaflet only holds
 * a fractional minimum with `zoomSnap: 0`, and that option does not just relax the
 * bound — it changes how far one wheel tick moves. With the default snap of 1,
 * `Math.ceil(d3 / snap) * snap` rounds every tick up to a full level; with 0 the
 * raw sigmoid gets through, and a trackpad flick that used to move one level moved
 * about an eighth of one. Zooming in felt broken. So the map snaps to whole zooms
 * as it always did, and stops one whole step short of repeating the world.
 */
export function wholeZoomFittingWidth(widthPx: number, tileSize: number = TILE_SIZE): number {
  return Math.ceil(zoomFittingWidth(widthPx, tileSize));
}

/**
 * The world, as far as web mercator draws it.
 *
 * ±85.051129° is where the projection runs out — the poles are at infinity — so
 * this is the whole map, not a crop of it. Used as `maxBounds` so panning cannot
 * drift off into the grey beside a world that no longer repeats.
 */
export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-85.05112878, -180],
  [85.05112878, 180],
];
