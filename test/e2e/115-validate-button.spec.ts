import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, readTable, waitForPanel } from './helpers.js';

/**
 * The ✓ button in a table's footer: check every row against its columns' rules.
 *
 * Until now a rule was only ever checked one cell at a time — as you typed — plus
 * a Save pre-flight over the rows already in memory. So a table imported from a
 * file had never been checked at all, and there was no way to ask.
 *
 * What comes back is a column of the table itself, `_error`, with the grid
 * filtered to the rows that have one. It was a second table of issues first, which
 * could be filtered and sorted and exported but could not be FIXED: the row
 * needing the edit is in the table the user was already looking at. Nothing about
 * the column is stored — see `table/row-errors.ts`.
 */

const dialogs = (page: Page) => page.locator('host-dialogs');
const toast = (page: Page) => page.locator('toast-host');
const gridRows = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);

/** Click the footer's ✓ button. */
async function validate(page: Page, id: string) {
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByTitle(/Check every row/)
    .click();
}

/** The `Problem` header, present only while a run has something to report. */
const problemHeader = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table thead th`).filter({ hasText: 'Problem' });

/**
 * The `_error` message of every row on screen, sorted.
 *
 * `nth-last-child(2)`: the last cell of a row is the delete button, and `_error`
 * is appended after the table's own columns. Sorted because rows come back in the
 * store's own order — a Dexie key is a random UUID — which is why the row a
 * duplicate names is normalized to `Row N` as well.
 */
async function problems(page: Page, id: string) {
  const cells = await gridRows(page, id).locator('td:nth-last-child(2)').allInnerTexts();
  return cells.map((t) => t.trim().replace(/Row \d+/, 'Row N')).sort();
}

/**
 * A table whose columns carry one of each rule, and four rows breaking four.
 *
 * The two `Ada`s are BOTH broken by something else as well, on purpose. Rows come
 * back in the store's own order (a Dexie key is a random UUID), so which of a
 * duplicate pair is met second — and therefore which one is reported — is not
 * fixed. With both already flagged, the number of flagged ROWS is: 3 of 4, every
 * run.
 */
async function pets(page: Page) {
  const id = await createTable(page, 'Pets', [
    { field: 'name', label: 'Name', notnull: true, unique: true },
    { field: 'age', label: 'Age', type: 'number', max: 20 },
    { field: 'email', label: 'Email', validate: 'function validate(value) { if (value && !String(value).includes("@")) throw "is not an address"; }' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'Bo', age: 5, email: 'bo@example.test' }, // nothing wrong
    { name: '', age: 4, email: 'ok@example.test' }, // Name empty
    { name: 'Ada', age: 40, email: 'ada@example.test' }, // Age over 20
    { name: 'Ada', age: 6, email: 'nope' }, // Email rejected — and one of the two is the duplicate
  ]);
  return id;
}

test('the summary names every column with a problem, and the grid shows the bad rows only', async ({ page }) => {
  const id = await pets(page);
  await expect(gridRows(page, id)).toHaveCount(4);
  await validate(page, id);

  const d = dialogs(page);
  await expect(d.getByRole('heading', { name: 'Validate' })).toBeVisible();
  await expect(d.getByText(/4 issues in 3 of 4 rows of "Pets"/)).toBeVisible();
  await expect(d.getByText(/Name: 1 empty, 1 duplicated/)).toBeVisible();
  await expect(d.getByText(/Age: 1 over the maximum/)).toBeVisible();
  await expect(d.getByText(/Email: 1 rejected by a script/)).toBeVisible();
  await d.getByRole('button', { name: 'Close' }).click();

  // The clean row is gone, and the column carrying the reason has appeared.
  await expect(gridRows(page, id)).toHaveCount(3);
  await expect(problemHeader(page, id)).toHaveCount(1);
  // Every reason is on screen, each naming its own column. Which ROW carries the
  // duplicate is up to the store's order, so the messages are read as a set.
  const said = (await problems(page, id)).join(' | ');
  expect(said).toContain('Name is empty');
  expect(said).toContain('Name duplicates');
  expect(said).toContain('Age value 40 is over the maximum of 20');
  expect(said).toContain('Email is not an address');
});

test('nothing about it is stored: not the value, not the filter', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(3);

  // The rows in the store never gained the field...
  const stored = await readRows(page, id);
  expect(stored.every((r) => !('_error' in (r.data as Record<string, unknown>)))).toBe(true);
  // ...and the table record was not left filtered on a column it does not have.
  const table = await readTable(page, id);
  expect(Object.keys(table?.filters ?? {})).not.toContain('_error');

  // So a reload is a table with nothing wrong with it — the verdict does not
  // outlive the run that made it.
  await page.reload();
  await waitForPanel(page, id);
  await expect(gridRows(page, id)).toHaveCount(4);
  await expect(problemHeader(page, id)).toHaveCount(0);
});

test('the filter can be cleared to see every row beside its message', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(3);

  // The Problem column has an ordinary funnel, holding an ordinary filter.
  await page.locator(`#${panelDomId(id)} data-table thead th`).filter({ hasText: 'Problem' }).locator('button.funnel').click();
  const popover = page.locator('filter-popover');
  await expect(popover).toBeVisible();
  await popover.getByRole('button', { name: 'Clear filter' }).click();

  await expect(gridRows(page, id)).toHaveCount(4);
  // The column stays: the messages are still there to be read.
  await expect(problemHeader(page, id)).toHaveCount(1);
});

