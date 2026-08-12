import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The columns editor's live preview showed nothing on a big table.
 *
 * It was awaited BEFORE the dialog was shown, over a read of the whole table —
 * so the editor arrived late, and when that read failed it arrived saying "No
 * rows to preview", which reads as "this table is empty". The read now asks for
 * a hundred rows, happens after the dialog is on screen, and says which of the
 * three things it means: reading, nothing there, or could not be read.
 */

async function openColumns(page: import('@playwright/test').Page, id: string) {
  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
}

test('the preview reads a hundred rows, whatever the table holds', async ({ page }) => {
  const id = await createTable(page, 'Many', [{ field: 'n' }]);
  await waitForPanel(page, id);
  await bulkAddRows(
    page,
    id,
    Array.from({ length: 250 }, (_, i) => ({ n: `row${i}` })),
  );

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('.preview h3')).toContainText('first 100 rows');
  await expect(dlg.locator('.preview tbody tr')).toHaveCount(100);
});

test('an empty table says so', async ({ page }) => {
  const id = await createTable(page, 'Empty', [{ field: 'n' }]);
  await waitForPanel(page, id);

  const dlg = await openColumns(page, id);
  await expect(dlg.getByTestId('preview-empty')).toHaveText('No rows to preview.');
});

test('a read that fails says so instead of claiming there are no rows', async ({ page }) => {
  const id = await createTable(page, 'Unreadable', [{ field: 'n' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { n: 'one' });

  // Break the row read. BOTH ways in: `readRows` prefers `query` where the store
  // has one, and Dexie has had one since 0.0.348 — breaking only `find` left the
  // preview working and this test asserting nothing. The grid subscribed with the
  // real collection when it mounted, so this reaches only the editor's own read.
  await page.evaluate((tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real = ctx.store.rows.bind(ctx.store) as (t: string) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.store.rows = (tableId: string): any =>
      tableId === tid
        ? {
            ...real(tableId),
            find: () => Promise.reject(new Error('no')),
            query: () => Promise.reject(new Error('no')),
          }
        : real(tableId);
  }, id);

  const dlg = await openColumns(page, id);
  await expect(dlg.getByTestId('preview-empty')).toContainText('could not be read');
  // The editor still works — the failure costs the preview, not the settings.
  await expect(dlg.getByRole('button', { name: /Save|Create/ })).toBeEnabled();
});
