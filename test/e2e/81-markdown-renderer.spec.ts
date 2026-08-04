import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `markdown` renderer shows the cell like `preview` does: ONE LINE of plain
 * text with the markers flattened, and the formatted value in the popup. A grid
 * row is one line high — headings, lists and images each setting their own row
 * height is not a grid.
 *
 * What it does NOT do is guess. `preview` asks whether a value is Markdown or
 * HTML; a `markdown` column is declared, so the value is always Markdown. The
 * editor opens the Markdown source, never the HTML made from it.
 */

const MD = '# Title\n\nSome **bold** text.\n\n- one\n- two';

function cellOf(page: import('@playwright/test').Page, tableId: string) {
  return page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td markdown-cell');
}

function popupOf(page: import('@playwright/test').Page) {
  return page.locator('[id^="easydb-preview-popup-"]').last();
}

async function mdTable(page: import('@playwright/test').Page, name: string, note = MD) {
  const id = await createTable(page, name, [{ field: 'note', renderer: 'markdown' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { note });
  return id;
}

test('the cell is one line of plain text, with the markers dropped', async ({ page }) => {
  const id = await mdTable(page, 'mdinline');
  const cell = cellOf(page, id);

  const text = (await cell.textContent()) ?? '';
  expect(text).toContain('Title Some bold text.');
  expect(text).not.toContain('#');
  expect(text).not.toContain('**');
  // Nothing is rendered in the cell itself.
  await expect(cell.locator('h1')).toHaveCount(0);
  await expect(cell.locator('strong')).toHaveCount(0);
  await expect(cell.locator('li')).toHaveCount(0);
});

test('the popup icon opens the formatted Markdown', async ({ page }) => {
  const id = await mdTable(page, 'mdpopup');
  await cellOf(page, id).locator('button').click();

  const popup = popupOf(page);
  await expect(popup.locator('.jsPanel-content h1')).toHaveText('Title');
  await expect(popup.locator('.jsPanel-content strong')).toHaveText('bold');
  await expect(popup.locator('.jsPanel-content li')).toHaveCount(2);
  // The <pre> is the plain-text path; a markdown column never takes it.
  await expect(popup.locator('.jsPanel-content pre')).toHaveCount(0);
});

test('clicking the text edits the Markdown source', async ({ page }) => {
  const id = await mdTable(page, 'mdedit');
  const cell = cellOf(page, id);
  await cell.locator('[title="Click to edit"]').click();

  const editor = page.locator('[id^="easydb-html-edit-"]').last();
  const ta = editor.locator('textarea');
  // The SOURCE, not the rendered markup.
  await expect(ta).toHaveValue(MD);

  await ta.fill('## Second\n\nplain');
  await editor.getByRole('button', { name: 'Save' }).click();

  expect(await cell.textContent()).toContain('Second plain');
  const stored = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = await ctx.store.rows(tableId).find();
    return rows[0]?.data?.note;
  }, id);
  expect(stored).toBe('## Second\n\nplain');
});

test('a value that reads like HTML is still converted as Markdown', async ({ page }) => {
  // `preview` would call this HTML — it opens with a tag — and then show the
  // `**` as text. A declared Markdown column is never guessed at.
  //
  // The angle-bracket word survives because it is in a code span. Raw HTML in a
  // Markdown source is still SANITIZED (see util/markdown.ts), so a bare
  // `<database>` outside code is dropped as an unknown tag either way.
  const id = await mdTable(page, 'mdnoguess', '`<database>` is **the** word');
  await cellOf(page, id).locator('button').click();

  const popup = popupOf(page);
  await expect(popup.locator('.jsPanel-content strong')).toHaveText('the');
  await expect(popup.locator('.jsPanel-content code')).toHaveText('<database>');
});

test('an empty cell says so, and a script column keeps its source', async ({ page }) => {
  const empty = await mdTable(page, 'mdempty', '');
  expect(await cellOf(page, empty).textContent()).toContain('empty');

  // A scripted column shows the script's output; the editor must still open the
  // stored value the script reads.
  const id = await createTable(page, 'mdscript', [
    {
      field: 'note',
      renderer: 'markdown',
      script: 'function render(row) { return "**" + row.note + "**"; }',
    },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: 'raw' });

  const cell = cellOf(page, id);
  // The script's output, flattened for the line — the `**` is gone.
  expect(await cell.textContent()).toContain('raw');
  await cell.locator('[title="Click to edit"]').click();
  await expect(page.locator('[id^="easydb-html-edit-"]').last().locator('textarea')).toHaveValue(
    'raw',
  );
});
