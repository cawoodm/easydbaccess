import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * A column removed in the editor has its NAME remembered on the table
 * (`deletedColumns`) so a refresh cannot re-add it. That list was invisible, so a
 * column deleted by mistake could only be recovered by typing its name from
 * memory — while the app knew it all along. Now the editor offers it back.
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

/** Deletes the column at `idx` through the editor and saves. */
async function deleteColumn(page: import('@playwright/test').Page, id: string, idx: number) {
  const dlg = await openColumns(page, id);
  await dlg.locator('button.row-del').nth(idx).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toBeHidden();
}

test('a removed column is offered back, and restoring it adds the column again', async ({ page }) => {
  const id = await createTable(page, 'People', [{ field: 'first' }, { field: 'nickname' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ first: 'Ada', nickname: 'Countess' }]);

  await deleteColumn(page, id, 1);
  await expect.poll(async () => (await readTable(page, id)).deletedColumns).toEqual(['nickname']);

  // Reopening the editor offers it — nothing else does.
  const dlg = await openColumns(page, id);
  const offer = dlg.locator('.deleted-cols button', { hasText: 'nickname' });
  await expect(offer).toHaveCount(1);
  await expect(dlg.locator('.deleted-cols')).toContainText('adds the column back empty');

  await offer.click();
  // It is a column row again, and no longer offered.
  await expect(dlg.locator('.deleted-cols')).toHaveCount(0);
  await expect(dlg.locator('.col-row')).toHaveCount(2);

  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toBeHidden();

  // Saved as a real column, and dropped from the remembered list — so a refresh
  // may bring its values back rather than being told to skip it.
  await expect.poll(async () => (await readTable(page, id)).columns.map((c) => c.field)).toEqual(['first', 'nickname']);
  expect((await readTable(page, id)).deletedColumns).toEqual([]);
});

test('backing out of the dialog restores nothing', async ({ page }) => {
  const id = await createTable(page, 'People', [{ field: 'first' }, { field: 'nickname' }]);
  await waitForPanel(page, id);
  await deleteColumn(page, id, 1);

  const dlg = await openColumns(page, id);
  await dlg.locator('.deleted-cols button', { hasText: 'nickname' }).click();
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  // Cancel means cancel: still one column, still remembered.
  expect((await readTable(page, id)).columns.map((c) => c.field)).toEqual(['first']);
  expect((await readTable(page, id)).deletedColumns).toEqual(['nickname']);
});

test('a table that never lost a column offers nothing', async ({ page }) => {
  const id = await createTable(page, 'Clean', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);
  await expect(dlg.locator('.deleted-cols')).toHaveCount(0);
});

test('restoring a name that has been retyped by hand does not duplicate the column', async ({ page }) => {
  const id = await createTable(page, 'People', [{ field: 'first' }, { field: 'nickname' }]);
  await waitForPanel(page, id);
  await deleteColumn(page, id, 1);

  const dlg = await openColumns(page, id);
  // Add it back by hand first, then take the offer as well.
  await dlg.getByRole('button', { name: '+ Add column' }).click();
  await dlg.locator('.col-row input[type="text"]').nth(2).fill('nickname');
  await dlg.locator('.deleted-cols button', { hasText: 'nickname' }).click();
  await expect(dlg.locator('.col-row')).toHaveCount(2);
});
