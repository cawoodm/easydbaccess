import { test, expect, type Page } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The trash button in a table's footer asks WHAT should go.
 *
 * "Delete" means three different things on a table, and the button used to assume
 * the most destructive one: it confirmed, then took the table and every row. There
 * was no way to empty a table you wanted to keep, and no way to drop the rows a
 * filter had picked out — the two things a user reaches for far more often than
 * dropping the table.
 *
 * So the button now offers, and the choice IS the confirmation: each option says
 * what it takes and how many rows that is, and Cancel sits in the dialog header.
 * A second yes/no dialog would add a click to every delete.
 *
 * Two rules the options follow, both asserted below:
 *
 *  - "Delete Visible Data" appears only when a filter or a search NARROWS the
 *    table. With nothing narrowing it would delete exactly what the option above
 *    it deletes, which is a trap rather than a choice.
 *  - An empty table is offered no data options at all.
 */

const rows = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);
const dialogs = (page: Page) => page.locator('host-dialogs');
const title = (page: Page, id: string) => page.locator(`#${panelDomId(id)} .panel-title, #${panelDomId(id)} .jsPanel-title`).first();

/** Click the footer's trash button and wait for the "what should go?" dialog. */
async function openDeleteMenu(page: Page, id: string) {
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByTitle(/Delete this table/)
    .click();
  await expect(dialogs(page).getByRole('heading', { name: 'Delete' })).toBeVisible();
}

