import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A column filtered to one of its values must still offer the others.
 *
 * The grid asks the store for exactly the rows it shows, and that request carries
 * EVERY filter — including the column's own. So the rows in memory hold one value
 * for that column, and a value list built from them offers only the value already
 * filtered on: there is no way to switch from A1 to A2 except by clearing the
 * filter first and remembering what else was there.
 *
 * Both pickers are covered, because both were built from those same rows: the
 * dropdown under the filter box and the funnel's popover.
 */

const ROWS = [
  { fruit: 'A1', note: 'one' },
  { fruit: 'A2', note: 'two' },
  { fruit: 'A3', note: 'three' },
  { fruit: 'A1', note: 'four' },
];

async function seed(page: import('@playwright/test').Page) {
  const id = await createTable(page, 'Fruit', [{ field: 'fruit' }, { field: 'note' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, ROWS);
  return id;
}

const comboInput = (page: import('@playwright/test').Page, id: string) =>
  page
    .locator(`#${panelDomId(id)} data-table tr.filter-row filter-combobox`)
    .first()
    .locator('input');

const dropdownItems = (page: import('@playwright/test').Page, id: string) =>
  page
    .locator(`#${panelDomId(id)} data-table tr.filter-row filter-combobox`)
    .first()
    .locator('ul.dropdown li');

/**
 * Wait until the STORE has answered the filtered request, not just until the
 * grid has narrowed what it draws.
 *
 * The two are not the same moment: the grid filters its rows in memory as you
 * type, so the visible count is right long before the read lands — and until it
 * lands the siblings are still in memory, which is what made an earlier version
 * of this file pass against the bug it was written for.
 */
async function narrowed(page: import('@playwright/test').Page, id: string, rows: number) {
  await expect.poll(() => page.evaluate((s) => (document.querySelector(s) as unknown as { rows: unknown[] } | null)?.rows.length ?? -1, `#${panelDomId(id)} data-table`)).toBe(rows);
}

test.describe('a filtered column still offers its siblings', () => {
  test('the filter dropdown lists A2 and A3 while the filter says A1', async ({ page }) => {
    const id = await seed(page);
    const input = comboInput(page, id);
    const rows = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);

    await input.fill('A1');
    await expect(rows).toHaveCount(2);
    await narrowed(page, id, 2);

    // Re-open the dropdown without typing: the list must be the column's values,
    // not the one value the grid is currently narrowed to.
    await input.blur();
    await input.click();
    await expect(dropdownItems(page, id)).toHaveText(['A1', 'A2', 'A3']);
  });

  test('picking a sibling from the dropdown switches the filter to it', async ({ page }) => {
    const id = await seed(page);
    const input = comboInput(page, id);
    const rows = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);

    await input.fill('A1');
    await expect(rows).toHaveCount(2);
    await narrowed(page, id, 2);
    await input.blur();
    await input.click();
    await dropdownItems(page, id).filter({ hasText: 'A3' }).click();

    await expect(input).toHaveValue('A3');
    await expect(rows).toHaveCount(1);
  });

  test('the funnel popover offers the siblings too', async ({ page }) => {
    const id = await seed(page);
    await comboInput(page, id).fill('A1');
    await expect(page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`)).toHaveCount(2);
    await narrowed(page, id, 2);

    await page
      .locator(`#${panelDomId(id)} data-table thead th button.funnel`)
      .first()
      .click();
    const pop = page.locator('filter-popover');
    await expect(pop).toBeVisible();
    await expect(pop.locator('li')).toHaveText([/A1/, /A2/, /A3/]);
  });

  test('another column stays narrowed by this one — the drill-down still works', async ({ page }) => {
    // The sibling rule is about a column's OWN filter. Every other column must
    // still offer only what the filtered set holds, or the drill-down is gone.
    const id = await seed(page);
    await comboInput(page, id).fill('A1');
    await narrowed(page, id, 2);
    const noteCombo = page.locator(`#${panelDomId(id)} data-table tr.filter-row filter-combobox`).nth(1);
    await noteCombo.locator('input').click();
    await expect(noteCombo.locator('ul.dropdown li')).toHaveText(['four', 'one']);
  });
});
