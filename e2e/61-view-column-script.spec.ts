import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A view renders the SAME values the grid computes. A scripted column stores
 * nothing — its cell is derived from the whole row — so a view that read the
 * stored value showed a blank card, and a view filtered or sorted on such a
 * column was working with empties.
 */

/** Creates a view instance on `tableId` through the store, and returns its id. */
function makeView(
  page: import('@playwright/test').Page,
  ws: string,
  tableId: string,
  inst: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ ws, tableId, inst }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const templates = await store.viewTemplates.find({ workspaceId: ws });
      const gallery = (templates as Array<{ id: string; name: string }>).find(
        (t) => t.name === 'Gallery',
      )!;
      const id = crypto.randomUUID();
      await store.viewInstances.insert({
        id,
        workspaceId: ws,
        tableId,
        templateId: gallery.id,
        filters: {},
        open: true,
        updatedAt: Date.now(),
        ...inst,
      });
      return id;
    },
    { ws, tableId, inst },
  );
}

/**
 * Rewrites the Gallery template's row fragment, so each row renders as one
 * readable line. Polls first: the views plugin seeds the built-in templates
 * asynchronously on boot.
 */
async function useTemplate(page: import('@playwright/test').Page, ws: string, rowHtml: string) {
  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const templates = await store.viewTemplates.find({ workspaceId: ws });
        return (templates as Array<{ name: string }>).some((t) => t.name === 'Gallery');
      }, ws),
    )
    .toBe(true);

  await page.evaluate(
    async ({ ws, rowHtml }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const templates = await store.viewTemplates.find({ workspaceId: ws });
      const gallery = (templates as Array<{ id: string; name: string }>).find(
        (t) => t.name === 'Gallery',
      )!;
      await store.viewTemplates.patch(gallery.id, {
        headerHtml: '<div>',
        rowHtml,
        footerHtml: '</div>',
        updatedAt: Date.now(),
      });
    },
    { ws, rowHtml },
  );
}

test('a view shows a scripted column as the script computes it', async ({ page, workspaceId }) => {
  await useTemplate(page, workspaceId, '<p class="line">$TITLE</p>');
  const id = await createTable(page, 'People', [
    { field: 'first' },
    { field: 'last' },
    { field: 'full', script: 'function render(row) { return row.first + " " + row.last; }' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ first: 'Ada', last: 'Lovelace' }]);

  await makeView(page, workspaceId, id, {
    name: 'Names',
    mapping: { TITLE: 'full' },
    visibleColumns: ['first', 'last', 'full'],
  });

  const line = page.locator('[id^="view-panel-"] .line');
  await expect(line).toHaveText('Ada Lovelace');
});

test('a view filters and sorts on the computed value', async ({ page, workspaceId }) => {
  await useTemplate(page, workspaceId, '<p class="line">$TITLE</p>');
  const id = await createTable(page, 'Numbers', [
    { field: 'n', type: 'number' },
    { field: 'kind', script: 'function render(row) { return row.n % 2 ? "odd" : "even"; }' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

  // The instance filters on `kind`, which exists only as a script result.
  await makeView(page, workspaceId, id, {
    name: 'Evens',
    mapping: { TITLE: 'kind' },
    visibleColumns: ['n', 'kind'],
    filters: { kind: 'even' },
    sortColumn: 'n',
    sortAsc: false,
  });

  const lines = page.locator('[id^="view-panel-"] .line');
  await expect(lines).toHaveCount(2);
  await expect(page.locator('[id^="view-panel-"] .jsPanel-title')).toHaveText('Evens (2)');
});

test('an $input bound to a scripted column is disabled', async ({ page, workspaceId }) => {
  await useTemplate(page, workspaceId, '<p>$input.TITLE</p>');
  const id = await createTable(page, 'Calc', [
    { field: 'a' },
    { field: 'shout', script: 'function render(row) { return String(row.a).toUpperCase(); }' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ a: 'hi' }]);

  await makeView(page, workspaceId, id, {
    name: 'Shout',
    mapping: { TITLE: 'shout' },
    visibleColumns: ['a', 'shout'],
  });

  // The value is computed, so there is no cell to write an edit back to.
  const input = page.locator('[id^="view-panel-"] input.eda-input');
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('HI');
});
