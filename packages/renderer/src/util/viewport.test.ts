import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_MAX_WIDTH, isMobileViewport } from './viewport.js';

/**
 * The breakpoint is shared with the CSS `@media (max-width: 640px)` blocks, so
 * these tests pin the number AND the boundary — `max-width: 640px` matches AT
 * 640, and an off-by-one here would put script and stylesheet on opposite sides
 * of a phone-width screen.
 *
 * The unit suite runs in plain Node with no DOM, so `window` is stubbed on
 * `globalThis` rather than pulling in jsdom for four assertions. That also
 * exercises the no-`window` branch for free.
 */

type WindowStub = { matchMedia?: (q: string) => { matches: boolean }; innerWidth?: number };

function setWindow(stub: WindowStub | undefined): void {
  Object.defineProperty(globalThis, 'window', { value: stub, configurable: true, writable: true });
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** Answer media queries the way a browser would for a viewport `width` px wide. */
function atWidth(width: number) {
  const matchMedia = vi.fn((query: string) => ({
    matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? NaN),
  }));
  setWindow({ matchMedia, innerWidth: width });
  return matchMedia;
}

describe('isMobileViewport', () => {
  it('is true on a phone-width viewport and false on a desktop one', () => {
    atWidth(390);
    expect(isMobileViewport()).toBe(true);
    atWidth(1280);
    expect(isMobileViewport()).toBe(false);
  });

  it('treats the breakpoint itself as mobile, matching `max-width`', () => {
    atWidth(MOBILE_MAX_WIDTH);
    expect(isMobileViewport()).toBe(true);
    atWidth(MOBILE_MAX_WIDTH + 1);
    expect(isMobileViewport()).toBe(false);
  });

  it('asks for the same query the stylesheets use', () => {
    const matchMedia = atWidth(390);
    isMobileViewport();
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 640px)');
  });

  it('falls back to innerWidth where matchMedia is missing', () => {
    setWindow({ innerWidth: 390 });
    expect(isMobileViewport()).toBe(true);
    setWindow({ innerWidth: 1280 });
    expect(isMobileViewport()).toBe(false);
  });

  it('is false with no window at all, rather than throwing', () => {
    setWindow(undefined);
    expect(isMobileViewport()).toBe(false);
  });
});
