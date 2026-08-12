import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A funnel's value list is built from the rows in memory. On a windowed grid that
 * is one PAGE, so the list holds the values of that page and nothing says so — a
 * list that quietly changes as you scroll is worse than one that admits it.
 *
 * So the popover carries a note and a REFRESH icon. Pressing it asks the store for
 * the real distinct values. Never automatic: a funnel click has to stay instant,
 * and the page usually holds the value the user wants.
 */

const ROWS = 3000;
/** The value only row 2999 carries — far outside the first page of 500. */
const RARE = 'zebra';

async function setThreshold(page: import('@playwright/test').Page, n: number) {
  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v) => (window as any).__easydb.api.settings.set('grid', 'windowRowsFrom', v),
    n,
  );
}

async function seed(page: import('@playwright/test').Page, threshold: number) {
  await setThreshold(page, threshold);
  const id = await createTable(page, 'Wide', [{ field: 'kind' }]);
  await bulkAddRows(
    page,
    id,
    Array.from({ length: ROWS }, (_, i) => ({ kind: i === ROWS - 1 ? RARE : i % 2 === 0 ? 'even' : 'odd' })),
  );
  await waitForPanel(page, id);
  return id;
}

const openFunnel = async (page: import('@playwright/test').Page, id: string) => {
  await page
    .locator(`#${panelDomId(id)} data-table thead th button.funnel`)
    .first()
    .click();
  const pop = page.locator('filter-popover');
  await expect(pop).toBeVisible();
  return pop;
};

test('the picker admits its list is partial, and refresh completes it', async ({ page }) => {
  const id = await seed(page, 250);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await expect.poll(() => page.evaluate((d) => (document.getElementById(d)?.querySelector('data-table') as any)?.windowed, panelDomId(id))).toBe(true);

  const pop = await openFunnel(page, id);
  await expect(pop.getByTestId('facet-note')).toContainText('rows loaded so far');
  // The counts are the PAGE's, so they cannot reach the column's 1500. (Which
  // rows are in the page is not asserted: with no sort the index order is by
  // primary key, and those are random UUIDs.)
  const evenCount = () => pop.locator('li').filter({ hasText: 'even' }).locator('.count').innerText();
  expect(Number(await evenCount())).toBeLessThanOrEqual(500);

  await pop.getByTestId('facet-refresh').click();

  // Now the whole column: the real count, the note, and the one rare value that a
  // page of 500 out of 3000 will usually have missed.
  await expect.poll(async () => Number(await evenCount())).toBe(1500);
  await expect(pop.getByTestId('facet-note')).toContainText('The whole column');
  await expect(pop.locator('li').filter({ hasText: RARE })).toHaveCount(1);
});

test('a refreshed value filters the whole table', async ({ page }) => {
  const id = await seed(page, 250);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await expect.poll(() => page.evaluate((d) => (document.getElementById(d)?.querySelector('data-table') as any)?.windowed, panelDomId(id))).toBe(true);

  const pop = await openFunnel(page, id);
  await pop.getByTestId('facet-refresh').click();
  await pop.locator('li').filter({ hasText: RARE }).click();

  // One row matches, and it is the one that was never on the first page.
  const drawn = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);
  await expect(drawn).toHaveCount(1);
  await expect(drawn.first().locator('input').first()).toHaveValue(RARE);
});

test('a table under the threshold offers no note and no refresh', async ({ page }) => {
  // Nothing is missing from a list built over every row, so there is nothing to
  // admit and nothing to refresh.
  const id = await seed(page, ROWS * 10);
  // Wait for the read to land: the list is built from the rows the grid HOLDS, so
  // opening the funnel mid-load would test a page by accident.
  await expect
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .poll(() => page.evaluate((d) => (document.getElementById(d)?.querySelector('data-table') as any)?.rows?.length ?? 0, panelDomId(id)))
    .toBe(ROWS);
  const pop = await openFunnel(page, id);

  await expect(pop.locator('li').filter({ hasText: RARE })).toHaveCount(1);
  await expect(pop.getByTestId('facet-note')).toHaveCount(0);
  await expect(pop.getByTestId('facet-refresh')).toHaveCount(0);
});
