import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Two ways a panel-geometry write used to record the wrong thing:
 *
 *  1. A window that had never been moved or resized had no stored rect, so the
 *     first write fell back to a constant — the CONTENT size, where the field
 *     holds a PANEL size (chrome included), at 0,0. Minimizing such a window and
 *     reloading therefore restored it at the top-left, a chrome's worth too
 *     small. The shell's `persistRect()` is the honest source.
 *  2. Closing a window patches `closed: true`, but that write skipped the
 *     per-window queue, so the geometry save from the drag that preceded the
 *     close could land afterwards and drop the flag — reopening a window the
 *     user had shut.
 */

const rectOf = (page: Page, domId: string) =>
  page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }, domId);

const storedGeometry = (page: Page, tableId: string) =>
  page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await (window as any).__easydb.store.tables.findOne(id);
    return t?.windowGeometry ?? null;
  }, tableId);

async function reload(page: Page) {
  await page.reload();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => Boolean((window as any).__easydb));
}

test('minimizing a never-moved window records its real rect, not a constant', async ({ page }) => {
  const id = await createTable(page, 'Untouched', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const panel = page.locator(`#${panelDomId(id)}`);
  // Nothing dragged, nothing resized: this is the opening rect.
  const opening = await rectOf(page, panelDomId(id));

  await panel.locator('.jsPanel-btn-minimize').click();
  await expect(page.locator('#easydb-minimized-dock .jsPanel-replacement')).toHaveCount(1);

  // The stored rect is the panel box, so it matches what was on screen. The old
  // placeholder wrote 0,0 plus the content size.
  await expect.poll(async () => (await storedGeometry(page, id))?.w).toBe(opening.w);
  const stored = (await storedGeometry(page, id))!;
  expect(stored.h).toBe(opening.h);
  expect(stored.x).toBe(opening.x);
  expect(stored.y).toBe(opening.y);
  expect(stored.minimized).toBe(true);

  // And it comes back where it was, at the size it was.
  await reload(page);
  await waitForPanel(page, id);
  await page.locator('#easydb-minimized-dock .jsPanel-replacement').first().click();
  await expect.poll(async () => (await rectOf(page, panelDomId(id))).w).toBe(opening.w);
  const after = await rectOf(page, panelDomId(id));
  expect(after.h).toBe(opening.h);
  expect(after.x).toBe(opening.x);
  expect(after.y).toBe(opening.y);
});

test('a window closed while a drag is still saving stays closed', async ({ page }) => {
  const id = await createTable(page, 'DragThenClose', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const panel = page.locator(`#${panelDomId(id)}`);

  // Slow every geometry write EXCEPT the close one. That puts the drag's save
  // in flight while the close lands — the ordering the per-window queue exists
  // to settle. Left to real timings both writes finish before the other starts,
  // so the race never shows.
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables = (window as any).__easydb.store.tables;
    const orig = tables.patch.bind(tables);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tables.patch = async (tid: string, patch: any) => {
      if (patch?.windowGeometry?.closed !== true) {
        await new Promise((r) => setTimeout(r, 300));
      }
      return orig(tid, patch);
    };
  });

  // Drag, then close immediately — the drag's geometry save and the close's
  // `closed: true` patch are both in flight, and both rewrite the whole object.
  const box = (await panel.locator('.jsPanel-titlebar').boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 6 });
  await page.mouse.up();
  await panel.locator('.jsPanel-btn-close').click();
  await expect(panel).toHaveCount(0);

  // `closed` lands...
  await expect.poll(async () => (await storedGeometry(page, id))?.closed).toBe(true);
  // ...and is STILL there once the held drag write has finished. Asserting only
  // the first appearance is not enough: unqueued, the close patch resolves first
  // and the late drag write then rewrites the whole geometry object without the
  // flag. The wait covers the 300 ms hold above.
  await page.waitForTimeout(600);
  expect((await storedGeometry(page, id))?.closed).toBe(true);

  // The table still exists (closing hides, it does not delete) and its window
  // stays shut across a reload.
  await reload(page);
  await expect(page.locator(`#${panelDomId(id)}`)).toHaveCount(0);
  const rows = await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await (window as any).__easydb.store.tables.findOne(tid);
    return t ? t.name : null;
  }, id);
  expect(rows).toBe('DragThenClose');
});
