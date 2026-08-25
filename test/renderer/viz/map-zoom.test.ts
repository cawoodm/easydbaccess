import { describe, expect, it } from 'vitest';
import { MIN_WORLD_ZOOM, TILE_SIZE, WORLD_BOUNDS, wholeZoomShowingWorld, zoomShowingWorld } from '../../../packages/renderer/src/viz/elements/map-zoom.js';

/**
 * The floor that decides how far out a map may go.
 *
 * The world is a SQUARE of `256 * 2^zoom` pixels and a pane is not, so the whole
 * world is in view only when it fits the pane's SHORTER side. The longer side is
 * padded. Fitting the WIDTH — the rule until v0.0.425 — can never show the world
 * whole in anything but a square pane.
 */

/** The world's edge in pixels at a zoom, which is what every claim here is about. */
const worldPx = (zoom: number, tile = TILE_SIZE) => tile * 2 ** zoom;

describe('zoomShowingWorld', () => {
  it('is 0 when the shorter side is exactly one tile', () => {
    expect(zoomShowingWorld(TILE_SIZE, TILE_SIZE)).toBe(0);
    // A wide pane is still decided by its height.
    expect(zoomShowingWorld(4096, TILE_SIZE)).toBe(0);
  });

  it('rises one zoom per doubling of the shorter side', () => {
    expect(zoomShowingWorld(512, 512)).toBe(1);
    expect(zoomShowingWorld(4096, 1024)).toBe(2);
  });

  it('reads the shorter side whichever one it is', () => {
    // A tall narrow pane and a short wide one of the same measure answer the same.
    expect(zoomShowingWorld(300, 1200)).toBeCloseTo(zoomShowingWorld(1200, 300), 10);
  });

  it('goes NEGATIVE for a pane shorter than one tile', () => {
    // The case the old width-only rule could not express: 200px cannot hold a
    // 256px world, so the whole world is only in view below zoom 0.
    expect(zoomShowingWorld(900, 128)).toBe(-1);
    expect(zoomShowingWorld(900, 200)).toBeCloseTo(-0.3561, 3);
  });

  it('answers 0 for a pane that has not been measured yet', () => {
    // A hidden or freshly created container. `-Infinity` would be the arithmetic
    // answer and an unusable minimum zoom.
    expect(zoomShowingWorld(0, 600)).toBe(0);
    expect(zoomShowingWorld(900, 0)).toBe(0);
    expect(zoomShowingWorld(Number.NaN, 600)).toBe(0);
    expect(zoomShowingWorld(-10, -10)).toBe(0);
  });

  it('takes another tile size, for a provider that does not use 256', () => {
    expect(zoomShowingWorld(512, 512, 512)).toBe(0);
    expect(zoomShowingWorld(2048, 1024, 512)).toBe(1);
  });
});

describe('wholeZoomShowingWorld', () => {
  it('rounds DOWN, so the world still fits', () => {
    // 900x600 fits the world at 1.23. At 2 the world is 1024px against 600px of
    // height — the poles would be off screen.
    expect(wholeZoomShowingWorld(900, 600)).toBe(1);
    expect(wholeZoomShowingWorld(900, 200)).toBe(-1);
  });

  it('leaves an exact power of two alone', () => {
    expect(wholeZoomShowingWorld(256, 256)).toBe(0);
    expect(wholeZoomShowingWorld(1024, 512)).toBe(1);
  });

  it('holds the promise: the whole world fits at the floor', () => {
    for (const [w, h] of [
      [120, 900],
      [300, 300],
      [640, 200],
      [900, 600],
      [1280, 150],
      [1920, 1080],
      [3840, 2160],
    ] as const) {
      expect(worldPx(wholeZoomShowingWorld(w, h))).toBeLessThanOrEqual(Math.min(w, h));
    }
  });

  it('is the LARGEST such zoom — one step up and the world overflows', () => {
    // Without this the floor could be any small number and the test above would
    // still pass. This is what makes it the right one: it stops exactly where the
    // world stops fitting, so nothing below it is worth reaching.
    for (const [w, h] of [
      [300, 300],
      [640, 200],
      [900, 600],
      [1920, 1080],
    ] as const) {
      expect(worldPx(wholeZoomShowingWorld(w, h) + 1)).toBeGreaterThan(Math.min(w, h));
    }
  });

  it('pads the longer side rather than cropping the world', () => {
    // The point of the change, in one number: a 900px-wide pane 600 high shows a
    // 512px world, so there are 388px of background across it — and all of it.
    const z = wholeZoomShowingWorld(900, 600);
    expect(worldPx(z)).toBe(512);
    expect(900 - worldPx(z)).toBe(388);
  });

  it('never fractional, and never below the guard', () => {
    for (const [w, h] of [
      [0, 0],
      [1, 1],
      [8, 4000],
      [120, 120],
      [255, 257],
      [3840, 2160],
    ] as const) {
      const z = wholeZoomShowingWorld(w, h);
      expect(Number.isInteger(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(MIN_WORLD_ZOOM);
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
