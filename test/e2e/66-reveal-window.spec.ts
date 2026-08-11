import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Targeting a window always brings it on screen. "Go to <table>" used to front
 * the window and stop there, so one sitting outside the panned canvas stayed
 * invisible and the command read as doing nothing.
 *
 * Desktop pans the CANVAS, never the window: geometry is persisted, so moving
 * the window would quietly dismantle a layout the user arranged. A phone has no
 * room to arrange windows and no way to resize one, so there the window fills
 * the screen instead.
 */

const canvasTransform = (page: Page) => page.evaluate(() => (document.getElementById('easydb-panels-viewport') as HTMLElement).style.transform);

/** True when the panel's box lies inside the canvas overlay's box. */
async function isOnScreen(page: Page, tableId: string) {
  return page.evaluate((domId) => {
    const panel = document.getElementById(domId)!.getBoundingClientRect();
    const view = document.getElementById('easydb-panels')!.getBoundingClientRect();
    return panel.left >= view.left - 1 && panel.top >= view.top - 1 && panel.right <= view.right + 1 && panel.bottom <= view.bottom + 1;
  }, panelDomId(tableId));
}

/**
 * Pan the canvas with the real desktop gesture — a right-button drag. Setting the
 * transform by hand would leave the pan/zoom controller's own state behind, and
 * the reveal reads that state.
 */
async function panCanvas(page: Page, dx: number, dy: number) {
  const box = (await page.locator('#easydb-panels').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up({ button: 'right' });
}

async function gotoTable(page: Page, name: string) {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  // Search by the table name: the palette's haystack is "<name> go to table",
  // so typing the item's punctuation would match nothing.
  await palette.locator('input').fill(name);
  await palette
    .locator('.item', { hasText: `Go to: ${name}` })
    .first()
    .click();
  await expect(palette).toBeHidden();
}

test('Go to pans the canvas until the window is on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Faraway', [{ field: 'x' }]);
  await waitForPanel(page, id);

  // Pan the canvas so the window is well off to the left, out of sight.
  await panCanvas(page, -1400, -600);
  expect(await isOnScreen(page, id)).toBe(false);
  const before = await canvasTransform(page);

  await gotoTable(page, 'Faraway');

  await expect.poll(() => isOnScreen(page, id)).toBe(true);
  // The canvas moved, and the window did not.
  expect(await canvasTransform(page)).not.toBe(before);
  const rect = await page.evaluate((domId) => {
    const el = document.getElementById(domId) as HTMLElement;
    return { x: el.offsetLeft, y: el.offsetTop };
  }, panelDomId(id));
  expect(rect).toEqual({ x: 40, y: 80 });
});

test('Go to leaves the canvas alone for a window already in view', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Visible', [{ field: 'x' }]);
  await waitForPanel(page, id);
  expect(await isOnScreen(page, id)).toBe(true);
  const before = await canvasTransform(page);

  await gotoTable(page, 'Visible');

  await expect.poll(() => isOnScreen(page, id)).toBe(true);
  expect(await canvasTransform(page)).toBe(before);
});

test('Go to restores a minimized window and brings it into view', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Docked', [{ field: 'x' }]);
  await waitForPanel(page, id);
  await page.locator(`#${panelDomId(id)} .jsPanel-btn-minimize`).click();
  await expect(page.locator('#easydb-minimized-dock .jsPanel-replacement')).toHaveCount(1);
  await panCanvas(page, -1400, -600);

  await gotoTable(page, 'Docked');

  await expect(page.locator(`#${panelDomId(id)}`)).toHaveAttribute('data-status', 'normalized');
  await expect.poll(() => isOnScreen(page, id)).toBe(true);
});

test('on a phone Go to fills the screen instead of panning', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 780 });
  const id = await createTable(page, 'Handheld', [{ field: 'x' }]);
  await waitForPanel(page, id);

  await gotoTable(page, 'Handheld');

  await expect(page.locator(`#${panelDomId(id)}`)).toHaveAttribute('data-status', 'maximized');
});
