import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * "Arrange windows in columns" and "…in rows", beside the existing Tile.
 *
 * Tile squares the grid up, which is what you want for a lot of windows and not
 * what you want for two or three tables you are reading across: those want one
 * column each, full height. Rows are the same thing on its side.
 */

async function runCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(query);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

const rectOf = (page: Page, domId: string) =>
  page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }, domId);

async function twoTables(page: Page): Promise<[string, string]> {
  await page.setViewportSize({ width: 1200, height: 800 });
  const a = await createTable(page, 'ArrangeA', [{ field: 'x' }]);
  const b = await createTable(page, 'ArrangeB', [{ field: 'x' }]);
  await waitForPanel(page, a);
  await waitForPanel(page, b);
  return [a, b];
}

test('columns put the windows side by side at the same height', async ({ page }) => {
  const [a, b] = await twoTables(page);
  await runCommand(page, 'arrange windows in columns');

  const ra = await rectOf(page, panelDomId(a));
  const rb = await rectOf(page, panelDomId(b));
  // Side by side: different x, same y, same size.
  expect(ra.x).not.toBe(rb.x);
  expect(ra.y).toBe(rb.y);
  expect(ra.h).toBe(rb.h);
  expect(Math.abs(ra.w - rb.w)).toBeLessThanOrEqual(1);
  // Full height: taller than either is wide, on a 1200×800 viewport with two
  // windows — the point of the arrangement.
  expect(ra.h).toBeGreaterThan(ra.w);
});

test('rows stack the windows at the same width', async ({ page }) => {
  const [a, b] = await twoTables(page);
  await runCommand(page, 'arrange windows in rows');

  const ra = await rectOf(page, panelDomId(a));
  const rb = await rectOf(page, panelDomId(b));
  expect(ra.y).not.toBe(rb.y);
  expect(ra.x).toBe(rb.x);
  expect(ra.w).toBe(rb.w);
  expect(Math.abs(ra.h - rb.h)).toBeLessThanOrEqual(1);
  expect(ra.w).toBeGreaterThan(ra.h);
});

test('an arrangement survives a reload, like Tile does', async ({ page }) => {
  const [a, b] = await twoTables(page);
  await runCommand(page, 'arrange windows in columns');
  const before = await rectOf(page, panelDomId(a));

  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const t = await (window as unknown as { __easydb: { store: { tables: { findOne(i: string): Promise<{ windowGeometry?: { x: number; y: number; w: number; h: number } } | null> } } } }).__easydb.store.tables.findOne(id);
        const g = t?.windowGeometry;
        return g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null;
      }, a),
    )
    .toEqual(before);

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb));
  await waitForPanel(page, a);
  await waitForPanel(page, b);

  const after = await rectOf(page, panelDomId(a));
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.w - before.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(1);
});

test('a minimized window keeps out of the arrangement', async ({ page }) => {
  // The same rule Tile follows: a minimized panel is parked on purpose, so it
  // must not be un-minimized, nor take a slot and leave a hole.
  const [a, b] = await twoTables(page);
  await page.locator(`#${panelDomId(b)} .jsPanel-btn-minimize`).click();
  await runCommand(page, 'arrange windows in columns');

  const ra = await rectOf(page, panelDomId(a));
  // One eligible window takes the whole area, so it is far wider than half.
  expect(ra.w).toBeGreaterThan(700);
  await expect(page.locator(`#${panelDomId(b)}`)).toHaveAttribute('data-status', 'minimized');
});
