import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * "Tile windows" (and "Cascade windows") must ignore minimized panels: a
 * minimized window is deliberately parked by the user — often to keep a large
 * table's data out of memory (see the `?minimize` boot flag) — so tiling must
 * neither un-minimize it nor count it toward the grid's row/column maths. See
 * `window-mgr/tile-layout.ts` (`eligibleForArrange`, `tileSlots`).
 */

async function statusOf(page: Page, domId: string): Promise<string> {
  return page.evaluate((id) => (document.getElementById(id) as HTMLElement & { status: string }).status, domId);
}

async function runTileCommand(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('tile windows');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

test('Tile windows skips minimized panels: they stay minimized and are excluded from the grid count', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });

  const a = await createTable(page, 'TileA', [{ field: 'x' }]);
  const b = await createTable(page, 'TileB', [{ field: 'x' }]);
  const c = await createTable(page, 'TileC', [{ field: 'x' }]);
  await waitForPanel(page, a);
  await waitForPanel(page, b);
  await waitForPanel(page, c);

  const domA = panelDomId(a);
  const domB = panelDomId(b);
  const domC = panelDomId(c);

  // Minimize C — the other two (A, B) stay normalized.
  await page.evaluate((d) => (document.getElementById(d) as HTMLElement & { minimize(): void }).minimize(), domC);
  await expect.poll(() => statusOf(page, domC)).toBe('minimized');

  const containerHeight = await page.evaluate(() => document.getElementById('easydb-panels')!.clientHeight);

  await runTileCommand(page);

  // C is STILL minimized — tiling must never un-minimize a parked window.
  expect(await statusOf(page, domC)).toBe('minimized');

  // A and B must be laid out for a count of TWO (a 1-row, 2-column grid: each
  // panel gets nearly the full container height), not three (a 2x2 grid,
  // which would give each panel roughly HALF the height). If C were still
  // counted, both boxes below would come out around ~0.45-0.5 instead.
  const boxA = (await page.locator(`#${domA}`).boundingBox())!;
  const boxB = (await page.locator(`#${domB}`).boundingBox())!;
  expect(boxA.height / containerHeight).toBeGreaterThan(0.75);
  expect(boxB.height / containerHeight).toBeGreaterThan(0.75);
});
