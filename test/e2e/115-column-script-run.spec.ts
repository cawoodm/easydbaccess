import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * The script editor's **Run**: take what `render(row)` returns and WRITE it into
 * the cells, turning a computed column into ordinary data.
 *
 * Everything else about a column script leaves the stored cell alone, so this is
 * the one path that changes data the user cannot get back — hence the two
 * questions before it writes, and hence these tests are about the questions as
 * much as about the write.
 */

const UPPER = 'function render(row) { return String(row.name).toUpperCase(); }';

/** Open Columns → the script pencil of column `idx` → the editor. */
async function openScript(page: import('@playwright/test').Page, tableId: string, idx: number) {
  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('button.script-btn').nth(idx).click();
  const editor = page.locator('script-editor-dialog dialog');
  await expect(editor).toBeVisible();
  return { dlg, editor };
}

test('Run writes the script’s value into the cells and can clear the script', async ({ page }) => {
  const id = await createTable(page, 'Runner', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });
  await addRow(page, id, { name: 'bob' });

  const { dlg, editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();

  // One question only: nothing is filtered, so "which rows" has one answer.
  const host = page.locator('host-dialogs');
  await expect(host.getByRole('button', { name: 'Write and clear the script', exact: true })).toBeVisible();
  await host.getByRole('button', { name: 'Write and clear the script', exact: true }).click();

  // The write is immediate — it does not wait for the columns editor's Save.
  await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['shout']).sort()).toEqual(['ADA', 'BOB']);

  // The editor closed, and the column came back with no script — so once the
  // columns editor saves, the cells show stored data rather than a computation.
  await expect(editor).toBeHidden();
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();
  // Read the titles, not the text: with the script gone the cell is an editable
  // input again, so its value is not a text node. Sorted, because nothing here
  // pins the grid's row order.
  await expect
    .poll(async () =>
      (await page.locator(`#${panelDomId(id)} data-table tbody td.t-string`).evaluateAll((tds) => tds.map((td) => td.getAttribute('title')))).filter((t) => t === 'ADA' || t === 'BOB').sort(),
    )
    .toEqual(['ADA', 'BOB']);

  const table = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(table[1].script).toBeUndefined();
});

test('Run can keep the script, leaving the column computed', async ({ page }) => {
  const id = await createTable(page, 'Keeper', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });

  const { dlg, editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();
  await page.locator('host-dialogs').getByRole('button', { name: 'Write and keep the script', exact: true }).click();

  await expect.poll(async () => (await readRows(page, id))[0].data['shout']).toBe('ADA');
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  const table = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tid) => (await (window as any).__easydb.store.tables.findOne(tid)).columns,
    id,
  );
  expect(table[1].script).toContain('toUpperCase');
});

test('Run asks which rows when the grid is filtered, and honours the answer', async ({ page }) => {
  const id = await createTable(page, 'Scoped', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'ada' }, { name: 'bob' }, { name: 'cy' }]);

  // Narrow the grid to one row; the pane the editor reads is the same set.
  const funnel = page.locator(`#${panelDomId(id)} data-table filter-combobox`).first();
  await funnel.locator('input').fill('ada');
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr`)).toHaveCount(1);

  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill(UPPER);
  await editor.getByTestId('script-run').click();

  const host = page.locator('host-dialogs');
  await host.getByRole('button', { name: 'Only the 1 rows shown', exact: true }).click();
  await host.getByRole('button', { name: 'Write and keep the script', exact: true }).click();

  // Only the filtered row is written; the other two keep an empty cell.
  await expect.poll(async () => (await readRows(page, id)).filter((r: { data: Record<string, unknown> }) => r.data['shout'] !== undefined).length).toBe(1);
});

test('Run is not offered while the table is still being created', async ({ page }) => {
  // There are no rows to write to yet, and the field is not a key any row uses.
  await page
    .locator('app-shell')
    .getByRole('button', { name: /New table/i })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('script-run')).toHaveCount(0);
});

test('a row the script throws on is skipped, and the run says how many', async ({ page }) => {
  const id = await createTable(page, 'Partial', [{ field: 'name' }, { field: 'shout' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'ada' }, {}, { name: 'cy' }]);

  const { editor } = await openScript(page, id, 1);
  await editor.locator('textarea').fill('function render(row) { if (!row.name) throw new Error("no name"); return row.name.toUpperCase(); }');
  await editor.getByTestId('script-run').click();
  await page.locator('host-dialogs').getByRole('button', { name: 'Write and keep the script', exact: true }).click();

  await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['shout'] ?? '').sort()).toEqual(['', 'ADA', 'CY']);
  await expect(page.locator('toast-host')).toContainText('1 failed');
});
