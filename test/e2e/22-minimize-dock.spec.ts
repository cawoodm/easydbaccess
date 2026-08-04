import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Minimized windows dock to the bottom-left of the table area and STAY there
 * while the canvas is panned/zoomed — the dock lives outside the pan/zoom
 * viewport, so its bars don't move with the transform.
 */

test('minimized windows dock bottom-left and stay put while panning', async ({ page }) => {
  const id = await createTable(page, 'Mini', [{ field: 'a' }]);
  await waitForPanel(page, id);

  // Minimize the window.
  await page.locator(`#${panelDomId(id)} .jsPanel-btn-minimize`).click();

  // A minimized bar appears in the dedicated dock.
  const bar = page.locator('#easydb-minimized-dock .jsPanel-replacement');
  await expect(bar).toBeVisible();

  const outer = (await page.locator('#easydb-panels').boundingBox())!;
  const before = (await bar.boundingBox())!;

  // It's parked at the bottom-left of the table area.
  expect(before.x - outer.x).toBeLessThan(12);
  expect(outer.y + outer.height - (before.y + before.height)).toBeLessThan(12);

  // Pan the canvas (two-finger equal-delta drag → pure translate).
  await page.evaluate(() => {
    const el = document.getElementById('easydb-panels') as HTMLElement;
    const touch = (idn: number, x: number, y: number) => new Touch({ identifier: idn, target: el, clientX: x, clientY: y });
    const fire = (type: string, touches: Touch[]) => el.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true }));
    fire('touchstart', [touch(1, 100, 100), touch(2, 300, 300)]);
    fire('touchmove', [touch(1, 220, 190), touch(2, 420, 390)]);
    fire('touchend', []);
  });

  // The canvas moved, but the dock bar stayed exactly where it was.
  const after = (await bar.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
});
