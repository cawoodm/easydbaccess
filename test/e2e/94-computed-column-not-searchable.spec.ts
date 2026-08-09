import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A scripted column is computed at render time and stores nothing, so a search
 * over it scans empty cells and matches nothing — while the grid plainly SHOWS
 * the value being searched for. So it stops being offered: no funnel, and not a
 * field the search looks in.
 *
 * Derived from the rows, not written onto the column: the same column becomes
 * searchable again the moment it holds data.
 */

const SCRIPT = 'function render(row) { return String(row.first).toUpperCase(); }';

async function seed(page: import('@playwright/test').Page, rows: Array<Record<string, unknown>>) {
  const id = await createTable(page, 'People', [{ field: 'first' }, { field: 'shout', script: SCRIPT }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, rows);
  return id;
}

test('a computed-only column loses its funnel, and the one beside it keeps one', async ({ page }) => {
  const id = await seed(page, [{ first: 'ada' }, { first: 'bob' }]);
  const grid = page.locator(`#${panelDomId(id)} data-table`);

  // The value is on screen…
  await expect(grid.locator('tbody')).toContainText('ADA');
  // …but the column offers no filter, because filtering it could only ever
  // match nothing.
  const headers = grid.locator('thead tr').first().locator('th[title]');
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0).locator('button.funnel')).toHaveCount(1);
  await expect(headers.nth(1).locator('button.funnel')).toHaveCount(0);
});

test('a scripted column that stores data keeps its funnel', async ({ page }) => {
  // Values were there before the script was added. Freezing the column as
  // unsearchable would have been wrong here, which is why it is not stored.
  const id = await seed(page, [{ first: 'ada', shout: 'ADA' }]);
  const grid = page.locator(`#${panelDomId(id)} data-table`);
  const headers = grid.locator('thead tr').first().locator('th[title]');
  await expect(headers.nth(1).locator('button.funnel')).toHaveCount(1);
});

test('an empty table drops nothing — no rows is no evidence', async ({ page }) => {
  const id = await seed(page, []);
  const grid = page.locator(`#${panelDomId(id)} data-table`);
  const headers = grid.locator('thead tr').first().locator('th[title]');
  await expect(headers.nth(1).locator('button.funnel')).toHaveCount(1);
});

test('the window search still finds rows by the columns that do store data', async ({ page }) => {
  const id = await seed(page, [{ first: 'ada' }, { first: 'bob' }]);
  const search = page.locator(`#${panelDomId(id)} .jsPanel-controlbar panel-search`);
  await search.getByRole('button').click();
  await search.locator('input').fill('ada');
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr`)).toHaveCount(1);
});
