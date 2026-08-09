import { test, expect } from './fixtures.js';

/**
 * A table past the row cap (20 000) is read as a SLICE, and a free-text search
 * runs in memory over that slice — so "nothing found" means "nothing in the rows
 * we have". The grid has warned about a truncated read for a while; a template
 * view said nothing at all, which is what this covers.
 *
 * The table's own window is inserted CLOSED on purpose: the warning is the thing
 * under test, and rendering 20 000 grid rows is what would make this slow.
 */

const CAP = 20_000;

/** A closed table of `rows` rows, plus an open template view of it limited to 3 cards. */
async function seedBigTable(page: import('@playwright/test').Page, ws: string, rows: number) {
  return page.evaluate(
    async ({ ws, rows }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const tableId = crypto.randomUUID();
      await store.tables.insert({
        id: tableId,
        workspaceId: ws,
        name: 'big',
        code: 'big',
        columns: [
          { field: 'name', label: 'name', type: 'string' },
          { field: 'n', label: 'n', type: 'number' },
        ],
        view: 'table',
        // Closed keeps the grid from rendering the slice; the data is all there.
        windowGeometry: { x: 0, y: 0, w: 400, h: 300, z: 1, minimized: false, maximized: false, closed: true },
        updatedAt: Date.now(),
      });
      const batch: Array<Record<string, unknown>> = [];
      for (let i = 0; i < rows; i++) batch.push({ name: `row ${i}`, n: i });
      await store.rows(tableId).bulkInsert(batch.map((data) => ({ id: crypto.randomUUID(), tableId, data, updatedAt: Date.now() })));

      const tpl = crypto.randomUUID();
      await store.viewTemplates.insert({ id: tpl, workspaceId: ws, name: 'Cards', headerHtml: '<div>', rowHtml: '<p class="line">$NAME</p>', footerHtml: '</div>', updatedAt: Date.now() });
      const viewId = crypto.randomUUID();
      await store.viewInstances.insert({
        id: viewId,
        workspaceId: ws,
        tableId,
        templateId: tpl,
        name: 'Big view',
        filters: {},
        visibleColumns: ['name', 'n'],
        mapping: { NAME: 'name' },
        limit: 3,
        open: true,
        updatedAt: Date.now(),
      });
      return { tableId, viewId };
    },
    { ws, rows },
  );
}

test('a view of a table past the cap warns, and says something different once searching', async ({ page, workspaceId }) => {
  await seedBigTable(page, workspaceId, CAP + 1);

  const vw = page.locator('view-window');
  const note = vw.locator('.vw-note');
  // The limit shows 3 cards, but the READ was capped — which the note admits.
  await expect(vw.locator('.line')).toHaveCount(3);
  await expect(note).toContainText('Showing the first');
  await expect(note).toContainText('Narrow the filter');

  // Searching changes the sentence: narrowing a search re-runs over the same
  // rows, so it points at a column filter instead.
  const search = page.locator('[id^="view-panel-"] .jsPanel-controlbar panel-search');
  await search.getByRole('button').click();
  await search.locator('input').fill('zzz-not-in-any-row');

  // Empty — but only of the rows that were READ, which is the whole point: this
  // must not read as "no such row anywhere in the table".
  await expect(vw.locator('.line')).toHaveCount(0);
  await expect(note).toContainText('Nothing found in the first');
  await expect(note).toContainText('may be matches further in');
  await expect(note).toContainText('Filter a column');

  // A search that DOES hit says its count is a floor.
  await search.locator('input').fill('row 1');
  await expect(note).toContainText('there may be more further in');
});

test('a table inside the cap warns about nothing at all', async ({ page, workspaceId }) => {
  await seedBigTable(page, workspaceId, 5);

  const vw = page.locator('view-window');
  await expect(vw.locator('.line')).toHaveCount(3); // the view's own limit
  await expect(vw.locator('.vw-note')).toHaveCount(0);

  const search = page.locator('[id^="view-panel-"] .jsPanel-controlbar panel-search');
  await search.getByRole('button').click();
  await search.locator('input').fill('nothing matches this');
  await expect(vw.locator('.line')).toHaveCount(0);
  // Genuinely empty, so no hedging — the whole table was searched.
  await expect(vw.locator('.vw-note')).toHaveCount(0);
});
