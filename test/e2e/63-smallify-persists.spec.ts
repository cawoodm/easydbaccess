import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A collapsed (smallified) window is its header and nothing else, so its live
 * height is well under the geometry sanitizer's minimum. The geometry writers
 * used to store that header-only height, `sanitizeGeometry` then threw the whole
 * record away on reload, and the window came back at the cascade default —
 * losing its position AND its size.
 */

/** The live rect of a panel, as the DOM reports it. */
const rectOf = (page: Page, domId: string) =>
  page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }, domId);

/** The rect as PERSISTED for a table. */
const storedRect = (page: Page, tableId: string) =>
  page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await (window as any).__easydb.store.tables.findOne(id);
    const g = t?.windowGeometry;
    return g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null;
  }, tableId);

async function reload(page: Page) {
  await page.reload();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => Boolean((window as any).__easydb));
}

test('a collapsed window comes back collapsed, and unfolds to its old size', async ({ page }) => {
  const id = await createTable(page, 'Collapsible', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const panel = page.locator(`#${panelDomId(id)}`);

  // A real drag, so `onmoved` persists an honest rect: somewhere unmistakably
  // away from the cascade default, and a stored rect to compare against.
  const box = (await panel.locator('.jsPanel-titlebar').boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 240, box.y + 160, { steps: 8 });
  await page.mouse.up();

  const before = await rectOf(page, panelDomId(id));
  await expect.poll(async () => (await storedRect(page, id))?.h).toBe(before.h);

  await panel.locator('.jsPanel-btn-smallify').click();
  // Collapsed: the panel is now header-height only.
  await expect(panel).toHaveAttribute('data-status', 'smallified');
  const collapsed = await rectOf(page, panelDomId(id));
  expect(collapsed.h).toBeLessThan(before.h);

  // What was STORED keeps the pre-collapse height, not the header one.
  await expect.poll(async () => (await storedRect(page, id))?.h).toBe(before.h);

  await reload(page);
  await waitForPanel(page, id);
  const reloaded = page.locator(`#${panelDomId(id)}`);

  // Still collapsed — the state is part of the window's geometry.
  await expect(reloaded).toHaveAttribute('data-status', 'smallified');
  const after = await rectOf(page, panelDomId(id));
  expect(after.h).toBeLessThan(before.h);
  // At its own position and width, not back at the cascade origin (40,80).
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.w - before.w)).toBeLessThanOrEqual(1);
  expect(after.x).not.toBe(40);

  // Unfolding gives back the height it had before it was ever collapsed.
  await reloaded.locator('.jsPanel-btn-normalize').click();
  await expect(reloaded).toHaveAttribute('data-status', 'normalized');
  const unfolded = await rectOf(page, panelDomId(id));
  expect(Math.abs(unfolded.h - before.h)).toBeLessThanOrEqual(1);
  expect(Math.abs(unfolded.x - before.x)).toBeLessThanOrEqual(1);
});

test('a collapsed VIEW window comes back collapsed too', async ({ page, workspaceId }) => {
  // The view windows have their own geometry writer, so it needs its own case.
  const tableId = await createTable(page, 'Feed', [{ field: 'title' }]);
  await waitForPanel(page, tableId);

  await page.evaluate(
    async ({ tableId, ws }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const templates = await store.viewTemplates.find({ workspaceId: ws });
      const rss = (templates as Array<{ id: string; name: string }>).find((t) => t.name === 'RSS Feed')!;
      await store.viewInstances.insert({
        id: 'collapsible-view',
        workspaceId: ws,
        tableId,
        templateId: rss.id,
        name: 'Collapsible',
        filters: {},
        mapping: { TITLE: 'title' },
        visibleColumns: ['title'],
        open: true,
        updatedAt: Date.now(),
      });
    },
    { tableId, ws: workspaceId },
  );

  const panel = page.locator('[id^="view-panel-"]');
  await expect(panel).toBeVisible();
  const domId = (await panel.getAttribute('id'))!;

  // A real drag persists an honest rect first, as above.
  const box = (await panel.locator('.jsPanel-titlebar').boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 140, { steps: 8 });
  await page.mouse.up();
  const before = await rectOf(page, domId);

  await panel.locator('.jsPanel-btn-smallify').click();
  await expect(panel).toHaveAttribute('data-status', 'smallified');

  const storedH = () =>
    page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const inst = await store.viewInstances.findOne('collapsible-view');
      return inst?.windowGeometry?.h ?? null;
    });
  await expect.poll(storedH).toBe(before.h);

  await reload(page);
  const reloaded = page.locator('[id^="view-panel-"]');
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toHaveAttribute('data-status', 'smallified');
  const after = await rectOf(page, domId);
  expect(after.h).toBeLessThan(before.h);
  expect(Math.abs(after.w - before.w)).toBeLessThanOrEqual(1);

  await reloaded.locator('.jsPanel-btn-normalize').click();
  const unfolded = await rectOf(page, domId);
  expect(Math.abs(unfolded.h - before.h)).toBeLessThanOrEqual(1);
});

test('collapsing then restoring leaves the stored rect unchanged', async ({ page }) => {
  const id = await createTable(page, 'RoundTrip', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const panel = page.locator(`#${panelDomId(id)}`);
  const before = await rectOf(page, panelDomId(id));

  await panel.locator('.jsPanel-btn-smallify').click();
  await expect(panel).toHaveAttribute('data-status', 'smallified');
  await panel.locator('.jsPanel-btn-normalize').click();
  await expect(panel).toHaveAttribute('data-status', 'normalized');

  await expect.poll(async () => (await storedRect(page, id))?.h).toBe(before.h);
  const after = await rectOf(page, panelDomId(id));
  expect(after.h).toBe(before.h);
});
