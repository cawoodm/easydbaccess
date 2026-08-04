import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `markdown` renderer: the cell IS Markdown and shows as formatted text in
 * the grid, in full. `preview` also converts Markdown, but only to a one-line
 * plain-text summary with the formatted value behind a popup — so the choice is
 * "read it in the grid" against "keep the row one line high".
 *
 * The pencil opens the MARKDOWN, never the HTML made from it: the conversion is
 * display only, and a save that wrote the HTML back would destroy the source.
 */

const MD = '# Title\n\nSome **bold** text.\n\n- one\n- two';

function cellOf(page: import('@playwright/test').Page, tableId: string) {
  return page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td markdown-cell');
}

async function mdTable(page: import('@playwright/test').Page, name: string, note = MD) {
  const id = await createTable(page, name, [{ field: 'note', renderer: 'markdown' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { note });
  return id;
}

test('the cell shows the Markdown as formatted text', async ({ page }) => {
  const id = await mdTable(page, 'mdcell');
  const cell = cellOf(page, id);

  await expect(cell.locator('h1')).toHaveText('Title');
  await expect(cell.locator('strong')).toHaveText('bold');
  await expect(cell.locator('li')).toHaveCount(2);
  // The markers themselves are gone — this is not the source shown as text.
  expect(await cell.textContent()).not.toContain('**');
});

test('the pencil opens the Markdown source, and a save updates the cell', async ({ page }) => {
  const id = await mdTable(page, 'mdedit');
  const cell = cellOf(page, id);
  await cell.locator('button').click();

  const editor = page.locator('[id^="easydb-html-edit-"]').last();
  const ta = editor.locator('textarea');
  // The SOURCE, not the rendered markup.
  await expect(ta).toHaveValue(MD);

  await ta.fill('## Second\n\nplain');
  await editor.getByRole('button', { name: 'Save' }).click();

  await expect(cell.locator('h2')).toHaveText('Second');
  const stored = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = await ctx.store.rows(tableId).find();
    return rows[0]?.data?.note;
  }, id);
  expect(stored).toBe('## Second\n\nplain');
});

test('an angle-bracket word in the Markdown survives as text', async ({ page }) => {
  // The `<database>` case: read as HTML, the word is swallowed by the parser and
  // the Markdown stays literal. This renderer never guesses — it always converts.
  const id = await mdTable(page, 'mdtag', 'Call `/<database>/-/create` for **new** tables.');
  const cell = cellOf(page, id);

  await expect(cell.locator('code')).toHaveText('/<database>/-/create');
  await expect(cell.locator('strong')).toHaveText('new');
});

test('an empty cell says so, and a script column keeps its source', async ({ page }) => {
  const empty = await mdTable(page, 'mdempty', '');
  expect(await cellOf(page, empty).textContent()).toContain('empty');

  // A scripted column shows the script's output; the pencil must still open the
  // stored value the script reads.
  const id = await createTable(page, 'mdscript', [
    { field: 'note', renderer: 'markdown', script: 'function render(row) { return "**" + row.note + "**"; }' },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: 'raw' });

  const cell = cellOf(page, id);
  await expect(cell.locator('strong')).toHaveText('raw');
  await cell.locator('button').click();
  await expect(page.locator('[id^="easydb-html-edit-"]').last().locator('textarea')).toHaveValue(
    'raw',
  );
});
