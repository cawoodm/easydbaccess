import { describe, expect, it } from 'vitest';
import { clampScale, panBy, zoomAround, MIN_SCALE, MAX_SCALE } from '../../../packages/renderer/src/window-mgr/panzoom.js';

describe('clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(999)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('panBy', () => {
  it('translates by the delta, leaving scale unchanged', () => {
    expect(panBy({ x: 10, y: 20, scale: 2 }, 5, -8)).toEqual({ x: 15, y: 12, scale: 2 });
  });
});

describe('zoomAround', () => {
  it('keeps the point under the focus fixed while scaling', () => {
    const start = { x: 0, y: 0, scale: 1 };
    // Zoom 2x about (100, 100). The world point under (100,100) was (100,100);
    // after zoom it must still sit under (100,100) on screen.
    const next = zoomAround(start, 2, 100, 100);
    expect(next.scale).toBe(2);
    const screenX = next.x + 100 * next.scale; // world (100) mapped to screen
    const screenY = next.y + 100 * next.scale;
    expect(screenX).toBeCloseTo(100);
    expect(screenY).toBeCloseTo(100);
  });

  it('respects the scale clamp (focus still fixed at the clamped scale)', () => {
    const next = zoomAround({ x: 0, y: 0, scale: 1 }, 999, 50, 50);
    expect(next.scale).toBe(MAX_SCALE);
    expect(next.x + 50 * next.scale).toBeCloseTo(50);
  });

  it('is invertible: zoom in then out about the same point returns to start', () => {
    const start = { x: 30, y: -10, scale: 1 };
    const inN = zoomAround(start, 2, 200, 150);
    const back = zoomAround(inN, 0.5, 200, 150);
    expect(back.scale).toBeCloseTo(start.scale);
    expect(back.x).toBeCloseTo(start.x);
    expect(back.y).toBeCloseTo(start.y);
  });
});
