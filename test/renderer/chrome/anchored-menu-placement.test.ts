import { describe, expect, it } from 'vitest';
import { placeMenu } from '@marccawood/lit-menu';

/**
 * The placement contract every anchored menu in this app depends on.
 *
 * `placeMenu` lives in `@marccawood/lit-menu` and has its own tests there. This
 * suite is not a copy of them: it is the app pinning the ONE property it needs
 * from that dependency — a menu is inside the window, wherever its anchor is —
 * so a package upgrade that breaks it fails here rather than in a screenshot
 * somebody notices weeks later.
 *
 * Swept rather than sampled, because the interesting cases are the extremes and
 * they are cheap: every corner, every edge, a menu taller than the window, a menu
 * wider than it, and a window the size of a phone.
 */

/** The margin the package keeps between the menu and a window edge. */
const MARGIN = 4;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'small window', width: 560, height: 380 },
  { name: 'phone', width: 320, height: 640 },
  { name: 'short strip', width: 900, height: 200 },
];

/** Menus this app really opens, plus the two that cannot fit. */
const MENUS = [
  { name: '4 items', width: 190, height: 160 },
  { name: '3 items, long labels', width: 260, height: 124 },
  { name: 'a long value list', width: 220, height: 420 },
  { name: 'taller than any window', width: 200, height: 1200 },
  { name: 'wider than a phone', width: 480, height: 160 },
];

/** Anchor boxes at the corners, the edges and the middle of a viewport. */
function anchorsFor(view: { width: number; height: number }) {
  const w = 90;
  const h = 28;
  const xs = [0, Math.round(view.width / 2 - w / 2), view.width - w];
  const ys = [0, Math.round(view.height / 2 - h / 2), view.height - h];
  const out: Array<{ name: string; left: number; right: number; top: number; bottom: number }> = [];
  for (const [i, x] of xs.entries()) {
    for (const [j, y] of ys.entries()) {
      out.push({
        name: `${['left', 'centre', 'right'][i]}/${['top', 'middle', 'bottom'][j]}`,
        left: x,
        right: x + w,
        top: y,
        bottom: y + h,
      });
    }
  }
  return out;
}

describe('an anchored menu is placed inside the window', () => {
  for (const view of VIEWPORTS) {
    for (const menu of MENUS) {
      for (const anchor of anchorsFor(view)) {
        it(`${view.name}, ${menu.name}, anchor ${anchor.name}`, () => {
          const at = placeMenu(anchor, menu, view);

          // Never off the top or the left, whatever the anchor and whatever the
          // size. This is the half that matters most: a menu placed at a negative
          // offset loses its FIRST entries, and there is no way to scroll to them.
          expect(at.left).toBeGreaterThanOrEqual(0);
          expect(at.top).toBeGreaterThanOrEqual(0);

          // A menu that fits has to fit ENTIRELY — the flip-and-clamp exists for
          // exactly this. One that cannot fit is pinned to the margin instead, and
          // the element's own `max-height` + `overflow-y` make the rest reachable
          // (covered end-to-end in `test/e2e/120-anchored-menu-viewport.spec.ts`).
          if (menu.width <= view.width - 2 * MARGIN) {
            expect(at.left + menu.width).toBeLessThanOrEqual(view.width);
          } else {
            expect(at.left).toBe(MARGIN);
          }
          if (menu.height <= view.height - 2 * MARGIN) {
            expect(at.top + menu.height).toBeLessThanOrEqual(view.height);
          } else {
            expect(at.top).toBe(MARGIN);
          }
        });
      }
    }
  }
});

describe('the placement decisions behind that', () => {
  const view = { width: 1000, height: 800 };

  it('opens below and left-aligned when there is room', () => {
    const at = placeMenu({ left: 100, right: 190, top: 40, bottom: 68 }, { width: 190, height: 160 }, view);
    expect(at).toEqual({ left: 100, top: 72 });
  });

  it('flips above an anchor at the bottom — the footer-button case', () => {
    const anchor = { left: 16, right: 106, top: 760, bottom: 788 };
    const at = placeMenu(anchor, { width: 190, height: 160 }, view);
    expect(at.top + 160).toBeLessThanOrEqual(anchor.top);
  });

  it('right-aligns a menu with no room to its right', () => {
    // Not flush against the window edge, so the right-align is what is on show
    // here rather than the clamp below it.
    const anchor = { left: 900, right: 960, top: 10, bottom: 38 };
    const at = placeMenu(anchor, { width: 190, height: 160 }, view);
    expect(at.left + 190).toBe(anchor.right);
  });

  it('keeps its margin when the anchor is flush against the edge', () => {
    // Right-aligning on an anchor that ends AT the window edge would put the menu
    // edge there too. The clamp is applied last for this: the menu comes back in
    // by the margin, so it never looks cut off by the window.
    const anchor = { left: 930, right: view.width, top: 10, bottom: 38 };
    const at = placeMenu(anchor, { width: 190, height: 160 }, view);
    expect(at.left + 190).toBe(view.width - MARGIN);
  });
});
