import { expect, test, type Page } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A view's OWN column editor: which columns it shows, and what draws them.
 *
 * A view is a view OF a table: the table owns what a column IS, the view owns how
 * it looks. Visibility and width were already the instance's; the renderer was
 * not, so showing a markdown column as prose in the view you read while keeping
 * the one-line preview in the grid you edit meant changing the TABLE's column —
 * which every other view and the grid itself then followed.
 *
 * The footer's checkbox popover (visibility, and nothing else, grid mode only) is
 * replaced by this dialog, offered in both modes.
 */

const MD = '# Heading\n\nSome **bold** text.';

async function makeView(page: Page, tableId: string, columns: string[]): Promise<void> {
  await page.evaluate(
    async ({ tid, cols }) => {
      const ctx = (
        window as unknown as {
          __easydb: {
            workspaceId: string;
            store: { viewTemplates: { upsert(d: unknown): Promise<unknown> }; viewInstances: { upsert(d: unknown): Promise<unknown> } };
          };
        }
      ).__easydb;
      await ctx.store.viewTemplates.upsert({
        id: 'tpl-cols',
        workspaceId: ctx.workspaceId,
        name: 'Cards',
        headerHtml: '',
        rowHtml: '<div class="card">$BODY</div>',
        footerHtml: '',
        updatedAt: Date.now(),
      });
      await ctx.store.viewInstances.upsert({
        id: 'vi-cols',
        workspaceId: ctx.workspaceId,
        tableId: tid,
        templateId: 'tpl-cols',
        name: 'Cards',
        filters: {},
        visibleColumns: cols,
        mapping: { BODY: 'body' },
        open: true,
        updatedAt: Date.now(),
      });
    },
    { tid: tableId, cols: columns },
  );
  await expect(page.locator('view-window')).toBeVisible({ timeout: 20_000 });
}

/** What the instance holds now — the view's own presentation, straight from the store. */
async function instance(page: Page): Promise<{ visibleColumns: string[]; columnRenderers?: Record<string, string> }> {
  return page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { store: { viewInstances: { findOne(id: string): Promise<unknown> } } } }).__easydb;
    return (await ctx.store.viewInstances.findOne('vi-cols')) as { visibleColumns: string[]; columnRenderers?: Record<string, string> };
  });
}

function editor(page: Page) {
  return page.locator('view-columns-dialog dialog');
}

async function openEditor(page: Page): Promise<void> {
  await page.locator('view-window').getByRole('button', { name: 'Columns' }).click();
  await expect(editor(page)).toBeVisible({ timeout: 10_000 });
}

test.describe('a view´s column editor', () => {
  test('sets a renderer for THIS view, leaving the table and the grid alone', async ({ page }) => {
    const tableId = await createTable(page, 'Notes', [{ field: 'title' }, { field: 'body', renderer: 'markdown' }]);
    await waitForPanel(page, tableId);
    await bulkAddRows(page, tableId, [{ title: 'One', body: MD }]);
    await makeView(page, tableId, ['title', 'body']);

    // The view shows what the grid shows to begin with: `markdown` renders.
    const card = page.locator('view-window .card').first();
    await expect(card.locator('strong')).toHaveText('bold', { timeout: 20_000 });

    await openEditor(page);
    await editor(page).getByLabel('Renderer for body', { exact: false }).selectOption('preview');
    await editor(page).getByRole('button', { name: 'Done' }).click();

    // Stored on the instance…
    await expect.poll(async () => (await instance(page)).columnRenderers?.['body'], { timeout: 10_000 }).toBe('preview');
    // …and the TABLE's own column is untouched, so the grid is unaffected.
    const tableRenderer = await page.evaluate(async (tid) => {
      const ctx = (window as unknown as { __easydb: { store: { tables: { findOne(id: string): Promise<{ columns: Array<{ field: string; renderer?: string }> }> } } } }).__easydb;
      return (await ctx.store.tables.findOne(tid)).columns.find((c) => c.field === 'body')?.renderer;
    }, tableId);
    expect(tableRenderer).toBe('markdown');
  });

  test('"From the table" names the renderer it would inherit, and going back to it clears the override', async ({ page }) => {
    const tableId = await createTable(page, 'Notes', [{ field: 'title' }, { field: 'body', renderer: 'markdown' }]);
    await waitForPanel(page, tableId);
    await makeView(page, tableId, ['title', 'body']);

    await openEditor(page);
    const picker = editor(page).getByLabel('Renderer for body', { exact: false });
    await expect(picker.locator('option').first()).toHaveText('From the table (markdown)');

    await picker.selectOption('preview');
    await expect.poll(async () => (await instance(page)).columnRenderers?.['body'], { timeout: 10_000 }).toBe('preview');

    // Back to the empty option: the override is REMOVED, not stored as ''. A view
    // holding no opinion has to be tellable from one holding several.
    await picker.selectOption('');
    await expect.poll(async () => Object.keys((await instance(page)).columnRenderers ?? {}).length, { timeout: 10_000 }).toBe(0);
  });

  test('hiding and showing a column puts it back where the table has it', async ({ page }) => {
    const tableId = await createTable(page, 'Notes', [{ field: 'title' }, { field: 'body' }, { field: 'url' }]);
    await waitForPanel(page, tableId);
    await makeView(page, tableId, ['title', 'body', 'url']);

    await openEditor(page);
    const body = editor(page).getByLabel('Show body', { exact: false });
    await body.uncheck();
    await expect.poll(async () => (await instance(page)).visibleColumns, { timeout: 10_000 }).toEqual(['title', 'url']);

    // Back in the middle, not appended — `visibleColumns` is also the order, and
    // the old toggle sent a column to the far right for no visible reason.
    await body.check();
    await expect.poll(async () => (await instance(page)).visibleColumns, { timeout: 10_000 }).toEqual(['title', 'body', 'url']);
  });

  test('previews the rows THIS view shows, and follows the renderer as it is picked', async ({ page }) => {
    const tableId = await createTable(page, 'Notes', [{ field: 'title' }, { field: 'body', renderer: 'markdown' }, { field: 'spare' }]);
    await waitForPanel(page, tableId);
    await bulkAddRows(page, tableId, [{ title: 'One', body: MD, spare: 'ignored' }]);
    // `spare` is the table's, not this view's — a preview that showed it would be
    // a preview of the table.
    await makeView(page, tableId, ['title', 'body']);

    await openEditor(page);
    const preview = editor(page).locator('.preview');
    await expect(preview.locator('thead th')).toHaveText(['title', 'body']);
    // The renderer is in play, and shows what the GRID shows: markdown's one-line
    // form, with the markers converted rather than printed. The card layout is the
    // template's business, not a column's.
    await expect(preview.locator('tbody markdown-cell')).toBeVisible();
    await expect(preview.locator('tbody markdown-cell')).not.toContainText('**');

    // Pick another renderer and the preview follows it, before the change has to
    // be judged from the view behind a modal.
    await editor(page).getByLabel('Renderer for body', { exact: false }).selectOption('preview');
    await expect(preview.locator('tbody preview-cell')).toBeVisible();
  });

  test('the last visible column cannot be hidden', async ({ page }) => {
    const tableId = await createTable(page, 'Notes', [{ field: 'title' }, { field: 'body' }]);
    await waitForPanel(page, tableId);
    await makeView(page, tableId, ['title']);

    await openEditor(page);
    await editor(page).getByLabel('Show title', { exact: false }).uncheck();

    await expect(page.locator('toast-host')).toContainText('at least one column', { timeout: 10_000 });
    expect((await instance(page)).visibleColumns).toEqual(['title']);
  });
});
