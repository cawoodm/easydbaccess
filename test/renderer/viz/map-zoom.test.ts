import { describe, expect, it } from 'vitest';
import { TILE_SIZE, WORLD_BOUNDS, wholeZoomFittingWidth, zoomFittingWidth } from '../../../packages/renderer/src/viz/elements/map-zoom.js';

/**
 * The floor that stops a map drawing the world twice.
 *
 * A web-mercator world is `256 * 2^zoom` pixels wide, so the zoom that fits a
 * pane exactly is `log2(width / 256)`. Below it there is room for a second copy,
 * and Leaflet fills that room by repeating the tiles.
 */

describe('zoomFittingWidth', () => {
  it('is 0 when the pane is exactly one tile wide — the whole world in 256px', () => {
    expect(zoomFittingWidth(TILE_SIZE)).toBe(0);
  });

  it('rises one zoom per doubling of the pane', () => {
    expect(zoomFittingWidth(512)).toBe(1);
    expect(zoomFittingWidth(1024)).toBe(2);
    expect(zoomFittingWidth(4096)).toBe(4);
  });

  it('is fractional in between, which is the point of asking', () => {
    // A 900px pane fits the world at 1.81; the whole zooms either side of that are
    // "world overflows the pane" (fine) and "world repeats" (the bug).
    expect(zoomFittingWidth(900)).toBeCloseTo(1.8138, 3);
  });

  it('never goes below 0, however narrow the pane', () => {
    // Zoom 0 is already the whole world in one tile; there is nothing further out.
    expect(zoomFittingWidth(120)).toBe(0);
    expect(zoomFittingWidth(1)).toBe(0);
  });

  it('answers 0 for a pane that has not been measured yet', () => {
    // A hidden or freshly created container. `-Infinity` would be the arithmetic
    // answer and an unusable minimum zoom.
    expect(zoomFittingWidth(0)).toBe(0);
    expect(zoomFittingWidth(Number.NaN)).toBe(0);
    expect(zoomFittingWidth(-10)).toBe(0);
  });

  it('takes another tile size, for a provider that does not use 256', () => {
    expect(zoomFittingWidth(512, 512)).toBe(0);
    expect(zoomFittingWidth(1024, 512)).toBe(1);
  });
});

/**
 * The floor the map actually uses. Whole, because `zoomSnap: 0` — what it takes to
 * reach a fractional one — also stops Leaflet rounding a wheel tick up to a full
 * level, and zooming in then crawls.
 */
describe('wholeZoomFittingWidth', () => {
  it('rounds the fitting zoom UP, never down', () => {
    // 1.81 → 2: at 2 the world is 1024px against a 900px pane, so it overflows.
    // Rounding down to 1 would leave 388px beside it for a second copy.
    expect(wholeZoomFittingWidth(900)).toBe(2);
    expect(wholeZoomFittingWidth(300)).toBe(1);
  });

  it('leaves an exact power of two alone', () => {
    expect(wholeZoomFittingWidth(256)).toBe(0);
    expect(wholeZoomFittingWidth(512)).toBe(1);
    expect(wholeZoomFittingWidth(1024)).toBe(2);
  });

  it('is never below 0, and never fractional', () => {
    for (const w of [0, 1, 120, 255, 256, 257, 900, 1920, 3840]) {
      const z = wholeZoomFittingWidth(w);
      expect(Number.isInteger(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(0);
    }
  });

  it('always covers the pane — the property the whole floor exists for', () => {
    for (const w of [120, 300, 640, 900, 1280, 1440, 1920, 2560, 3840]) {
      const worldPx = TILE_SIZE * 2 ** wholeZoomFittingWidth(w);
      expect(worldPx).toBeGreaterThanOrEqual(Math.max(w, TILE_SIZE));
    }
  });
});

describe('WORLD_BOUNDS', () => {
  it('spans the whole projected world, not a crop of it', () => {
    const [[south, west], [north, east]] = WORLD_BOUNDS;
    expect(west).toBe(-180);
    expect(east).toBe(180);
    // Web mercator runs out just short of the poles — beyond this the projection
    // goes to infinity, so this IS the whole map.
    expect(south).toBeCloseTo(-85.0511, 3);
    expect(north).toBeCloseTo(85.0511, 3);
  });
});
