import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A read-only table still has to SHOW a long value — that is what the `preview`
 * and `markdown` cells are for, and their text is truncated to one line. So the
 * click still opens the source; it opens it to read.
 *
 * Before this, those cells ignored `.readonly` altogether: the click opened the
 * ordinary editor, complete with a Save button, on a table nothing may write to.
 * The core now refuses the write as well, so a renderer that ignores the flag
 * cannot get past it either.
 */

const MD = '# Title\n\nSome **bold** text, long enough to be cut in the cell.';

/** A read-only table with one `preview` and one `markdown` column. */
async function readonlyTable(page: import('@playwright/test').Page, name: string) {
  const id = await createTable(page, name, [
    { field: 'note', renderer: 'preview' },
    { field: 'doc', renderer: 'markdown' },
    { field: 'body', renderer: 'html' },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: MD, doc: MD, body: '<p>rendered <b>html</b></p>' });
  await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.store.tables.patch(tableId, { readonly: true });
  }, id);
  // The grid re-reads the table through its subscription.
  await expect(page.locator(`#${panelDomId(id)} data-table preview-cell`)).toBeVisible();
  return id;
}

function editorPanel(page: import('@playwright/test').Page) {
  return page.locator('[id^="easydb-html-edit-"]').last();
}

test('clicking a preview cell opens the raw source, with no way to save', async ({ page }) => {
  const id = await readonlyTable(page, 'ro-preview');
  const cell = page.locator(`#${panelDomId(id)} data-table preview-cell`);

  await expect(cell.locator('[title="Click to view the source"]')).toBeVisible();
  await cell.locator('[title="Click to view the source"]').click();

  const panel = editorPanel(page);
  await expect(panel).toBeVisible();
  // The raw Markdown, not the rendered value…
  await expect(panel.locator('textarea')).toHaveValue(MD);
  // …and it cannot be typed into or saved.
  expect(await panel.locator('textarea').evaluate((el) => (el as HTMLTextAreaElement).readOnly)).toBe(
    true,
  );
  await expect(panel.getByRole('button', { name: 'Save' })).toHaveCount(0);
  // `:text-is` and not the role: the panel's own titlebar button is also "Close".
  await expect(panel.locator('button:text-is("Close")')).toBeVisible();
});

test('a markdown cell reads the same way, and its popup still renders', async ({ page }) => {
  const id = await readonlyTable(page, 'ro-markdown');
  const cell = page.locator(`#${panelDomId(id)} data-table markdown-cell`);

  await cell.locator('[title="Click to view the source"]').click();
  await expect(editorPanel(page).locator('textarea')).toHaveValue(MD);
  await expect(editorPanel(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
  await editorPanel(page).locator('button:text-is("Close")').click();

  // Reading the formatted value is unaffected — the popup was never an editor.
  await cell.locator('button').click();
  const popup = page.locator('[id^="easydb-preview-popup-"]').last();
  await expect(popup.locator('.jsPanel-content h1')).toHaveText('Title');
});

test('the html cell keeps rendering but loses its pencil', async ({ page }) => {
  const id = await readonlyTable(page, 'ro-html');
  const cell = page.locator(`#${panelDomId(id)} data-table html-render-cell`);

  await expect(cell.locator('b')).toHaveText('html');
  await expect(cell.locator('button')).toHaveCount(0);
});

/** The stored value of the first row's `note`. */
function storedNote(page: import('@playwright/test').Page, id: string): Promise<unknown> {
  return page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return (await ctx.store.rows(tableId).find())[0]?.data?.note;
  }, id);
}

test('a read-only table listens to no commit at all', async ({ page }) => {
  const id = await readonlyTable(page, 'ro-core');
  const before = await storedNote(page, id);

  // Firing the renderer's own commit event is all a renderer can do, and the
  // grid wires no listener for it here.
  await page.locator(`#${panelDomId(id)} data-table preview-cell`).evaluate((el) => {
    el.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'written' }, bubbles: true, composed: true }),
    );
  });

  expect(await storedNote(page, id)).toBe(before);
});

test('the core refuses a write to a read-only COLUMN, where a commit does arrive', async ({
  page,
}) => {
  // A scripted column IS wired for commits — that is how the link renderer's
  // pencil edits the value a script reads. Marked read-only (a projection's
  // computed column is), the write must be refused by the core, not by the cell.
  const id = await createTable(page, 'ro-col', [
    {
      field: 'note',
      renderer: 'preview',
      script: 'function render(row) { return String(row.note) + " (computed)"; }',
    },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: 'stored' });
  await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = await ctx.store.tables.findOne(tableId);
    const columns = t.columns.map((c: Record<string, unknown>) => ({ ...c, readonly: true }));
    await ctx.store.tables.patch(tableId, { columns });
  }, id);

  const cell = page.locator(`#${panelDomId(id)} data-table preview-cell`);
  await expect(cell).toBeVisible();
  await cell.evaluate((el) => {
    el.dispatchEvent(
      new CustomEvent('change', { detail: { value: 'written' }, bubbles: true, composed: true }),
    );
  });

  await expect(page.locator('toast-host').getByText(/read-only column/)).toBeVisible();
  expect(await storedNote(page, id)).toBe('stored');
});

test('an editable table still edits', async ({ page }) => {
  // The same columns, without the read-only flag: the Save button is back.
  const id = await createTable(page, 'rw', [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: MD });

  const cell = page.locator(`#${panelDomId(id)} data-table preview-cell`);
  await cell.locator('[title="Click to edit"]').click();
  const panel = editorPanel(page);
  await expect(panel.getByRole('button', { name: 'Save' })).toBeVisible();
  await panel.locator('textarea').fill('# Other');
  await panel.getByRole('button', { name: 'Save' }).click();

  const stored = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return (await ctx.store.rows(tableId).find())[0]?.data?.note;
  }, id);
  expect(stored).toBe('# Other');
});
