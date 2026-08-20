import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, readTable, waitForPanel } from './helpers.js';

/**
 * The ✓ button in a table's footer: check every row against its columns' rules.
 *
 * Until now a rule was only ever checked one cell at a time — as you typed — plus
 * a Save pre-flight over the rows already in memory. So a table imported from a
 * file had never been checked at all, and there was no way to ask.
 *
 * A run leaves three things: a mark on every cell that is wrong (with the reason
 * in its tooltip), the grid narrowed to those rows, and a hidden `_error` column
 * holding each row's whole verdict. The column is ordinary — the columns editor
 * shows it, and renaming it makes it the user's own.
 */

const dialogs = (page: Page) => page.locator('host-dialogs');
const toast = (page: Page) => page.locator('toast-host');
const gridRows = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);
/** Cells the last run flagged. */
const flagged = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table tbody td.is-problem`);

/** Click the footer's ✓ button. */
async function validate(page: Page, id: string) {
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByTitle(/Check every row/)
    .click();
}

/** Headers the grid is showing. */
const headers = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table thead th`);

/** Every flagged cell's tooltip, sorted — the reasons the user can hover for. */
async function reasons(page: Page, id: string) {
  const titles = await flagged(page, id).evaluateAll((tds) => tds.map((td) => td.getAttribute('title') ?? ''));
  return titles.map((t) => t.replace(/Row \d+/, 'Row N')).sort();
}

/** The `_error` value stored on every row, sorted. */
async function stored(page: Page, id: string) {
  const rows = await readRows(page, id);
  return rows.map((r) => String((r.data as Record<string, unknown>)._error ?? '')).sort();
}

