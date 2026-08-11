import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A first click on a column header sorts DESCENDING, and the `grid` setting
 * "Sort descending first" turns that around.
 *
 * Dates, scores, counts and prices are read from the high end down, so
 * ascending-first spent a click on the direction nobody wanted. A column of
 * names is the exception, which is why it is a setting and not just a new rule.
 */

const ROWS = [{ n: 1 }, { n: 3 }, { n: 2 }];

/** The `n` column in render order. */
async function order(page: import('@playwright/test').Page, tableId: string): Promise<string[]> {
  return page
    .locator(`#${panelDomId(tableId)} data-table`)
    .evaluate((el) => [...(el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot.querySelectorAll('tbody tr:not(.spacer)')].map((tr) => tr.querySelector('input')?.value ?? ''));
}

async function tableWithNumbers(page: import('@playwright/test').Page, name: string) {
  const id = await createTable(page, name, [{ field: 'n', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, ROWS);
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`)).toHaveCount(3);
  return id;
}

const header = (page: import('@playwright/test').Page, id: string) =>
  page
    .locator(`#${panelDomId(id)} data-table`)
    .locator('thead th', { hasText: 'n' })
    .locator('.sort-icon');

test('the first click sorts descending, the second ascending, the third not at all', async ({ page }) => {
  const id = await tableWithNumbers(page, 'Descfirst');

  await header(page, id).click();
  await expect.poll(() => order(page, id)).toEqual(['3', '2', '1']);

  await header(page, id).click();
  await expect.poll(() => order(page, id)).toEqual(['1', '2', '3']);

  // Third click clears the sort: the rows fall back to their stored order.
  await header(page, id).click();
  await expect
    .poll(async () =>
      page.evaluate(async (t) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const table = await (window as any).__easydb.store.tables.findOne(t);
        return table?.sortBy ?? null;
      }, id),
    )
    .toBe(null);
});

test('turning the setting off puts ascending first again', async ({ page }) => {
  const id = await tableWithNumbers(page, 'Ascfirst');

  // Settings → Table grid → Sort descending first.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Table grid' }).click();
  // Both the value and its scope toggle are checkboxes in a label.scope; the
  // value's label reads "enabled". Scope to this setting's own `.field` — the
  // Table grid group gained a second boolean in 0.0.341 (Highlight empty
  // cells), so a bare "enabled" matches two checkboxes.
  const box = dlg.locator('.field', { hasText: 'Sort descending first' }).locator('label.scope', { hasText: 'enabled' }).locator('input');
  await expect(box).toBeChecked(); // on by default
  await box.uncheck();
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();

  await header(page, id).click();
  await expect.poll(() => order(page, id)).toEqual(['1', '2', '3']);
});
