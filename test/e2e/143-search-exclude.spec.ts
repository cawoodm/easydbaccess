import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The search box takes the column-filter language for an un-prefixed term too.
 *
 * It used to read a bare query as literal text, so `!CC,Holiday` searched for
 * the string "!cc,holiday" and returned nothing at all — the filter a user is
 * most likely to try first was the one thing the box could not express.
 */
test.describe('search: exclude one value, keep another', () => {
  async function open(page: import('@playwright/test').Page) {
    const id = await createTable(page, 'Days', [{ field: 'type' }, { field: 'who' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { type: 'CC', who: 'Ann' },
      { type: 'Holiday', who: 'Bob' },
      { type: 'Flat', who: 'Cid' },
    ]);
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('data-table tbody tr:visible')).toHaveCount(3);
    await panel.locator('panel-search').getByRole('button').click();
    return { input: panel.locator('panel-search input'), rows: panel.locator('data-table tbody tr:visible') };
  }

  test('!CC,Holiday shows the holiday and hides the CC', async ({ page }) => {
    const { input, rows } = await open(page);
    await input.fill('!CC,Holiday');
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('input').first()).toHaveValue('Holiday');
  });

  test('a lone exclusion keeps every other row', async ({ page }) => {
    const { input, rows } = await open(page);
    await input.fill('!CC');
    await expect(rows).toHaveCount(2);
  });

  test('a comma is OR', async ({ page }) => {
    const { input, rows } = await open(page);
    await input.fill('Holiday,Flat');
    await expect(rows).toHaveCount(2);
  });

  test('an excluded value in another column still hides the row', async ({ page }) => {
    const { input, rows } = await open(page);
    // Bob's row is a Holiday, but `!Ann` must read across every column, so the
    // exclusion has to leave Ann's row out and nothing else.
    await input.fill('!Ann');
    await expect(rows).toHaveCount(2);
  });

  /**
   * The same query on a table whose cells are not one word each.
   *
   * Reported as "`!CC,Flat` should show Flat entries but doesn't". This spec is
   * the READING — the excluded value in another column, and hidden inside a
   * longer word — not the bug's regression net: a table this small is filtered
   * in memory, and the bug was in the SQL the grid uses once it WINDOWS a large
   * table. That half is pinned at the store level, where it can actually fail:
   * `test/shared/filter-sql.test.ts`.
   */
  test('an exclusion reads the same on rows of more than one word', async ({ page }) => {
    const id = await createTable(page, 'Lets', [{ field: 'type' }, { field: 'who' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { type: 'CC', who: 'Ann' },
      { type: 'Flat', who: 'Cid' },
      { type: 'Flat', who: 'CC Dave' }, // excluded value, other column
      { type: 'Flat Accommodation', who: 'Eve' }, // 'cc' inside a longer word
    ]);
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('data-table tbody tr:visible')).toHaveCount(4);
    await panel.locator('panel-search').getByRole('button').click();
    const input = panel.locator('panel-search input');
    const rows = panel.locator('data-table tbody tr:visible');

    // Cid's row is the only Flat with no CC anywhere in it.
    await input.fill('!CC,Flat');
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('input').nth(1)).toHaveValue('Cid');

    // The positive half alone is unaffected by the exclusion's reading.
    await input.fill('Flat');
    await expect(rows).toHaveCount(3);
  });
});
