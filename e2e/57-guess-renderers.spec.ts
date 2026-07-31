import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The auto-renderer plugin puts a "Guess renderers" button in the column editor,
 * for tables its import hook never saw — one made by hand, or imported before the
 * plugin existed. It only fills the editor: the user still presses Save.
 */
test('Guess renderers fills the editor from the values, and Save keeps them', async ({ page }) => {
  const id = await createTable(page, 'Links', [
    { field: 'title' },
    { field: 'url' },
    { field: 'pic' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { title: 'One', url: 'https://example.com/a', pic: 'https://example.com/a.png' },
    { title: 'Two', url: 'https://example.com/b', pic: 'https://example.com/b.jpg' },
  ]);

  // No renderers to start with — the import hook never ran for a hand-made table.
  const storedRenderers = () =>
    page.evaluate(async (tid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = await (window as any).__easydb.store.tables.findOne(tid);
      return t.columns.map((c: { field: string; renderer?: string }) => [c.field, c.renderer ?? '']);
    }, id);
  expect(await storedRenderers()).toEqual([
    ['title', ''],
    ['url', ''],
    ['pic', ''],
  ]);

  await page.locator(`#${panelDomId(id)} panel-footer`).getByTitle('Edit columns').click();
  const editor = page.locator('new-table-dialog dialog');
  await expect(editor).toBeVisible();

  await editor.getByRole('button', { name: 'Guess renderers' }).click();

  // The editor's renderer selects now hold the guesses; the store does not yet.
  // (The renderer select is the one whose tooltip starts with "Renderer".)
  const selects = editor.locator('select[title^="Renderer"]');
  await expect(selects.nth(1)).toHaveValue('link');
  await expect(selects.nth(2)).toHaveValue('image');
  expect(await storedRenderers()).toEqual([
    ['title', ''],
    ['url', ''],
    ['pic', ''],
  ]);

  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();

  // Saved: a plain text column is left alone, the URL and image columns are set.
  await expect.poll(storedRenderers).toEqual([
    ['title', ''],
    ['url', 'link'],
    ['pic', 'image'],
  ]);
});
