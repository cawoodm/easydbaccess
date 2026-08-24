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
 * The zoom at which the whole world is exactly `widthPx` wide.
 *
 * Fractional on purpose: a map that snaps to whole zooms has to choose between
 * one step in (the world overflows the pane, which is fine) and one step out (the
 * world repeats, which is the bug). Leaflet reaches a fractional bound only with
 * `zoomSnap: 0`, which is why the element sets it.
 *
 * A pane with no width yet — a hidden or unmeasured container — answers 0 rather
 * than `-Infinity`, so a map built before layout still has a usable floor.
 */
export function zoomFittingWidth(widthPx: number, tileSize: number = TILE_SIZE): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0;
  return Math.max(0, Math.log2(widthPx / tileSize));
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
