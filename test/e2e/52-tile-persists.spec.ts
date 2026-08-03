import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Tile and Cascade used to write inline geometry only, so a reload restored the
 * rects the windows had BEFORE the arrange — the tidy layout was lost. Both now
 * persist through the owning window manager.
 */

async function runCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(query);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/** The live rect of a panel, as the DOM reports it. */
const rectOf = (page: Page, domId: string) =>
  page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }, domId);

test('a tiled layout survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const a = await createTable(page, 'TileKeepA', [{ field: 'x' }]);
  const b = await createTable(page, 'TileKeepB', [{ field: 'x' }]);
  await waitForPanel(page, a);
  await waitForPanel(page, b);

  await runCommand(page, 'tile windows');
  const before = { a: await rectOf(page, panelDomId(a)), b: await rectOf(page, panelDomId(b)) };
  // Tiling really moved them apart (guards against a no-op passing this test).
  expect(before.a.x === before.b.x && before.a.y === before.b.y).toBe(false);

  // The stored geometry now carries the tiled rect, not the opening cascade.
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await (window as any).__easydb.store.tables.findOne(id);
        // Return null rather than throwing while the write is still in flight —
        // a throw inside expect.poll aborts the poll instead of retrying it.
        const g = t?.windowGeometry;
        return g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null;
      }, a),
    )
    .toEqual(before.a);

  await page.reload();
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
  );
  await waitForPanel(page, a);
  await waitForPanel(page, b);

  // Same rects as right after tiling (±1px for rounding on restore).
  const after = { a: await rectOf(page, panelDomId(a)), b: await rectOf(page, panelDomId(b)) };
  expect(Math.abs(after.a.x - before.a.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.a.y - before.a.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.a.w - before.a.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.b.y - before.b.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.b.w - before.b.w)).toBeLessThanOrEqual(1);
});
