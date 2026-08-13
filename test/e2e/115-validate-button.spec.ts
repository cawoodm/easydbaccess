import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The ✓ button in a table's footer: check every row against its columns' rules.
 *
 * Until now a rule was only ever checked one cell at a time — as you typed — plus
 * a Save pre-flight over the rows already in memory. So a table imported from a
 * file had never been checked at all, and there was no way to ask.
 *
 * The answer is a TABLE of issues, not a list in a dialog: "let me filter and fix
 * these" wants filtering, sorting and exporting, and this app has all three for
 * tables already. The dialog is the summary; the table is what you work from.
 */

const dialogs = (page: Page) => page.locator('host-dialogs');
const toast = (page: Page) => page.locator('toast-host');

/** Click the footer's ✓ button. */
async function validate(page: Page, id: string) {
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByTitle(/Check every row/)
    .click();
}

/** Every row of the issues table, as `column | problem` strings. */
async function issueRows(page: Page, name: string) {
  return page.evaluate(async (n) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const all = (await ctx.store.tables.find()) as Array<{ id: string; name: string; workspaceId: string }>;
    const t = all.find((x) => x.name === n && x.workspaceId === ctx.workspaceId);
    if (!t) return null;
    const rows = (await ctx.store.rows(t.id).find()) as Array<{ data: Record<string, unknown> }>;
    // `Row 3` → `Row N`: rows come back in the store's own order (a Dexie key is a
    // random UUID), so which row is "first" — and therefore which one a duplicate
    // names — is not fixed. What matters is that the duplicate was found.
    return rows.map((r) => `${String(r.data.column)} | ${String(r.data.problem)}`.replace(/Row \d+/, 'Row N')).sort();
  }, name);
}

/** A table whose columns carry one of each rule, and rows that break three. */
async function pets(page: Page) {
  const id = await createTable(page, 'Pets', [
    { field: 'name', label: 'Name', notnull: true, unique: true },
    { field: 'age', label: 'Age', type: 'number', max: 20 },
    { field: 'email', label: 'Email', validate: 'function validate(value) { if (value && !String(value).includes("@")) throw "is not an address"; }' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'Ada', age: 3, email: 'ada@example.test' },
    { name: '', age: 4, email: 'bo@example.test' }, // Name empty
    { name: 'Ada', age: 40, email: 'nope' }, // Name duplicated, Age over 20, Email rejected
  ]);
  return id;
}

test('the summary names every column with a problem, and the issues land in a table', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);

  const d = dialogs(page);
  await expect(d.getByRole('heading', { name: 'Validate' })).toBeVisible();
  await expect(d.getByText(/4 issues in 3 rows of "Pets"/)).toBeVisible();
  await expect(d.getByText(/Name: 1 empty, 1 duplicated/)).toBeVisible();
  await expect(d.getByText(/Age: 1 over the maximum/)).toBeVisible();
  await expect(d.getByText(/Email: 1 rejected by a script/)).toBeVisible();

  await expect.poll(() => issueRows(page, 'Pets issues')).toEqual(['Age | value 40 is over the maximum of 20', 'Email | is not an address', 'Name | duplicates Row N', 'Name | is empty']);
});

test('Show me opens the issues table’s window', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await dialogs(page).getByRole('button', { name: 'Show me' }).click();

  const issuesId = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const all = (await ctx.store.tables.find()) as Array<{ id: string; name: string }>;
    return all.find((t) => t.name === 'Pets issues')!.id;
  });
  await waitForPanel(page, issuesId);
  // Read-only: every row in it is a copy of a problem, and fixing the copy fixes
  // nothing. So no Add row button.
  await expect(page.locator(`#${panelDomId(issuesId)} panel-footer`).getByLabel('Add row')).toHaveCount(0);
});

test('running it again replaces the issues instead of piling up a second table', async ({ page }) => {
  const id = await pets(page);
  await validate(page, id);
  await expect.poll(async () => (await issueRows(page, 'Pets issues'))?.length).toBe(4);
  await dialogs(page).getByRole('button', { name: 'Close' }).click();

  // Fix the empty name, then ask again.
  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = (await ctx.store.rows(tid).find()) as Array<{ id: string; data: Record<string, unknown> }>;
    const blank = rows.find((r) => r.data.name === '')!;
    await ctx.store.rows(tid).patch(blank.id, { data: { ...blank.data, name: 'Bo' }, updatedAt: Date.now() });
  }, id);

  // The issues window sits over the Pets footer, so front Pets before reaching for
  // its buttons again.
  await page.locator(`#${panelDomId(id)} .jsPanel-hdr`).click();
  await validate(page, id);
  await expect.poll(() => issueRows(page, 'Pets issues')).toEqual(['Age | value 40 is over the maximum of 20', 'Email | is not an address', 'Name | duplicates Row N']);
  // One issues table, not two: a second run must not become "Pets issues-2".
  const named = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (await (window as any).__easydb.store.tables.find()) as Array<{ name: string }>;
    return all.filter((t) => t.name.startsWith('Pets issues')).length;
  });
  expect(named).toBe(1);
});

test('a clean table says so, and writes no table', async ({ page }) => {
  const id = await createTable(page, 'Clean', [{ field: 'name', label: 'Name', notnull: true, unique: true }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Ada' }, { name: 'Bo' }]);

  await validate(page, id);
  await expect(toast(page).getByText(/No issues in all 2 rows of "Clean"/)).toBeVisible();
  expect(await issueRows(page, 'Clean issues')).toBeNull();
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
