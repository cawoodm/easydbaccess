import { expect, test } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A `$TOKEN` in a view goes through the column's cell renderer, so a view shows
 * what the grid shows — that is what `tokenRaw` / `$raw.` are the way OUT of.
 *
 * For `markdown` (and `preview`, its sibling) that promise was kept to the letter
 * and broken in spirit. Both are `PreviewCell`s, which deliberately show ONE LINE
 * of plain text with the render behind a popup: a grid row is one line high, and
 * arbitrary markup would let every row set its own height. A view has no such
 * constraint — it is a page of HTML the template author laid out — so a markdown
 * token showed its text with the markers stripped, which reads as the renderer
 * never having been applied.
 */

const MD = '# Heading\n\nSome **bold** text.';

test('a markdown column renders as markdown in a view, not as flattened text', async ({ page }) => {
  const tableId = await createTable(page, 'Notes', [
    { field: 'title' },
    { field: 'body', renderer: 'markdown' },
  ]);
  await waitForPanel(page, tableId);
  await bulkAddRows(page, tableId, [{ title: 'One', body: MD }]);

  await page.evaluate(async (tid) => {
    const ctx = (
      window as unknown as {
        __easydb: {
          workspaceId: string;
          store: { viewTemplates: { upsert(d: unknown): Promise<unknown> }; viewInstances: { upsert(d: unknown): Promise<unknown> } };
        };
      }
    ).__easydb;
    await ctx.store.viewTemplates.upsert({
      id: 'tpl-md',
      workspaceId: ctx.workspaceId,
      name: 'Cards',
      headerHtml: '',
      rowHtml: '<div class="card">$BODY</div>',
      footerHtml: '',
      updatedAt: Date.now(),
    });
    await ctx.store.viewInstances.upsert({
      id: 'vi-md',
      workspaceId: ctx.workspaceId,
      tableId: tid,
      templateId: 'tpl-md',
      name: 'Cards',
      filters: {},
      visibleColumns: ['title', 'body'],
      // No `tokenRaw`, so BODY takes the column's renderer — the case in question.
      mapping: { BODY: 'body' },
      open: true,
      updatedAt: Date.now(),
    });
  }, tableId);

  const view = page.locator('view-window');
  await expect(view).toBeVisible({ timeout: 20_000 });
  const card = view.locator('.card').first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The markup itself, not a flattened line of text.
  await expect(card.locator('strong')).toHaveText('bold');
  await expect(card.locator('h1')).toHaveText('Heading');
  // And no trace of the source markers.
  await expect(card).not.toContainText('**bold**');
  await expect(card).not.toContainText('# Heading');
});