test('Show me brings the table forward, and no second table is made', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Show me' }).click();
  await waitForPanel(page, id);

  const tables = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (await (window as any).__easydb.store.tables.find()) as Array<{ name: string }>;
    return all.map((t) => t.name);
  });
  expect(tables).toEqual(['Pets']);
});

test('running it again drops the rows that were repaired', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(3);

  // Fix the empty name — with a name no other row has, or the repair would only
  // trade "is empty" for "duplicates".
  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = (await ctx.store.rows(tid).find()) as Array<{ id: string; data: Record<string, unknown> }>;
    const blank = rows.find((r) => r.data.name === '')!;
    await ctx.store.rows(tid).patch(blank.id, { data: { ...blank.data, name: 'Zoe' }, updatedAt: Date.now() });
  }, id);

  await validate(page, id);
  await expect(dialogs(page).getByText(/3 issues in 2 of 4 rows of "Pets"/)).toBeVisible();
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(2);
  const left = (await problems(page, id)).join(' | ');
  expect(left).not.toContain('is empty');
  expect(left).toContain('Name duplicates');
});

test('a clean run takes the column back down', async ({ page }) => {
  const id = await createTable(page, 'Clean', [{ field: 'name', label: 'Name', notnull: true, unique: true }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: '' }, { name: 'Bo' }]);

  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(1);

  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = (await ctx.store.rows(tid).find()) as Array<{ id: string; data: Record<string, unknown> }>;
    const blank = rows.find((r) => r.data.name === '')!;
    await ctx.store.rows(tid).patch(blank.id, { data: { ...blank.data, name: 'Ada' }, updatedAt: Date.now() });
  }, id);

  await validate(page, id);
  await expect(toast(page).getByText(/No issues in all 2 rows of "Clean"/)).toBeVisible();
  // Nothing left to say, so the column and its filter go.
  await expect(gridRows(page, id)).toHaveCount(2);
  await expect(problemHeader(page, id)).toHaveCount(0);
});

test('a table with no rules is not scanned at all', async ({ page }) => {
  // The honest answer to "check this" when no column says what would be wrong.
  // It also means the button costs nothing on a big imported table.
  const id = await createTable(page, 'Loose', [{ field: 'anything' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ anything: '' }, { anything: null }]);

  await validate(page, id);
  await expect(toast(page).getByText(/no column of "Loose" carries a rule/i)).toBeVisible();
});
