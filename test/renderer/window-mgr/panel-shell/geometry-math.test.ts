import { describe, expect, it } from 'vitest';
import { dragRect, resizeRect } from '../../../../packages/renderer/src/window-mgr/panel-shell/geometry-math.js';

const start = { x: 100, y: 50, w: 400, h: 300 };

describe('dragRect', () => {
  it('moves by the pointer delta at scale 1', () => {
    expect(dragRect(start, 30, -20, 1)).toEqual({ x: 130, y: 30, w: 400, h: 300 });
  });
  it('divides the delta by the canvas scale (zoomed canvas)', () => {
    expect(dragRect(start, 30, 30, 2)).toEqual({ x: 115, y: 65, w: 400, h: 300 });
  });
  it('allows negative positions (unclamped, e2e 08 drags off-screen)', () => {
    expect(dragRect(start, -500, 0, 1).x).toBe(-400);
  });
  it('treats a non-positive scale as 1', () => {
    expect(dragRect(start, 10, 0, 0).x).toBe(110);
    // A negative scale would MIRROR the drag — the panel would run away from the
    // pointer. The panzoom state should never hold one, so this is the guard for
    // when it does, not a supported mode.
    expect(dragRect(start, 10, 0, -2).x).toBe(110);
  });
});

describe('resizeRect', () => {
  it('east grows width only', () => {
    expect(resizeRect(start, 'e', 50, 99, 1, 200, 100)).toEqual({ x: 100, y: 50, w: 450, h: 300 });
  });
  it('west moves x and shrinks width', () => {
    expect(resizeRect(start, 'w', 50, 0, 1, 200, 100)).toEqual({ x: 150, y: 50, w: 350, h: 300 });
  });
  it('north-west moves the origin on both axes', () => {
    expect(resizeRect(start, 'nw', 20, 10, 1, 200, 100)).toEqual({ x: 120, y: 60, w: 380, h: 290 });
  });
  it('south-east grows both', () => {
    expect(resizeRect(start, 'se', 20, 10, 1, 200, 100)).toEqual({ x: 100, y: 50, w: 420, h: 310 });
  });
  it('clamps to the minimum size and pins the moving edge', () => {
    const r = resizeRect(start, 'w', 380, 0, 1, 200, 100);
    expect(r.w).toBe(200);
    expect(r.x).toBe(300); // x + (startW - clampedW): the east edge stays put
  });
  it('clamps BOTH axes at a corner and pins both stationary edges', () => {
    // Dragging the nw corner past the minimum on both axes at once: the panel
    // stops at minW x minH, and the two edges the user is NOT dragging (east and
    // south) must not move — a clamp that forgot to re-derive x/y would slide the
    // whole panel down-right instead.
    const r = resizeRect(start, 'nw', 380, 290, 1, 200, 100);
    expect(r).toEqual({ x: 300, y: 250, w: 200, h: 100 });
    expect(r.x + r.w).toBe(start.x + start.w); // east edge held
    expect(r.y + r.h).toBe(start.y + start.h); // south edge held
  });
  it('divides deltas by the canvas scale', () => {
    expect(resizeRect(start, 'e', 50, 0, 2, 200, 100).w).toBe(425);
  });
  it('treats a non-positive scale as 1, rather than mirroring the resize', () => {
    expect(resizeRect(start, 'e', 50, 0, 0, 200, 100).w).toBe(450);
    expect(resizeRect(start, 'e', 50, 0, -2, 200, 100).w).toBe(450);
  });
});
