import { describe, expect, it } from 'vitest';
import { panToReveal, REVEAL_MARGIN } from '../../../packages/renderer/src/window-mgr/reveal-math.js';

const at = (x: number, y: number, scale = 1) => ({ x, y, scale });
const rect = (x: number, y: number, w = 200, h = 100) => ({ x, y, w, h });

// A 1000x600 visible area for every case.
const W = 1000;
const H = 600;

describe('panToReveal', () => {
  it('leaves a window that is already visible alone', () => {
    expect(panToReveal(at(0, 0), rect(100, 100), W, H)).toBeNull();
  });

  it('pans right when the window is off the left edge', () => {
    // At canvas x=-300 the window's left edge sits at -300 on screen.
    const out = panToReveal(at(0, 0), rect(-300, 100), W, H)!;
    expect(out.x).toBe(REVEAL_MARGIN + 300);
    expect(out.y).toBe(0); // the other axis is untouched
  });

  it('pans left when the window is off the right edge', () => {
    // 200 wide at x=1500 ⇒ its far edge is at 1700, the view ends at 1000.
    const out = panToReveal(at(0, 0), rect(1500, 100), W, H)!;
    // Far edge lands on the margin: 1500 + 200 + x = 1000 - 12.
    expect(out.x).toBe(W - REVEAL_MARGIN - 200 - 1500);
  });

  it('moves as little as possible — the near edge is not centred', () => {
    const out = panToReveal(at(0, 0), rect(-50, 100), W, H)!;
    expect(out.x).toBe(REVEAL_MARGIN + 50);
  });

  it('accounts for the current pan', () => {
    // Already panned right by 400, so a window at -300 is visible at 100.
    expect(panToReveal(at(400, 0), rect(-300, 100), W, H)).toBeNull();
  });

  it('accounts for zoom: positions and sizes both scale', () => {
    // At scale 0.5 a window at canvas 1500 shows at 750 and is 100 wide — fits.
    expect(panToReveal(at(0, 0, 0.5), rect(1500, 100), W, H)).toBeNull();
    // At scale 2 it shows at 3000: off screen.
    const out = panToReveal(at(0, 0, 2), rect(1500, 100), W, H)!;
    expect(out.scale).toBe(2); // zoom is the user's choice, never touched
    expect(1500 * 2 + out.x + 200 * 2).toBe(W - REVEAL_MARGIN);
  });

  it('pins a window taller than the view by its top edge', () => {
    // 900 tall in a 600 view: the titlebar must be reachable.
    const out = panToReveal(at(0, -400), rect(100, 0, 200, 900), W, H)!;
    expect(out.y).toBe(REVEAL_MARGIN);
  });

  it('leaves an oversized window that already covers the view alone', () => {
    expect(panToReveal(at(0, 0), rect(0, 0, 2000, 1200), W, H)).toBeNull();
  });

  it('fixes both axes at once', () => {
    const out = panToReveal(at(0, 0), rect(-100, -80), W, H)!;
    expect(out.x).toBe(REVEAL_MARGIN + 100);
    expect(out.y).toBe(REVEAL_MARGIN + 80);
  });
});
