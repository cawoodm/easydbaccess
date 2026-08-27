import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Arranging windows must move them as little as possible.
 *
 * The bug: the slots come out in reading order and the panels arrived in
 * STACKING order, so "Tile windows" on a grid the user had built by hand sent
 * every window to a slot picked by how recently it was touched. The grid was
 * perfectly aligned and completely reshuffled — the table you were reading
 * bottom-right came back top-left.
 *
 * Each panel now takes the slot nearest to where it already is
 * (`window-mgr/tile-layout.ts`, `nearestSlots`).
 */

const rectOf = (page: Page, domId: string) =>
  page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }, domId);

/** Put a panel exactly where the test wants it, as a drag would. */
async function place(page: Page, domId: string, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ d, left, top }) => {
      const el = document.getElementById(d) as HTMLElement;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = '360px';
      el.style.height = '260px';
    },
    { d: domId, left: x, top: y },
  );
}

async function runCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(query);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/** Which half of the container a rect's center sits in. */
const quadrant = (r: { x: number; y: number; w: number; h: number }, cw: number, ch: number) => `${r.x + r.w / 2 < cw / 2 ? 'left' : 'right'}-${r.y + r.h / 2 < ch / 2 ? 'top' : 'bottom'}`;

test('Tile windows keeps each window in the corner the user put it in', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  // Four tables, created in one order and then placed in another. The
  // creation order is the stacking order, which is what used to decide the
  // slots — so a test that placed them in creation order would pass either way.
  const ids = [
    await createTable(page, 'QuadA', [{ field: 'x' }]),
    await createTable(page, 'QuadB', [{ field: 'x' }]),
    await createTable(page, 'QuadC', [{ field: 'x' }]),
    await createTable(page, 'QuadD', [{ field: 'x' }]),
  ];
  for (const id of ids) await waitForPanel(page, id);
  const dom = ids.map(panelDomId);

  const { cw, ch } = await page.evaluate(() => {
    const c = document.getElementById('easydb-panels')!;
    return { cw: c.clientWidth, ch: c.clientHeight };
  });

  // A rough 2x2 grid, deliberately NOT in creation order:
  // A bottom-right, B top-left, C bottom-left, D top-right.
  await place(page, dom[0]!, cw - 400, ch - 300);
  await place(page, dom[1]!, 20, 20);
  await place(page, dom[2]!, 20, ch - 300);
  await place(page, dom[3]!, cw - 400, 20);

  const before = await Promise.all(dom.map((d) => rectOf(page, d)));
  const wanted = before.map((r) => quadrant(r, cw, ch));
  expect(wanted).toEqual(['right-bottom', 'left-top', 'left-bottom', 'right-top']);

  await runCommand(page, 'tile windows');

  const after = await Promise.all(dom.map((d) => rectOf(page, d)));
  // Every window is still in its own corner. Before the fix this came back as
  // the reading order — ['left-top', 'right-top', 'left-bottom', 'right-bottom'].
  expect(after.map((r) => quadrant(r, cw, ch))).toEqual(wanted);
  // And it really tiled: each window now fills about a quarter of the canvas.
  for (const r of after) {
    expect(r.w).toBeGreaterThan(cw * 0.4);
    expect(r.h).toBeGreaterThan(ch * 0.4);
  }
});

test('Arrange in columns keeps the windows in left-to-right order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  const ids = [await createTable(page, 'ColA', [{ field: 'x' }]), await createTable(page, 'ColB', [{ field: 'x' }]), await createTable(page, 'ColC', [{ field: 'x' }])];
  for (const id of ids) await waitForPanel(page, id);
  const dom = ids.map(panelDomId);

  const cw = await page.evaluate(() => document.getElementById('easydb-panels')!.clientWidth);

  // C on the left, A in the middle, B on the right.
  await place(page, dom[2]!, 20, 60);
  await place(page, dom[0]!, Math.round(cw / 2) - 180, 200);
  await place(page, dom[1]!, cw - 400, 340);

  await runCommand(page, 'arrange in columns');

  const after = await Promise.all(dom.map((d) => rectOf(page, d)));
  // Same left-to-right order as before: C, A, B.
  const order = [2, 0, 1].map((i) => after[i]!.x);
  expect(order[0]!).toBeLessThan(order[1]!);
  expect(order[1]!).toBeLessThan(order[2]!);
  // Columns, not a tile: every window is full height and they all share one row.
  expect(new Set(after.map((r) => r.y)).size).toBe(1);
});
