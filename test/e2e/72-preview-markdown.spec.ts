import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `preview` renderer (called `html-preview` up to v0.0.281) recognises
 * Markdown in a cell and converts it. Before this, Markdown in the data reached
 * the popup as its own source — `# Title` and `**bold**` shown as text — and the
 * only way out was a column script calling `markdownToHtml` by hand.
 *
 * The inline cell stays PLAIN TEXT either way; what changes is that the markers
 * are flattened out of it instead of shown as noise.
 */

const MD = '# Title\n\nSome **bold** and a [link](https://x.dev).\n\n- one\n- two';

function cellOf(page: import('@playwright/test').Page, tableId: string) {
  return page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td preview-cell');
}

test('a Markdown value opens in the popup as rendered markup', async ({ page }) => {
  const tableId = await createTable(page, 'mdpreview', [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: MD });

  await cellOf(page, tableId).locator('button').click();

  const popup = page.locator('[id^="easydb-preview-popup-"]').last();
  await expect(popup.locator('.jsPanel-content h1')).toHaveText('Title');
  await expect(popup.locator('.jsPanel-content strong')).toHaveText('bold');
  await expect(popup.locator('.jsPanel-content a')).toHaveAttribute('href', 'https://x.dev');
  await expect(popup.locator('.jsPanel-content li')).toHaveCount(2);
  // The <pre> is the plain-text path; Markdown must not take it.
  await expect(popup.locator('.jsPanel-content pre')).toHaveCount(0);
});

test('the inline preview drops the Markdown markers instead of showing them', async ({ page }) => {
  const tableId = await createTable(page, 'mdinline', [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: '# Title\n\nSome **bold** text.' });

  const text = await cellOf(page, tableId).textContent();
  expect(text).toContain('Title Some bold text.');
  expect(text).not.toContain('#');
  expect(text).not.toContain('**');
});

test('a value that only looks like prose is still plain text in a <pre>', async ({ page }) => {
  // The detection has to be strict — a dash between two words is not a list,
  // and turning this into markup would reflow someone's plain text.
  const tableId = await createTable(page, 'mdplain', [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: 'sales - marketing\nissue #42 is open' });

  await cellOf(page, tableId).locator('button').click();

  const popup = page.locator('[id^="easydb-preview-popup-"]').last();
  const pre = popup.locator('.jsPanel-content pre');
  await expect(pre).toBeVisible();
  expect(await pre.textContent()).toContain('sales - marketing\nissue #42 is open');
});

test('a column still set to the old html-preview name renders through preview-cell', async ({
  page,
}) => {
  // The rename must not break tables already saved. `html-preview` stays a
  // registered alias for exactly this.
  const tableId = await createTable(page, 'mdlegacy', [
    { field: 'note', renderer: 'html-preview' },
  ]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: '# Title' });

  await expect(cellOf(page, tableId)).toHaveCount(1);
  await expect(cellOf(page, tableId)).toContainText('Title');
});

test('the columns editor offers "preview" and no longer offers "html-preview"', async ({ page }) => {
  const tableId = await createTable(page, 'mdoptions', [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();

  const select = page.locator('new-table-dialog dialog select[title^="Renderer"]').first();
  await expect(select).toBeVisible();
  const options = await select.locator('option').evaluateAll((els) =>
    els.map((e) => (e as HTMLOptionElement).value),
  );
  expect(options).toContain('preview');
  expect(options).not.toContain('html-preview');
});
