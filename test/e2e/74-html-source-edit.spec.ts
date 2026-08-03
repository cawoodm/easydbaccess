import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Editing an HTML cell has to reach the cell's SOURCE.
 *
 * On a scripted column the cell shows the script's OUTPUT, and the editor used
 * to save that output over the stored field — one edit and the Markdown the
 * script reads was gone, replaced by the HTML it had produced. It also used to
 * open on any click in the cell, so a link in the rendered markup could not be
 * followed and a feed-sized value had to be typed into a one-line input. Both
 * are now one pencil on the right of the column.
 */

/**
 * The script reads the column's OWN field, which is the shape this matters for:
 * `rawValue` is that stored field, so the editor and the script see the same
 * text. (A script reading a NEIGHBOURING field has no source of its own to
 * edit — `rawValue` is then the column's own empty cell.)
 */
const SCRIPT = 'function render(row) { return markdownToHtml(row.body); }';

function cellOf(page: import('@playwright/test').Page, tableId: string, nth: number) {
  return page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody tr td').nth(nth);
}

function editor(page: import('@playwright/test').Page) {
  return page.locator('[id^="easydb-html-edit-"]').last();
}

test('the pencil on a scripted column opens the SOURCE, not the rendered output', async ({ page }) => {
  const tableId = await createTable(page, 'srcedit', [{ field: 'body', renderer: 'html', script: SCRIPT }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { body: '# One' });

  const cell = cellOf(page, tableId, 0);
  await expect(cell.locator('h1')).toHaveText('One');

  await cell.locator('html-render-cell button').click();
  const ta = editor(page).locator('textarea');
  await expect(ta).toHaveValue('# One');

  await ta.fill('# Two');
  await editor(page).getByRole('button', { name: 'Save' }).click();

  // The script re-runs on the new source, so the cell follows.
  await expect(cell.locator('h1')).toHaveText('Two');
  const rows = await readRows(page, tableId);
  expect(rows[0].data.body).toBe('# Two');
  // The computed HTML must not have been written over the Markdown.
  expect(JSON.stringify(rows[0].data)).not.toContain('<h1>');
});

test('clicking the rendered markup does not open the editor', async ({ page }) => {
  const tableId = await createTable(page, 'srcnoclick', [{ field: 'body', renderer: 'html', script: SCRIPT }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { body: 'a [link](https://x.dev) in prose' });

  const cell = cellOf(page, tableId, 0);
  const link = cell.locator('a');
  await expect(link).toHaveAttribute('href', 'https://x.dev');

  // The anchor is the click target now, so click the text beside it instead —
  // neither one may open an editor.
  await cell.locator('p').click({ position: { x: 2, y: 2 } });
  await expect(page.locator('[id^="easydb-html-edit-"]')).toHaveCount(0);
});

test('the pencil on a plain HTML column edits the stored value itself', async ({ page }) => {
  const tableId = await createTable(page, 'srcplain', [{ field: 'body', renderer: 'html' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { body: '<b>before</b>' });

  const cell = cellOf(page, tableId, 0);
  await expect(cell.locator('b')).toHaveText('before');

  await cell.locator('html-render-cell button').click();
  const ta = editor(page).locator('textarea');
  await expect(ta).toHaveValue('<b>before</b>');

  await ta.fill('<i>after</i>');
  await editor(page).getByRole('button', { name: 'Save' }).click();

  await expect(cell.locator('i')).toHaveText('after');
  const rows = await readRows(page, tableId);
  expect(rows[0].data.body).toBe('<i>after</i>');
});
