import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A filter on a HIDDEN column had no way out. The funnel lives in the column
 * header, and a hidden column has no header — so the grid kept narrowing with
 * nothing on screen to say why, and nowhere to switch it off.
 *
 * The column editor now shows a funnel on every filtered column, blue while the
 * filter is on, and a click switches it off. Nothing is written until Save, like
 * everything else in that dialog.
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

/** Filter `keep` on column b, and hide b so its funnel is out of reach. */
async function filterAndHide(page: import('@playwright/test').Page, id: string) {
  await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = await ctx.store.tables.findOne(tableId);
    await ctx.store.tables.patch(tableId, {
      filters: { b: 'keep' },
      columns: t.columns.map((c: { field: string }) => (c.field === 'b' ? { ...c, hidden: true } : c)),
      updatedAt: Date.now(),
    });
  }, id);
}

const storedFilters = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (tableId) => (await (window as any).__easydb.store.tables.findOne(tableId)).filters ?? {},
    id,
  );

async function seed(page: import('@playwright/test').Page) {
  const id = await createTable(page, 'Filtered', [{ field: 'a' }, { field: 'b' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { a: 'one', b: 'keep' },
    { a: 'two', b: 'drop' },
  ]);
  const rows = page.locator(`#${panelDomId(id)}`).locator('data-table tbody tr:not(.spacer):visible');
  await expect(rows).toHaveCount(2);
  await filterAndHide(page, id);
  await expect(rows).toHaveCount(1);
  return { id, rows };
}

test('the editor shows a funnel on the filtered column only', async ({ page }) => {
  const { id } = await seed(page);
  const dlg = await openColumns(page, id);

  await expect(dlg.getByTestId('filter-state-b')).toHaveClass(/\bon\b/);
  await expect(dlg.getByTestId('filter-state-b')).toHaveAttribute('title', /Filtered: keep/);
  await expect(dlg.getByTestId('filter-state-a')).toHaveCount(0);
});

test('switching the filter off releases the rows on Save', async ({ page }) => {
  const { id, rows } = await seed(page);
  const dlg = await openColumns(page, id);

  const funnel = dlg.getByTestId('filter-state-b');
  await funnel.click();
  await expect(funnel).toHaveClass(/\boff\b/);
  // Not written yet — the dialog commits on Save like the rest of the editor.
  expect(await storedFilters(page, id)).toEqual({ b: 'keep' });

  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  await expect(rows).toHaveCount(2);
  expect(await storedFilters(page, id)).toEqual({});
});

test('a second click puts the filter back, expression and all', async ({ page }) => {
  const { id, rows } = await seed(page);
  const dlg = await openColumns(page, id);

  const funnel = dlg.getByTestId('filter-state-b');
  await funnel.click();
  await funnel.click();
  await expect(funnel).toHaveClass(/\bon\b/);

  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  await expect(rows).toHaveCount(1);
  expect(await storedFilters(page, id)).toEqual({ b: 'keep' });
});

test('renaming the field carries its filter across', async ({ page }) => {
  const { id, rows } = await seed(page);
  const dlg = await openColumns(page, id);

  // The field inputs are in column order; b is the second.
  await dlg.locator('.col-row input[type="text"]').nth(2).fill('renamed');
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  expect(await storedFilters(page, id)).toEqual({ renamed: 'keep' });
  await expect(rows).toHaveCount(1);
});