/**
 * A table whose columns carry one of each rule, and four rows breaking four.
 *
 * The two `Ada`s are BOTH broken by something else as well, on purpose. Rows come
 * back in the store's own order (a Dexie key is a random UUID), so which of a
 * duplicate pair is met second — and therefore which one is reported — is not
 * fixed. With both already flagged, the count is: 4 flagged cells in 3 of 4 rows,
 * every run.
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
    { name: 'Ada', age: 6, email: 'nope' }, // Email rejected — one of the two is the duplicate
  ]);
  return id;
}

test('the cell that is wrong is marked, and its tooltip says why', async ({ page }) => {
  const id = await pets(page);
  await expect(gridRows(page, id)).toHaveCount(4);
  await validate(page, id);

  const d = dialogs(page);
  await expect(d.getByText(/4 issues in 3 of 4 rows of "Pets"/)).toBeVisible();
  await expect(d.getByText(/Name: 1 empty, 1 duplicated/)).toBeVisible();
  await expect(d.getByText(/Age: 1 over the maximum/)).toBeVisible();
  await expect(d.getByText(/Email: 1 rejected by a script/)).toBeVisible();
  await d.getByRole('button', { name: 'Close' }).click();

  // The clean row is gone and each remaining row shows which cell is at fault.
  await expect(gridRows(page, id)).toHaveCount(3);
  await expect(flagged(page, id)).toHaveCount(4);
  const said = (await reasons(page, id)).join(' | ');
  expect(said).toContain('Name is empty');
  expect(said).toContain('Name duplicates');
  expect(said).toContain('Age value 40 is over the maximum of 20');
  expect(said).toContain('Email is not an address');
});

test('the verdict lands in a hidden _error column of the table itself', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(3);

  // A real column, so the columns editor can show it and a rename can claim it...
  const table = await readTable(page, id);
  const col = (table?.columns as Array<Record<string, unknown>>).find((c) => c.field === '_error');
  expect(col).toMatchObject({ field: '_error', label: 'Problem', type: 'text', hidden: true });
  // ...but not in the grid, which says it cell by cell instead.
  await expect(headers(page, id).filter({ hasText: 'Problem' })).toHaveCount(0);

  // One message per flagged row, and nothing on the clean one.
  const messages = await stored(page, id);
  expect(messages.filter((m) => m !== '')).toHaveLength(3);
  expect(messages.filter((m) => m === '')).toHaveLength(1);
  expect(messages.join(' | ')).toContain('Name is empty');
});

test('a run clears the messages it no longer stands behind, even after a reload', async ({ page }) => {
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

  // The reload is the point: the cell marks are gone with the session, and the
  // only record of the last run is the text in the rows. A run has to correct that.
  await page.reload();
  await waitForPanel(page, id);
  await expect(gridRows(page, id)).toHaveCount(4);
  await expect(flagged(page, id)).toHaveCount(0);

  await validate(page, id);
  await expect(dialogs(page).getByText(/3 issues in 2 of 4 rows of "Pets"/)).toBeVisible();
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(2);
  const messages = (await stored(page, id)).filter((m) => m !== '');
  expect(messages).toHaveLength(2);
  expect(messages.join(' | ')).not.toContain('is empty');
});

test('renaming the column makes it the user’s own, and the next run makes a new one', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(3);

  // Rename `_error` → `kept`, as the columns editor does: patch the columns, then
  // re-key the rows so the messages come along as ordinary data.
  //
  // Re-keyed only where the old field is STILL THERE, which is what
  // `renameRowFields` does and why this has to copy it. The store moves the
  // values itself — a positional rename becomes `ALTER TABLE … RENAME COLUMN`
  // (`edb-store.ts`) — so by the time these rows are read the messages are
  // already under `kept`, and writing `kept: _error ?? ''` over them would empty
  // the column this test is about.
  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = await ctx.store.tables.findOne(tid);
    const columns = (t.columns as Array<Record<string, unknown>>).map((c) => (c.field === '_error' ? { ...c, field: 'kept', label: 'Kept', hidden: false } : c));
    await ctx.store.tables.patch(tid, { columns, updatedAt: Date.now() });
    const rows = (await ctx.store.rows(tid).find()) as Array<{ id: string; data: Record<string, unknown> }>;
    for (const r of rows) {
      if (!Object.prototype.hasOwnProperty.call(r.data, '_error')) continue;
      const { _error, ...rest } = r.data;
      await ctx.store.rows(tid).patch(r.id, { data: { ...rest, kept: _error ?? '' }, updatedAt: Date.now() });
    }
  }, id);

  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();

  const table = await readTable(page, id);
  const fields = (table?.columns as Array<Record<string, unknown>>).map((c) => c.field);
  // Their column stayed, and a fresh `_error` was made for this run.
  expect(fields).toContain('kept');
  expect(fields).toContain('_error');
  const rows = await readRows(page, id);
  const keptText = rows.map((r) => String((r.data as Record<string, unknown>).kept ?? '')).filter(Boolean);
  expect(keptText).toHaveLength(3);
});

test('the pink can be switched off without taking the reason with it', async ({ page }) => {
  // Set before the grid exists: only the Settings dialog announces a change, so a
  // programmatic write is picked up when a grid next reads its preferences.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.api.settings.set('grid', 'highlightErrors', false);
  });
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();
  await expect(gridRows(page, id)).toHaveCount(3);

  await expect(flagged(page, id)).toHaveCount(0);
  // The tooltip is not a preference: a reason nobody can read is a loss, not a taste.
  const titles = await page.locator(`#${panelDomId(id)} data-table tbody td`).evaluateAll((tds) => tds.map((td) => td.getAttribute('title') ?? ''));
  expect(titles.join(' | ')).toContain('is over the maximum of 20');
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

test('a clean run takes the marks and the filter back down', async ({ page }) => {
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
  await expect(gridRows(page, id)).toHaveCount(2);
  await expect(flagged(page, id)).toHaveCount(0);
  // And the message that was there is gone, not just unmarked.
  expect((await stored(page, id)).join('')).toBe('');
});

test('a table with no rules is not scanned at all', async ({ page }) => {
  // The honest answer to "check this" when no column says what would be wrong.
  // It also means the button costs nothing on a big imported table.
  const id = await createTable(page, 'Loose', [{ field: 'anything' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ anything: '' }, { anything: null }]);

  await validate(page, id);
  await expect(toast(page).getByText(/no column of "Loose" carries a rule/i)).toBeVisible();
  // Nothing to say, so no column either.
  const table = await readTable(page, id);
  expect((table?.columns as Array<Record<string, unknown>>).map((c) => c.field)).not.toContain('_error');
});
