import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The BROWSER reads a big table one page at a time too.
 *
 * Phase 1 windowed the fetch wherever the store could answer a `RowQuery`, which
 * in the browser was nowhere: Dexie implemented none, so every table took the
 * read-it-all path and the browser and the desktop behaved differently on the same
 * table. Dexie now answers one.
 *
 * What has to stay true is the harder half. A page in memory must not narrow what a
 * filter or a sort covers — those go to the store, which applies them over every
 * row and returns the right page of the result.
 */

const ROWS = 3000;

/** Zero-padded so a text sort is obvious: 'row 2999' is the last one. */
const rowsData = () => Array.from({ length: ROWS }, (_, i) => ({ name: `row ${String(i).padStart(4, '0')}` }));

async function setThreshold(page: import('@playwright/test').Page, n: number) {
  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (v) => (window as any).__easydb.api.settings.set('grid', 'windowRowsFrom', v),
    n,
  );
}

/** What the grid is holding — the page, not the table. */
const gridState = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((domId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dt = document.getElementById(domId)?.querySelector('data-table') as any;
    return dt ? { held: dt.rows.length, windowed: dt.windowed, matching: dt.matchingTotal, offset: dt.windowOffset } : null;
  }, panelDomId(id));

async function seed(page: import('@playwright/test').Page, threshold: number) {
  await setThreshold(page, threshold);
  const id = await createTable(page, 'Wide', [{ field: 'name' }]);
  await bulkAddRows(page, id, rowsData());
  await waitForPanel(page, id);
  return id;
}

test('the browser holds one page of a big table, not the table', async ({ page }) => {
  const id = await seed(page, 250);

  // The real total arrives AFTER the rows: a windowed read never waits on a count,
  // because counting a range in IndexedDB costs seconds on a big table. So this polls
  // for the settled state rather than reading it the moment rows appear.
  await expect.poll(async () => (await gridState(page, id))?.matching, { timeout: 10_000 }).toBe(ROWS);
  const state = await gridState(page, id);
  expect(state?.windowed).toBe(true);
  expect(state?.held).toBe(500); // one page
  expect(state?.offset).toBe(0);
});

test('a filter still covers every row, not just the page', async ({ page }) => {
  // The value lives at index 2999 — far outside the first page. Narrowing in
  // memory over the page would find nothing and look like a table with no match.
  const id = await seed(page, 250);
  await expect.poll(async () => (await gridState(page, id))?.windowed).toBe(true);

  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (window as any).__easydb.store.tables.patch(tid, { filters: { name: '=row 2999' }, updatedAt: Date.now() }),
    id,
  );

  const drawn = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`);
  await expect.poll(async () => (await gridState(page, id))?.matching, { timeout: 5000 }).toBe(1);
  await expect(drawn.first().locator('input').first()).toHaveValue('row 2999');
});

test('a sort covers every row, so the last one can be first', async ({ page }) => {
  const id = await seed(page, 250);
  await expect.poll(async () => (await gridState(page, id))?.windowed).toBe(true);

  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (window as any).__easydb.store.tables.patch(tid, { sortBy: [{ field: 'name', asc: false }], updatedAt: Date.now() }),
    id,
  );

  const top = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer) input`).first();
  await expect(top).toHaveValue('row 2999');
  // Still a page: a sort must not turn into a reason to hold everything.
  expect((await gridState(page, id))?.held).toBe(500);
});

test('a table under the threshold is held whole, as before', async ({ page }) => {
  const id = await seed(page, ROWS * 10);

  await expect.poll(async () => (await gridState(page, id))?.held).toBe(ROWS);
  expect((await gridState(page, id))?.windowed).toBe(false);
});
