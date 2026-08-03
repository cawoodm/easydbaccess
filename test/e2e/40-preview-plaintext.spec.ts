import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `preview` cell renderer's popup used to always set
 * `innerHTML = value`, which is correct for real HTML but wrong for plain
 * text: newlines collapse into a run-on paragraph and any `<`/`&` in the
 * text gets parsed as markup and silently mangled. Plain-text values must
 * now render inside a `<pre>` (via `textContent`), preserving line breaks
 * and escaping safely; real HTML values must still render as markup.
 */

test('a multi-line plain-text value opens in a <pre>, preserving line breaks and a literal "<"', async ({
  page,
}) => {
  const value = 'line one\nline two has a < b in it\nline three';

  const tableId = await createTable(page, 'htmlprevplain', [
    { field: 'note', renderer: 'preview' },
  ]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: value });

  const cell = page
    .locator(`#${panelDomId(tableId)}`)
    .locator('data-table tbody td preview-cell');
  await cell.locator('button').click();

  const popup = page.locator('[id^="easydb-preview-popup-"]').last();
  const pre = popup.locator('.jsPanel-content pre');
  await expect(pre).toBeVisible();

  const text = await pre.textContent();
  expect(text).toContain('line one\nline two has a < b in it\nline three');
});

test('a real HTML value still renders as markup, not a <pre>', async ({ page }) => {
  const tableId = await createTable(page, 'htmlprevhtml', [
    { field: 'note', renderer: 'preview' },
  ]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: '<p>Hello</p><p><b>World</b></p>' });

  const cell = page
    .locator(`#${panelDomId(tableId)}`)
    .locator('data-table tbody td preview-cell');
  await cell.locator('button').click();

  const popup = page.locator('[id^="easydb-preview-popup-"]').last();
  await expect(popup.locator('.jsPanel-content pre')).toHaveCount(0);
  await expect(popup.locator('.jsPanel-content p b')).toHaveText('World');
});
