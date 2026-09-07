import { test, expect, type Page } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Editing an existing record in the record form — the same form the + button
 * opens, over a row that is already there.
 *
 * Two ways in: a double-click on the row (the `edit-record` plugin) and the
 * `edit/…` commandlet. Both land in one dialog, and the dialog — not the caller
 * — decides whether the record may be written, from `Table.readonly`.
 */

const form = (page: Page) => page.locator('new-record-dialog dialog');
const grid = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table`);

/** A field's input, found by the label the form shows. */
const boxFor = (page: Page, label: string) => form(page).locator('label.field', { hasText: label }).locator('input, textarea').first();

/** Run a commandlet the way a link does: through the hash. */
async function runCommandlet(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    location.hash = `#${t}`;
  }, text);
}

/** Mark the table read-only, as a reference table or the user's own switch does. */
async function makeReadonly(page: Page, tableId: string): Promise<void> {
  await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.store.tables.patch(id, { readonly: true });
  }, tableId);
}

test.describe('the record form over an existing row', () => {
  test('a double-click on a row opens it, and Save patches that row', async ({ page }) => {
    const id = await createTable(page, 'Parts', [{ field: 'sku' }, { field: 'qty', type: 'number' }]);
    await addRow(page, id, { sku: 'A-1', qty: 4 });
    await addRow(page, id, { sku: 'B-2', qty: 9 });
    await waitForPanel(page, id);

    await grid(page, id).locator('tr[data-row-id]').first().dblclick();
    await expect(form(page)).toBeVisible();
    await expect(form(page)).toContainText('Edit record');
    // The row's own values, not a blank form.
    await expect(boxFor(page, 'sku')).toHaveValue('A-1');
    await expect(boxFor(page, 'qty')).toHaveValue('4');

    await boxFor(page, 'qty').fill('7');
    await form(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form(page)).toBeHidden();

    // One row changed, no row added.
    const rows = await readRows(page, id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { data: Record<string, unknown> }) => r.data.sku === 'A-1').data).toEqual({ sku: 'A-1', qty: 7 });
    expect(rows.find((r: { data: Record<string, unknown> }) => r.data.sku === 'B-2').data).toEqual({ sku: 'B-2', qty: 9 });
  });

  test('Cancel leaves the row as it was', async ({ page }) => {
    const id = await createTable(page, 'Parts', [{ field: 'sku' }]);
    await addRow(page, id, { sku: 'A-1' });
    await waitForPanel(page, id);

    await grid(page, id).locator('tr[data-row-id]').first().dblclick();
    await boxFor(page, 'sku').fill('changed');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(form(page)).toBeHidden();
    expect((await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data)).toEqual([{ sku: 'A-1' }]);
  });

  test('a read-only table opens the record read-only, with no Save', async ({ page }) => {
    const id = await createTable(page, 'Refs', [{ field: 'code' }, { field: 'note' }]);
    await addRow(page, id, { code: 'X', note: 'fixed' });
    await makeReadonly(page, id);
    await waitForPanel(page, id);

    await grid(page, id).locator('tr[data-row-id]').first().dblclick();
    await expect(form(page)).toBeVisible();
    await expect(form(page)).toContainText('This table is read-only');
    await expect(form(page)).not.toContainText('Edit record');
    await expect(form(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(boxFor(page, 'code')).toBeDisabled();

    await form(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(form(page)).toBeHidden();
  });

  test('the edit commandlet finds the record by key, by field and by filter', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'code' }, { field: 'author' }]);
    await addRow(page, id, { code: 'n-17', author: 'Smith' });
    await addRow(page, id, { code: 'n-18', author: 'Jones' });
    await waitForPanel(page, id);

    // By key — the first column, matched exactly.
    await runCommandlet(page, 'edit/Notes/n-18');
    await expect(boxFor(page, 'code')).toHaveValue('n-18');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();

    // By a named field and its value.
    await runCommandlet(page, 'edit/Notes/author/Smith');
    await expect(boxFor(page, 'code')).toHaveValue('n-17');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();

    // By the query alone.
    await runCommandlet(page, 'edit/Notes?author==Jones');
    await expect(boxFor(page, 'code')).toHaveValue('n-18');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('an edit commandlet matching nothing says so instead of opening a blank form', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'code' }]);
    await addRow(page, id, { code: 'n-17' });
    await waitForPanel(page, id);

    await runCommandlet(page, 'edit/Notes/nope');
    await expect(page.locator('toast-host')).toContainText(/No row in "Notes" matches/);
    await expect(form(page)).toBeHidden();
  });
});
