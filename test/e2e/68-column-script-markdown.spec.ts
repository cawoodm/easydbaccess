import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * `markdownToHtml` is injected into every column script, and pairing it with
 * the `html` renderer is how a Markdown column is displayed as formatted text.
 * This proves the whole chain in the real app — the helper is in scope, the
 * script's return value reaches the renderer, and the renderer shows it as
 * markup rather than as its own source.
 */

const MD = '# Title\n\nSome **bold** and a [link](https://x.dev).\n\n- one\n- two';

test('a column script can call markdownToHtml, and the html renderer shows it', async ({ page }) => {
  const id = await createTable(page, 'Notes', [
    { field: 'notes' },
    {
      field: 'pretty',
      renderer: 'html',
      script: 'function render(row) { return markdownToHtml(row.notes); }',
    },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ notes: MD }]);

  const cell = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td')
    .nth(1);
  await expect(cell.locator('h1')).toHaveText('Title');
  await expect(cell.locator('strong')).toHaveText('bold');
  await expect(cell.locator('a')).toHaveAttribute('href', 'https://x.dev');
  await expect(cell.locator('li')).toHaveCount(2);
});

test('the `easydb` namespace reaches a script too', async ({ page }) => {
  const id = await createTable(page, 'Ns', [
    { field: 'notes' },
    {
      field: 'pretty',
      renderer: 'html',
      script: 'function render(row) { return easydb.markdownToHtml(row.notes); }',
    },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ notes: '*em*' }]);

  await expect(
    page
      .locator(`#${panelDomId(id)}`)
      .locator('data-table tbody tr td')
      .nth(1)
      .locator('em'),
  ).toHaveText('em');
});

test('HTML embedded in the DATA is sanitized, not executed', async ({ page }) => {
  // The markdown comes from a cell, which came from an import — so it is not
  // trusted. Since v0.0.281 its tags are SANITIZED rather than escaped: the
  // formatting a feed body carries survives, while anything that can run is
  // rebuilt away.
  const id = await createTable(page, 'Unsafe', [
    { field: 'notes' },
    {
      field: 'pretty',
      renderer: 'html',
      script: 'function render(row) { return markdownToHtml(row.notes); }',
    },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    {
      notes: '<img src=x onerror="window.__pwned=1">\n\n' + '<p>kept <b>bold</b></p><script>window.__pwned=2</script>',
    },
  ]);

  const cell = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td')
    .nth(1);
  // The formatting is kept, and so is the image itself…
  await expect(cell.locator('b')).toHaveText('bold');
  await expect(cell.locator('img')).toHaveCount(1);
  // …but neither the event handler nor the script survives to run.
  await expect(cell.locator('img')).not.toHaveAttribute('onerror', /.*/);
  await expect(cell.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('the script editor tells you the helper exists', async ({ page }) => {
  const id = await createTable(page, 'Hint', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();

  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('button.icon-btn[title*="script" i], button.icon-btn:has(.mi:text-is("edit"))').first().click();

  // Both the bare helper and the namespace are mentioned; assert on each.
  const hint = page.locator('script-editor-dialog dialog');
  await expect(hint.getByText('markdownToHtml(text)')).toBeVisible();
  await expect(hint.getByText('easydb.markdownToHtml')).toBeVisible();
});
