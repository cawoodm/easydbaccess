import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A maximized window must fill the whole table area (the #easydb-panels box)
 * and STAY filling it as the pan/zoom canvas is panned or zoomed underneath.
 *
 * Panels live inside the transformed viewport, so jsPanel's maximize (which
 * sizes to the viewport's layout box) would otherwise be offset/scaled by the
 * canvas transform. The window manager counters the canvas transform on the
 * maximized panel and keeps it in sync on every pan/zoom, so it stays pinned
 * to the visible area.
 */

// Dispatch a synthetic touch gesture on the canvas overlay. `moves` are the
// per-touch end coordinates matching `starts` by index; equal deltas across two
// touches pan (pure translate), unequal deltas pinch (zoom).
async function gesture(
  page: import('@playwright/test').Page,
  starts: Array<[number, number]>,
  moves: Array<[number, number]>,
) {
  await page.evaluate(
    ([starts, moves]) => {
      const outer = document.getElementById('easydb-panels') as HTMLElement;
      const touch = (idn: number, x: number, y: number) =>
        new Touch({ identifier: idn, target: outer, clientX: x, clientY: y });
      const fire = (type: string, ts: Touch[]) =>
        outer.dispatchEvent(
          new TouchEvent(type, {
            touches: ts,
            changedTouches: ts,
            bubbles: true,
            cancelable: true,
          }),
        );
      fire(
        'touchstart',
        starts.map(([x, y], i) => touch(i + 1, x, y)),
      );
      fire(
        'touchmove',
        moves.map(([x, y], i) => touch(i + 1, x, y)),
      );
      fire('touchend', []);
    },
    [starts, moves] as const,
  );
}

async function fillsOverlay(page: import('@playwright/test').Page, panelSel: string) {
  const outer = (await page.locator('#easydb-panels').boundingBox())!;
  const panel = (await page.locator(panelSel).boundingBox())!;
  return {
    dx: Math.abs(panel.x - outer.x),
    dy: Math.abs(panel.y - outer.y),
    dw: Math.abs(panel.width - outer.width),
    dh: Math.abs(panel.height - outer.height),
  };
}

test('maximized window stays filling the area through pan and zoom', async ({ page }) => {
  const id = await createTable(page, 'Max', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const panelSel = `#${panelDomId(id)}`;
  const panel = page.locator(panelSel);

  // Pan the canvas first so maximizing must account for a non-identity view.
  await gesture(
    page,
    [
      [100, 100],
      [300, 300],
    ],
    [
      [150, 150],
      [350, 350],
    ],
  );

  await panel.locator('.jsPanel-btn-maximize').click();
  await page.waitForTimeout(120);

  // Fills the whole area right after maximizing.
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dx).toBeLessThan(4);
    expect(d.dy).toBeLessThan(4);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }

  // Pan the canvas again WHILE maximized (equal two-finger delta = translate) →
  // still fills.
  await gesture(
    page,
    [
      [120, 120],
      [320, 320],
    ],
    [
      [220, 260],
      [420, 460],
    ],
  );
  await page.waitForTimeout(80);
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dx).toBeLessThan(4);
    expect(d.dy).toBeLessThan(4);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }

  // Pinch-zoom the canvas WHILE maximized (two-finger spread = scale) → still
  // fills. This exercises the counter transform at scale ≠ 1.
  await gesture(
    page,
    [
      [200, 200],
      [260, 260],
    ],
    [
      [140, 140],
      [360, 360],
    ],
  );
  await page.waitForTimeout(80);
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dx).toBeLessThan(4);
    expect(d.dy).toBeLessThan(4);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }

  // Un-maximize → the panel returns to a normal (smaller) size, no longer
  // covering the whole area, and its counter transform is cleared.
  await panel.locator('.jsPanel-btn-normalize').click();
  await page.waitForTimeout(120);
  // Compare LAYOUT sizes (offsetWidth) — the visual boundingBox is inflated by
  // the zoomed canvas transform and wouldn't reflect the panel's real size.
  const viewportW = await page.evaluate(
    () => document.getElementById('easydb-panels-viewport')!.clientWidth,
  );
  const panelW = await panel.evaluate((el) => (el as HTMLElement).offsetWidth);
  expect(panelW).toBeLessThan(viewportW - 50);
  // The counter transform is cleared, so the panel rides the canvas normally again.
  expect(await panel.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
});
