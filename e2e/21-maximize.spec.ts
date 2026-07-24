import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Maximizing a window must fill the whole table area even when the pan/zoom
 * canvas has been panned or zoomed. Panels live inside the transformed
 * viewport, so maximizing resets the canvas to 1:1 (restoring it on
 * un-maximize) — otherwise the "maximized" window would be offset/scaled.
 */

test('maximize fills the window even after the canvas is panned', async ({ page }) => {
  const id = await createTable(page, 'Max', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const panel = page.locator(`#${panelDomId(id)}`);

  // Pan the canvas → the viewport transform becomes non-identity. A two-finger
  // equal-delta drag pans by a pure translate (avoids the one-finger double-tap
  // heuristic, which misfires on synthetic events that share a 0 timeStamp).
  await page.evaluate(() => {
    const outer = document.getElementById('easydb-panels') as HTMLElement;
    const touch = (idn: number, x: number, y: number) =>
      new Touch({ identifier: idn, target: outer, clientX: x, clientY: y });
    const fire = (type: string, touches: Touch[]) =>
      outer.dispatchEvent(
        new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true }),
      );
    fire('touchstart', [touch(1, 100, 100), touch(2, 300, 300)]);
    fire('touchmove', [touch(1, 150, 150), touch(2, 350, 350)]);
    fire('touchend', []);
  });

  const vp = page.locator('#easydb-panels-viewport');
  const matrix = (s: string) => (s === 'none' ? [1, 0, 0, 1, 0, 0] : s.match(/-?\d+\.?\d*/g)!.map(Number));
  const panned = matrix(await vp.evaluate((el) => getComputedStyle(el).transform));
  expect(Math.abs(panned[4]!) + Math.abs(panned[5]!)).toBeGreaterThan(50); // translated

  // Maximize the panel.
  await panel.locator('.jsPanel-btn-maximize').click();

  // The canvas reset to identity (no translate/scale) while maximized…
  await expect
    .poll(async () => {
      const m = matrix(await vp.evaluate((el) => getComputedStyle(el).transform));
      return Math.abs(m[0]! - 1) + Math.abs(m[3]! - 1) + Math.abs(m[4]!) + Math.abs(m[5]!);
    })
    .toBeLessThan(0.01);

  // …so the maximized panel fills the whole table area (the #easydb-panels box).
  const outerBox = (await page.locator('#easydb-panels').boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(Math.abs(panelBox.x - outerBox.x)).toBeLessThan(4);
  expect(Math.abs(panelBox.y - outerBox.y)).toBeLessThan(4);
  expect(Math.abs(panelBox.width - outerBox.width)).toBeLessThan(4);
  expect(Math.abs(panelBox.height - outerBox.height)).toBeLessThan(4);

  // Un-maximize → the previous pan is restored.
  await panel.locator('.jsPanel-btn-normalize').click();
  await expect
    .poll(async () => {
      const m = matrix(await vp.evaluate((el) => getComputedStyle(el).transform));
      return Math.abs(m[4]! - panned[4]!) + Math.abs(m[5]! - panned[5]!);
    })
    .toBeLessThan(0.01);
});
