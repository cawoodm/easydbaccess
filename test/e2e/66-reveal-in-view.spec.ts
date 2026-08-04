import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * "Go to <table>" and Open on a view have to SHOW the window. Fronting alone is
 * not enough: a window dragged off the visible area, or left behind a pan, was
 * fronted invisibly and the command read as doing nothing.
 *
 * On a desktop viewport the CANVAS pans to the window — the window itself does
 * not move, because its geometry is persisted and a "go to" must not dismantle a
 * layout the user arranged. On a phone the window is maximized instead.
 */

const canvasTransform = (page: Page) => page.evaluate(() => (document.getElementById('easydb-panels-viewport') as HTMLElement).style.transform);

/** Where the panel's box sits on SCREEN, transform included. */
const screenBox = (page: Page, domId: string) =>
  page.evaluate((d) => {
    const r = document.getElementById(d)!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, domId);

/** Put the panel far off to the right, where no pan can be seeing it. */
async function moveFarAway(page: Page, domId: string) {
  await page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    el.style.left = '4000px';
    el.style.top = '2500px';
  }, domId);
}

async function goTo(page: Page, tableName: string) {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  // The haystack is "<name> go to table", so search the name and click the entry
  // rather than trusting whatever sits at index 0 (the Recent section moves it).
  await palette.locator('input').fill(tableName);
  await palette.locator('.item', { hasText: `Go to: ${tableName}` }).click();
  await expect(palette).toBeHidden();
}

test('Go to a table pans the canvas until the window is on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Faraway', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const domId = panelDomId(id);
  await moveFarAway(page, domId);

  const before = await screenBox(page, domId);
  expect(before.left).toBeGreaterThan(1200); // off the right of the screen

  await goTo(page, 'Faraway');

  // The canvas moved...
  await expect.poll(() => canvasTransform(page)).toContain('translate');
  // ...and the window is inside the viewport now.
  const after = await screenBox(page, domId);
  expect(after.left).toBeGreaterThanOrEqual(0);
  expect(after.right).toBeLessThanOrEqual(1200);
  expect(after.top).toBeGreaterThanOrEqual(0);
  expect(after.bottom).toBeLessThanOrEqual(800);
});

test('the window itself is not moved — only the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Stationary', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const domId = panelDomId(id);
  await moveFarAway(page, domId);

  await goTo(page, 'Stationary');

  // Its own layout position is untouched, so the arrangement (and the geometry
  // that gets persisted) survives the reveal.
  const pos = await page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    return { left: el.offsetLeft, top: el.offsetTop };
  }, domId);
  expect(pos).toEqual({ left: 4000, top: 2500 });
});

test('Go to a window already on screen leaves the canvas alone', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Visible', [{ field: 'x' }]);
  await waitForPanel(page, id);

  const before = await canvasTransform(page);
  await goTo(page, 'Visible');
  expect(await canvasTransform(page)).toBe(before);
});

test('on a phone Go to maximizes the window instead of panning', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const id = await createTable(page, 'Pocket', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const domId = panelDomId(id);
  await moveFarAway(page, domId);

  await goTo(page, 'Pocket');

  const panel = page.locator(`#${domId}`);
  await expect(panel).toHaveAttribute('data-status', 'maximized');
});

test('Go to a VIEW pans to its window too', async ({ page, workspaceId }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const tableId = await createTable(page, 'Feed', [{ field: 'title' }]);
  await waitForPanel(page, tableId);
  await page.evaluate(
    async ({ tableId, ws }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const templates = await store.viewTemplates.find({ workspaceId: ws });
      const rss = (templates as Array<{ id: string; name: string }>).find((t) => t.name === 'RSS Feed')!;
      await store.viewInstances.insert({
        id: 'far-view',
        workspaceId: ws,
        tableId,
        templateId: rss.id,
        name: 'Faraway view',
        filters: {},
        mapping: { TITLE: 'title' },
        visibleColumns: ['title'],
        open: true,
        updatedAt: Date.now(),
      });
    },
    { tableId, ws: workspaceId },
  );
  const viewPanel = page.locator('[id^="view-panel-"]');
  await expect(viewPanel).toBeVisible();
  const domId = (await viewPanel.getAttribute('id'))!;
  await moveFarAway(page, domId);

  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('Faraway view');
  await palette.locator('.item', { hasText: 'Go to view: Faraway view' }).click();
  await expect(palette).toBeHidden();

  await expect.poll(() => canvasTransform(page)).toContain('translate');
  const after = await screenBox(page, domId);
  expect(after.left).toBeGreaterThanOrEqual(0);
  expect(after.right).toBeLessThanOrEqual(1200);
});

test('a minimized window is restored before it is revealed', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const id = await createTable(page, 'Docked', [{ field: 'x' }]);
  await waitForPanel(page, id);
  const panel = page.locator(`#${panelDomId(id)}`);
  await panel.locator('.jsPanel-btn-minimize').click();
  await expect(page.locator('#easydb-minimized-dock .jsPanel-replacement')).toHaveCount(1);

  await goTo(page, 'Docked');

  await expect(panel).toHaveAttribute('data-status', 'normalized');
  await expect(page.locator('#easydb-minimized-dock .jsPanel-replacement')).toHaveCount(0);
});
