import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Panel titles carry a live row count: "<name> (<total>)" when nothing is
 * filtered, "<name> (<visible>/<total>)" while a search or column filter
 * narrows the set. This holds for both table windows (global + per-column
 * filtering) and view windows (which react to their header search).
 */
test.describe('panel title row counts', () => {
  test('a table window title reflects the global search and clears back', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }, { field: 'kind' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { name: 'Alpha', kind: 'gadget' },
      { name: 'Beta', kind: 'widget' },
      { name: 'Gamma', kind: 'gadget' },
    ]);

    const title = page.locator(`#${panelDomId(id)} .jsPanel-title`);
    await expect(title).toHaveText('Widgets (3)');

    // Global search (header box) narrows to the two "gadget" rows → "(2/3)".
    const header = page.locator('app-shell header');
    await header.locator('button.icon-btn').click();
    const input = header.locator('input.search');
    await input.fill('gadget');
    await expect(title).toHaveText('Widgets (2/3)');

    // Clearing the search restores the full count.
    await input.fill('');
    await expect(title).toHaveText('Widgets (3)');
  });

  test('a table window title reflects a per-column filter', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }, { field: 'kind' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { name: 'Alpha', kind: 'gadget' },
      { name: 'Beta', kind: 'widget' },
      { name: 'Gamma', kind: 'gadget' },
    ]);

    const title = page.locator(`#${panelDomId(id)} .jsPanel-title`);
    await expect(title).toHaveText('Widgets (3)');

    // Filter the first column ("name") to "Alpha" → a single visible row.
    const grid = page.locator(`#${panelDomId(id)} data-table`);
    await grid.locator('tr.filter-row filter-combobox input').first().fill('Alpha');
    await expect(title).toHaveText('Widgets (1/3)');
  });

  test('a view window title shows a count and reacts to its header search', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Alpha', url: 'https://example.com/a' },
      { title: 'Beta', url: 'https://example.com/b' },
    ]);

    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const viewPanel = page.locator('[id^="view-panel-"]');
    await expect(viewPanel).toBeVisible();
    const viewTitle = viewPanel.locator('.jsPanel-title');
    await expect(viewTitle).toHaveText('RSS Feed — Feed (2)');

    // The view's own header search narrows the cards → title shows "(1/2)".
    const search = viewPanel.locator('.jsPanel-controlbar panel-search');
    await search.getByRole('button').click();
    await search.locator('input').fill('Alpha');
    await expect(viewTitle).toHaveText('RSS Feed — Feed (1/2)');
  });
});