/** A table of four pets: two cats, a dog and a fish. */
async function pets(page: Page) {
  const id = await createTable(page, 'Pets', [{ field: 'species' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { species: 'cat' });
  await addRow(page, id, { species: 'dog' });
  await addRow(page, id, { species: 'cat' });
  await addRow(page, id, { species: 'fish' });
  // The options quote the counts the grid publishes, so wait until it has counted
  // all four — otherwise the labels below are asserted against a stale number.
  await expect(title(page, id)).toContainText('(4)');
  return id;
}

/** Filter the first column to `value` through its funnel picker. */
async function filterFirstColumn(page: Page, id: string, value: string) {
  await page
    .locator(`#${panelDomId(id)} data-table thead th button.funnel`)
    .first()
    .click();
  const popover = page.locator('filter-popover');
  await popover.locator('li').filter({ hasText: value }).click();
  await page.mouse.click(5, 5);
  await expect(popover).toBeHidden();
}

test('an unfiltered table offers its data and itself, and nothing else', async ({ page }) => {
  const id = await pets(page);
  await openDeleteMenu(page, id);

  const d = dialogs(page);
  await expect(d.getByRole('button', { name: 'Delete All Data (4 rows)' })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Delete Table', exact: true })).toBeVisible();
  // Nothing narrows the table, so this option would repeat the first one.
  await expect(d.getByRole('button', { name: /Delete Visible Data/ })).toHaveCount(0);

  // Cancel takes nothing.
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows(page, id)).toHaveCount(4);
});

test('Delete All Data empties the table and keeps it', async ({ page }) => {
  const id = await pets(page);
  await openDeleteMenu(page, id);
  await dialogs(page).getByRole('button', { name: 'Delete All Data (4 rows)' }).click();

  await expect(page.locator('toast-host').getByText(/Deleted 4 rows/)).toBeVisible();
  await expect(rows(page, id)).toHaveCount(0);
  // The table, its window and its column are still there — that is the difference
  // between this option and Delete Table.
  await expect(page.locator(`#${panelDomId(id)}`)).toHaveCount(1);
  await expect(page.locator(`#${panelDomId(id)} data-table thead th`).filter({ hasText: 'species' })).toBeVisible();
});

test('Delete Visible Data takes what the filter matched and leaves the rest', async ({ page }) => {
  const id = await pets(page);
  await filterFirstColumn(page, id, 'cat');
  await expect(rows(page, id)).toHaveCount(2);
  await expect(title(page, id)).toContainText('(2/4)');

  await openDeleteMenu(page, id);
  const d = dialogs(page);
  // All three — and "Delete Visible Data" is FIRST, which is the option Enter takes.
  // The default should be the smallest of the three deletes, not the largest.
  await expect(d.locator('button.choice')).toHaveText(['Delete Visible Data (2 rows)', 'Delete All Data (4 rows)', 'Delete Table']);
  await d.getByRole('button', { name: 'Delete Visible Data (2 rows)' }).click();

  await expect(page.locator('toast-host').getByText(/Deleted 2 rows/)).toBeVisible();
  // The filter is still on and now matches nothing.
  await expect(rows(page, id)).toHaveCount(0);

  // The dog and the fish survived: clear the filter and they are what is left.
  await page
    .locator(`#${panelDomId(id)} data-table thead th button.funnel`)
    .first()
    .click();
  await page.locator('filter-popover').getByRole('button', { name: 'Clear filter' }).click();
  await expect(rows(page, id)).toHaveCount(2);
  // A cell is an input, so its value is what to read — not the row's text. Sorted,
  // because row order is the store's: a Dexie key is a random UUID, so the two
  // survivors come back in either order.
  const cells = page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer) td input`);
  await expect.poll(() => cells.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort())).toEqual(['dog', 'fish']);
});

test('a search narrows it too — not just a column filter', async ({ page }) => {
  const id = await pets(page);
  // The panel's own search box, which starts as an icon. Its query lives nowhere
  // but the grid — that is why the grid has to publish what "visible" means (see
  // `table/visible-request.ts`).
  const search = page.locator(`#${panelDomId(id)} panel-search`);
  await search.locator('button.icon').click();
  await search.locator('input').fill('fish');
  await expect(rows(page, id)).toHaveCount(1);

  await openDeleteMenu(page, id);
  await dialogs(page).getByRole('button', { name: 'Delete Visible Data (1 row)' }).click();

  await expect(page.locator('toast-host').getByText(/Deleted 1 row/)).toBeVisible();
  // Clearing the search brings back the three that were never matched.
  await search.locator('button.icon').click();
  await search.locator('input').fill('');
  await expect(rows(page, id)).toHaveCount(3);
});

/**
 * Deleting from one table must not re-read the others.
 *
 * There is ONE `rows` table in IndexedDB for every logical table, so Dexie's
 * mutation signal could not tell one grid's rows from another's: a delete made
 * EVERY open window re-read itself, each with its own progress bar, and a chunked
 * delete did that once per chunk. Row writes are announced per table now — see
 * `db/data-store-dexie.ts`.
 *
 * Observed through `loadGeneration`, the counter the grid already bumps once per
 * `loadRows` call to discard stale answers. Counting reads is the assertion; a
 * progress bar is only how the user noticed.
 */
test('deleting from one table leaves the other tables alone', async ({ page }) => {
  const a = await pets(page);
  const b = await createTable(page, 'Cities', [{ field: 'city' }]);
  await waitForPanel(page, b);
  await addRow(page, b, { city: 'Bern' });
  await expect(title(page, b)).toContainText('(1)');

  const loads = (id: string) =>
    page.evaluate((tid) => {
      const grid = [...document.querySelectorAll('data-table')].find((g) => (g as unknown as { tableId: string }).tableId === tid);
      return (grid as unknown as { loadGeneration: number } | undefined)?.loadGeneration ?? -1;
    }, id);

  // Panels cascade, so the second one covers the first one's footer. Front the one
  // under test by its titlebar before reaching for its buttons.
  await page.locator(`#${panelDomId(a)} .jsPanel-hdr`).click();

  const beforeA = await loads(a);
  const beforeB = await loads(b);

  await openDeleteMenu(page, a);
  await dialogs(page).getByRole('button', { name: 'Delete All Data (4 rows)' }).click();
  await expect(page.locator('toast-host').getByText(/Deleted 4 rows/)).toBeVisible();
  await expect(rows(page, a)).toHaveCount(0);

  // The deleted table re-read itself, exactly as it should.
  expect(await loads(a)).toBeGreaterThan(beforeA);
  // Its neighbour did not, and still shows its own row.
  expect(await loads(b)).toBe(beforeB);
  await expect(rows(page, b)).toHaveCount(1);
});

test('an empty table is only offered Delete Table, and it goes', async ({ page }) => {
  const id = await createTable(page, 'Pets', [{ field: 'species' }]);
  await waitForPanel(page, id);
  await openDeleteMenu(page, id);

  const d = dialogs(page);
  await expect(d.getByRole('button', { name: /Delete All Data/ })).toHaveCount(0);
  await expect(d.getByRole('button', { name: /Delete Visible Data/ })).toHaveCount(0);
  await d.getByRole('button', { name: 'Delete Table', exact: true }).click();

  await expect(page.locator('toast-host').getByText(/Deleted "Pets"/)).toBeVisible();
  await expect(page.locator(`#${panelDomId(id)}`)).toHaveCount(0);
});
