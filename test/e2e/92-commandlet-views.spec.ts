import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * `view/…` navigates INSIDE a view, the way `goto/…` navigates a table:
 *
 *   view/Reading plan?Book==Matthew   — a view by name
 *   view?Book==Matthew                — the view the link was clicked in
 *
 * Filters land on the view's `pillFilters`, the layer that shows as chips in its
 * toolbar, so a link that narrows a view can be clicked off again and the view's
 * own snapshotted filters — part of how the user defined it — stay as they are.
 */

const COLUMNS = [
  { field: 'book', label: 'Book' },
  { field: 'chapter', label: 'Chapter', type: 'number' as const },
];

const ROWS = [
  { book: 'Matthew', chapter: 5 },
  { book: 'Matthew', chapter: 6 },
  { book: 'Mark', chapter: 1 },
];

/** A table plus a view of it whose row fragment is `rowHtml`. */
async function seed(page: import('@playwright/test').Page, ws: string, rowHtml = '<p class="line">$BOOK $CHAPTER</p>') {
  const tableId = await createTable(page, 'bible', COLUMNS);
  await bulkAddRows(page, tableId, ROWS);
  await waitForPanel(page, tableId);
  const viewId = await page.evaluate(
    async ({ ws, tableId, rowHtml }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const tpl = crypto.randomUUID();
      await store.viewTemplates.insert({ id: tpl, workspaceId: ws, name: 'Plan', headerHtml: '<div>', rowHtml, footerHtml: '</div>', updatedAt: Date.now() });
      const id = crypto.randomUUID();
      await store.viewInstances.insert({
        id,
        workspaceId: ws,
        tableId,
        templateId: tpl,
        name: 'Reading plan',
        filters: {},
        visibleColumns: ['book', 'chapter'],
        mapping: { BOOK: 'book', CHAPTER: 'chapter' },
        open: true,
        updatedAt: Date.now(),
      });
      return id;
    },
    { ws, tableId, rowHtml },
  );
  return { tableId, viewId };
}

async function runViaPalette(page: import('@playwright/test').Page, input: string) {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('Run commandlet');
  await palette.locator('.item', { hasText: 'Run commandlet' }).first().click();
  const dialog = page.locator('commandlet-dialog');
  const field = dialog.locator('input.commandlet');
  await field.waitFor();
  await field.fill(input);
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog.locator('dialog')).toBeHidden();
}

const readView = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(async (viewId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (window as any).__easydb.store.viewInstances.findOne(viewId)) ?? null;
  }, id);

test('a named view filters on its pill layer, leaving its own filters alone', async ({ page, workspaceId }) => {
  const { viewId } = await seed(page, workspaceId);
  const vw = page.locator('view-window');
  await expect(vw.locator('.line')).toHaveCount(3);

  await runViaPalette(page, 'view/Reading plan?Book==Matthew');

  await expect(vw.locator('.line')).toHaveCount(2);
  const inst = await readView(page, viewId);
  expect(inst?.pillFilters).toEqual({ book: '=Matthew' });
  expect(inst?.filters).toEqual({}); // the view's definition is untouched
  // The chip is in the toolbar, so the narrowing can be undone by clicking.
  await expect(vw.locator('.vw-sortbar .eda-pill-chip')).toHaveCount(1);
});

test('a second field ANDs, an empty value drops one and @clear drops the lot', async ({ page, workspaceId }) => {
  const { viewId } = await seed(page, workspaceId);
  const vw = page.locator('view-window');

  await runViaPalette(page, 'view/Reading plan?Book==Matthew&Chapter==5');
  await expect(vw.locator('.line')).toHaveCount(1);

  // An empty value REMOVES that field's filter, so a link can widen as well.
  await runViaPalette(page, 'view/Reading plan?Chapter=');
  await expect(vw.locator('.line')).toHaveCount(2);
  expect((await readView(page, viewId))?.pillFilters).toEqual({ book: '=Matthew' });

  await runViaPalette(page, 'view/Reading plan?@clear');
  await expect(vw.locator('.line')).toHaveCount(3);
  expect((await readView(page, viewId))?.pillFilters).toBeUndefined();
});

test('@sort reorders the view and @search narrows it without touching the table', async ({ page, workspaceId }) => {
  const { tableId, viewId } = await seed(page, workspaceId);

  await runViaPalette(page, 'view/Reading plan?@sort=-Chapter');
  await expect.poll(async () => (await readView(page, viewId))?.sortColumn).toBe('chapter');
  expect((await readView(page, viewId))?.sortAsc).toBe(false);
  await expect(page.locator('view-window .line').first()).toContainText('Matthew 6');

  await runViaPalette(page, 'view/Reading plan?@search=Mark');
  await expect(page.locator('view-window .line')).toHaveCount(1);
  // A view's search is keyed by the instance, so the table window is unaffected.
  await expect(page.locator(`#${panelDomId(tableId)} data-table tbody tr`)).toHaveCount(3);
});

test('a link inside a view says "view" with no name and means THIS view', async ({ page, workspaceId }) => {
  // The template's own link — `$BOOK` in an href would be encoded by hand, so the
  // fragment names the value directly.
  const { viewId } = await seed(page, workspaceId, '<p class="line">$BOOK <a class="only" href="#view?Book==Mark">only Mark</a></p>');
  const vw = page.locator('view-window');
  await expect(vw.locator('.line')).toHaveCount(3);

  await vw.locator('a.only').first().click();

  await expect(vw.locator('.line')).toHaveCount(1);
  expect((await readView(page, viewId))?.pillFilters).toEqual({ book: '=Mark' });
});

test('a leading slash works, because that is how a link spells a path', async ({ page, workspaceId }) => {
  const { viewId } = await seed(page, workspaceId, '<p class="line">$BOOK <a class="only" href="#/view?Book==Mark">only Mark</a></p>');
  await page.locator('view-window a.only').first().click();
  await expect(page.locator('view-window .line')).toHaveCount(1);
  expect((await readView(page, viewId))?.pillFilters).toEqual({ book: '=Mark' });
});

test('a target-less view typed in the palette says to name one, instead of guessing', async ({ page, workspaceId }) => {
  await seed(page, workspaceId);

  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('Run commandlet');
  await palette.locator('.item', { hasText: 'Run commandlet' }).first().click();
  const dialog = page.locator('commandlet-dialog');
  await dialog.locator('input.commandlet').fill('view?Book==Mark');

  // The dialog checks live, so this is refused before it can be run.
  await expect(dialog.locator('.verdict')).toContainText(/name the view/i);
});

test('an unknown column in a view commandlet is refused, not written', async ({ page, workspaceId }) => {
  const { viewId } = await seed(page, workspaceId);

  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('Run commandlet');
  await palette.locator('.item', { hasText: 'Run commandlet' }).first().click();
  const dialog = page.locator('commandlet-dialog');
  await dialog.locator('input.commandlet').fill('view/Reading plan?Nope=1');
  await expect(dialog.locator('.verdict')).toContainText(/no column "Nope"/i);

  expect((await readView(page, viewId))?.pillFilters).toBeUndefined();
});
