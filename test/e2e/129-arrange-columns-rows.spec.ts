import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * "Arrange in columns" and "Arrange in rows" — the two layouts a square tile
 * cannot express.
 *
 * Three tables tiled become a 2x2 grid with one window on a second row, where its
 * rows line up with nothing. Columns give every window the full height side by
 * side, which is what reading the same rows across several tables needs.
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

/** A panel's own status — `normalized`, `minimized`, and so on. */
const statusOf = (page: Page, domId: string) => page.evaluate((id) => (document.getElementById(id) as HTMLElement & { status: string }).status, domId);

/** The canvas the windows are arranged inside. */
const canvasSize = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('easydb-panels');
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
  });

/** Three tables, three windows, front-to-back order settled. */
async function threeWindows(page: Page): Promise<string[]> {
  const ids: string[] = [];
  for (const name of ['ArrA', 'ArrB', 'ArrC']) {
    const id = await createTable(page, name, [{ field: 'x' }]);
    await waitForPanel(page, id);
    ids.push(id);
  }
  return ids;
}

test.describe('arranging windows', () => {
  // Three tables to create, plus a palette command per assertion.
  test.describe.configure({ timeout: 120_000 });

  test('in columns: every window is full height, side by side, none overlapping', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const ids = await threeWindows(page);

    await runCommand(page, 'Arrange in columns');
    const rects = await Promise.all(ids.map((id) => rectOf(page, panelDomId(id))));
    const canvas = await canvasSize(page);

    // Full height: one gap top and bottom, and nothing else vertical.
    for (const r of rects) {
      expect(r.h).toBeGreaterThan(canvas.h - 20);
      expect(r.y).toBeLessThanOrEqual(8);
    }
    // Equal widths — a third of the canvas each, not a 2x2 grid's half.
    const widths = rects.map((r) => r.w);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    for (const w of widths) expect(w).toBeLessThan(canvas.w / 2);

    // Side by side and clear of each other: sorted by x, each starts after the
    // one before it ends.
    const byX = [...rects].sort((a, b) => a.x - b.x);
    expect(new Set(byX.map((r) => r.y)).size).toBe(1);
    for (let i = 1; i < byX.length; i++) expect(byX[i]!.x).toBeGreaterThanOrEqual(byX[i - 1]!.x + byX[i - 1]!.w);
  });

  test('in rows: every window is full width, stacked, none overlapping', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const ids = await threeWindows(page);

    await runCommand(page, 'Arrange in rows');
    const rects = await Promise.all(ids.map((id) => rectOf(page, panelDomId(id))));
    const canvas = await canvasSize(page);

    for (const r of rects) {
      expect(r.w).toBeGreaterThan(canvas.w - 20);
      expect(r.x).toBeLessThanOrEqual(8);
    }
    const heights = rects.map((r) => r.h);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

    const byY = [...rects].sort((a, b) => a.y - b.y);
    expect(new Set(byY.map((r) => r.x)).size).toBe(1);
    for (let i = 1; i < byY.length; i++) expect(byY[i]!.y).toBeGreaterThanOrEqual(byY[i - 1]!.y + byY[i - 1]!.h);
  });

  test('columns and rows are different layouts, and Tile is neither', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const ids = await threeWindows(page);
    const domIds = ids.map(panelDomId);

    await runCommand(page, 'Arrange in columns');
    const columns = await Promise.all(domIds.map((d) => rectOf(page, d)));
    await runCommand(page, 'Arrange in rows');
    const rows = await Promise.all(domIds.map((d) => rectOf(page, d)));
    await runCommand(page, 'Tile windows');
    const tiled = await Promise.all(domIds.map((d) => rectOf(page, d)));

    // Guards against any two of the three commands being wired to one another.
    expect(columns).not.toEqual(rows);
    expect(columns).not.toEqual(tiled);
    expect(rows).not.toEqual(tiled);
    // Three windows tiled need two rows; in columns they need one. That is the
    // difference the feature exists for.
    expect(new Set(tiled.map((r) => r.y)).size).toBe(2);
    expect(new Set(columns.map((r) => r.y)).size).toBe(1);
  });

  test('a minimized window keeps out of the layout and stays minimized', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const ids = await threeWindows(page);

    // Minimizing is deliberate — arranging must not undo it, nor leave a hole
    // where the minimized window would have been (see `eligibleForArrange`).
    const parked = panelDomId(ids[2]!);
    await page.evaluate((d) => (document.getElementById(d) as HTMLElement & { minimize(): void }).minimize(), parked);
    await expect.poll(() => statusOf(page, parked)).toBe('minimized');

    await runCommand(page, 'Arrange in columns');

    const rects = await Promise.all([ids[0]!, ids[1]!].map((id) => rectOf(page, panelDomId(id))));
    const canvas = await canvasSize(page);
    // Two windows, so half the canvas each — not a third with a gap.
    for (const r of rects) expect(r.w).toBeGreaterThan(canvas.w / 2 - 20);
    expect(await statusOf(page, parked)).toBe('minimized');
  });

  test('an arrangement survives a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const ids = await threeWindows(page);

    await runCommand(page, 'Arrange in columns');
    const before = await rectOf(page, panelDomId(ids[0]!));

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    for (const id of ids) await waitForPanel(page, id);

    // Same rect, ±1px for rounding on restore. Tile and Cascade had this bug
    // (v0.0.52 spec); a new arrangement must not reintroduce it.
    const after = await rectOf(page, panelDomId(ids[0]!));
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.w - before.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(1);
  });
});
