import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A view binds to its table by `tableId`. Deleting a table and recreating it
 * under the same name mints a fresh id, which would orphan the view. The core
 * view-window-manager reconnects a dangling view to a same-named table (by the
 * `tableName` snapshot), and the open window re-binds to the new rows.
 */
test('a view reconnects to a recreated same-named table and shows its new rows', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ title: 'Original', url: 'https://example.com/o' }]);

  // Create an RSS view over the table → one linked card for the original row.
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
  await dlg.getByRole('button', { name: 'Create view' }).click();

  const vw = page.locator('view-window');
  await expect(vw.locator('a', { hasText: 'Original' })).toBeVisible();

  // The instance snapshotted the table name so it can reconnect later.
  await expect
    .poll(async () =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        return (await store.viewInstances.find({ workspaceId: ws }))[0]?.tableName ?? null;
      }, workspaceId),
    )
    .toBe('Feed');

  // Delete the table (and its rows) — mirrors deleteTableCascade. The view
  // window stays open (its `open` flag is untouched) but now dangles.
  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    const rows = await store.rows(tid).find();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of rows) await store.rows(tid).remove(r.id);
    await store.tables.remove(tid);
  }, id);

  // Recreate a table with the SAME name (fresh id) and give it a new row.
  const newId = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
  expect(newId).not.toBe(id);
  await bulkAddRows(page, newId, [{ title: 'Reconnected', url: 'https://example.com/r' }]);

  // The view reconnects by name: its window now renders the recreated table's
  // rows, and the instance's tableId points at the new table.
  await expect(vw.locator('a', { hasText: 'Reconnected' })).toBeVisible();
  await expect(vw.locator('a', { hasText: 'Original' })).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        return (await store.viewInstances.find({ workspaceId: ws }))[0]?.tableId ?? null;
      }, workspaceId),
    )
    .toBe(newId);
});
