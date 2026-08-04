import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Two touch-screen problems with windows:
 *
 *  1. There is no resize handle on a phone, so a maximized window that
 *     restores to its old rect is stuck small with no way to grow it again.
 *     Restore must keep the size it had.
 *  2. "Open" on a view that was already open flipped a flag that was already
 *     set, so nothing happened. It has to front / restore / position the
 *     window whatever state it was in.
 */

const PHONE = { width: 390, height: 780 };
const DESKTOP = { width: 1280, height: 900 };

const panel = (page: import('@playwright/test').Page, id: string) => page.locator(`#${panelDomId(id)}`);

async function makeTable(page: import('@playwright/test').Page, name = 'T') {
  const id = await createTable(page, name, [{ field: 'a' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ a: '1' }]);
  return id;
}

test.describe('restoring a maximized window on a phone keeps its size', () => {
  test('Restore leaves the window filling the screen, not back at its old rect', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const id = await makeTable(page);
    const p = panel(page, id);

    // A default window is 720 wide — WIDER than the phone, so it hangs off the
    // right. Maximizing shrinks it to the screen, which is the state the user
    // wants to keep.
    const before = (await p.boundingBox())!;
    expect(before.width).toBeGreaterThan(PHONE.width);

    await p.locator('button[title="Maximize"]').click();
    await expect(p).toHaveAttribute('data-status', 'maximized');
    const maxed = (await p.boundingBox())!;
    expect(Math.round(maxed.width)).toBe(PHONE.width);

    await p.locator('button[title="Restore"]').click();
    await expect(p).toHaveAttribute('data-status', 'normalized');

    // The whole point: a restored window on a phone stays the size it was.
    const after = (await p.boundingBox())!;
    expect(Math.round(after.width)).toBe(Math.round(maxed.width));
    expect(Math.round(after.height)).toBe(Math.round(maxed.height));
  });

  test('on a desktop Restore still goes back to the original rect', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const id = await makeTable(page);
    const p = panel(page, id);

    const before = (await p.boundingBox())!;
    await p.locator('button[title="Maximize"]').click();
    await expect(p).toHaveAttribute('data-status', 'maximized');
    await p.locator('button[title="Restore"]').click();
    await expect(p).toHaveAttribute('data-status', 'normalized');

    const after = (await p.boundingBox())!;
    expect(Math.round(after.width)).toBe(Math.round(before.width));
    expect(Math.round(after.height)).toBe(Math.round(before.height));
  });
});

/** Create a view of `tableId` through the Views dialog and return its panel. */
async function createView(page: import('@playwright/test').Page, tableId: string) {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
  await dlg.getByRole('button', { name: 'Create view' }).click();
  // `.jsPanel` excludes the minimized dock bar, which is `<panel id>-min` and
  // would otherwise match this prefix too.
  const viewPanel = page.locator('[id^="view-panel-"].jsPanel');
  await expect(viewPanel).toBeVisible();
  return viewPanel;
}

/**
 * Move a panel far off to the side. Both the "already open" and "off-screen"
 * cases need the view out from over the table window — its invisible resize
 * edges otherwise swallow clicks meant for the table's header and footer.
 */
async function park(panel: import('@playwright/test').Locator) {
  await panel.evaluate((el) => {
    (el as HTMLElement).style.left = '4000px';
    (el as HTMLElement).style.top = '3000px';
  });
}

/** Reopen the Views dialog and press Open on the first view. */
async function pressOpen(page: import('@playwright/test').Page, tableId: string) {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('ul.list li').first().getByRole('button', { name: 'Open' }).click();
  await expect(dlg).toBeHidden();
}

test.describe('Open on a view actually shows it', () => {
  test('Open restores a MINIMIZED view and fronts it', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Alpha', url: 'https://example.com/a' }]);
    const viewPanel = await createView(page, id);

    await viewPanel.locator('button[title="Minimize"]').click();
    await expect(viewPanel).toHaveAttribute('data-status', 'minimized');

    await pressOpen(page, id);

    await expect(viewPanel).toHaveAttribute('data-status', 'normalized');
    await expect(viewPanel).toBeVisible();
  });

  test('Open on an ALREADY-OPEN view brings it to the front', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Alpha', url: 'https://example.com/a' }]);
    const viewPanel = await createView(page, id);
    await park(viewPanel);

    // Put the table window on top of the view.
    await page.locator(`#${panelDomId(id)} .jsPanel-hdr`).click();
    const zOf = async (loc: import('@playwright/test').Locator) => Number(await loc.evaluate((el) => (el as HTMLElement).style.zIndex));
    expect(await zOf(page.locator(`#${panelDomId(id)}`))).toBeGreaterThan(await zOf(viewPanel));

    await pressOpen(page, id);

    // This is the reported bug: the flag was already `true`, so nothing moved.
    await expect.poll(async () => (await zOf(viewPanel)) > (await zOf(page.locator(`#${panelDomId(id)}`)))).toBe(true);
  });

  test('Open brings a view that was panned off-screen back into sight', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Alpha', url: 'https://example.com/a' }]);
    const viewPanel = await createView(page, id);
    // Off in the far corner of the canvas, nowhere near the viewport.
    await park(viewPanel);
    const away = (await viewPanel.boundingBox())!;
    expect(away.x).toBeGreaterThan(page.viewportSize()!.width);

    await pressOpen(page, id);

    const box = (await viewPanel.boundingBox())!;
    const vw = page.viewportSize()!;
    // Its top-left is inside the window, which is all "brought back" can mean.
    expect(box.x).toBeGreaterThan(-box.width);
    expect(box.x).toBeLessThan(vw.width);
    expect(box.y).toBeGreaterThan(-box.height);
    expect(box.y).toBeLessThan(vw.height);
  });

  test('on a phone Open fills the screen with the view', async ({ page }) => {
    await page.setViewportSize(PHONE);
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Alpha', url: 'https://example.com/a' }]);
    const viewPanel = await createView(page, id);

    // Creating it already filled the screen (same code path), so minimize it
    // to get back to the table's footer — and to test the case that matters:
    // reopening a docked view on a phone.
    await viewPanel.locator('button[title="Minimize"]').click();
    await expect(viewPanel).toHaveAttribute('data-status', 'minimized');

    await pressOpen(page, id);

    await expect(viewPanel).toHaveAttribute('data-status', 'maximized');
    const box = (await viewPanel.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(PHONE.width - 4);
  });
});
