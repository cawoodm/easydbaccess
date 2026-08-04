import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * `Table.readonly` — the grid shows values without editors and offers no
 * add/delete row. It is set automatically on a reference table (its rows live at
 * the source and every write throws there anyway, so offering an editor was a
 * promise the app could not keep) and is toggleable per table in the column
 * editor.
 */

function panel(page: import('@playwright/test').Page, tableId: string) {
  return page.locator(`#${panelDomId(tableId)}`);
}

/** Mark an existing table read-only through the store, the way an import would. */
async function setReadonly(page: import('@playwright/test').Page, tableId: string) {
  await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    await store.tables.patch(id, { readonly: true, updatedAt: Date.now() });
  }, tableId);
}

test('a read-only table shows values as text, with no editors', async ({ page }) => {
  const id = await createTable(page, 'Locked', [{ field: 'name' }, { field: 'note' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada', note: 'hello' });

  const cells = panel(page, id).locator('data-table tbody td');
  // Editable to begin with: a column with no renderer gets a native input.
  await expect(cells.nth(0).locator('input')).toHaveValue('ada');

  await setReadonly(page, id);

  // Same values, now as plain text.
  await expect(cells.nth(0).locator('input')).toHaveCount(0);
  await expect(cells.nth(0)).toHaveText('ada');
  await expect(cells.nth(1)).toHaveText('hello');
});

test('a read-only table offers neither add row nor delete row', async ({ page }) => {
  const id = await createTable(page, 'Locked', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });

  const addBtn = panel(page, id).locator('panel-footer').getByRole('button', { name: 'Add row' });
  const delBtn = panel(page, id).locator('data-table tbody button.danger');
  await expect(addBtn).toBeVisible();
  await expect(delBtn).toHaveCount(1);

  await setReadonly(page, id);

  await expect(addBtn).toHaveCount(0);
  await expect(delBtn).toHaveCount(0);
});

test('the column editor toggles read-only on and off', async ({ page }) => {
  const id = await createTable(page, 'Toggle', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'ada' });

  const openEditor = async () => {
    await panel(page, id)
      .locator('panel-footer')
      .getByRole('button', { name: /Columns/ })
      .click();
    const dlg = page.locator('new-table-dialog dialog');
    await expect(dlg).toBeVisible();
    return dlg;
  };

  let dlg = await openEditor();
  const box = dlg.getByTestId('table-readonly');
  await expect(box).not.toBeChecked();
  await box.check();
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg).toBeHidden();

  await expect.poll(async () => (await readTable(page, id))?.readonly).toBe(true);
  await expect(panel(page, id).locator('data-table tbody td').first().locator('input')).toHaveCount(0);

  // ...and back off again: the checkbox reflects the saved state.
  dlg = await openEditor();
  await expect(dlg.getByTestId('table-readonly')).toBeChecked();
  await dlg.getByTestId('table-readonly').uncheck();
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg).toBeHidden();

  await expect.poll(async () => (await readTable(page, id))?.readonly).toBe(false);
  await expect(panel(page, id).locator('data-table tbody td').first().locator('input')).toHaveValue('ada');
});

test('a referenced table is read-only from the moment it is created', async ({ page, workspaceId }) => {
  const url = 'https://ex.example/ref.csv';
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: 'city,pop\nBern,133000\n',
    }),
  );

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill(url);
  await dlg.getByTestId('import-format').selectOption('csv');
  await dlg.getByRole('radio').nth(1).check(); // Reference
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dlg).toBeHidden();

  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.source);
        return t ? { source: t.source.type, readonly: t.readonly === true } : null;
      }, workspaceId),
    )
    .toEqual({ source: 'url', readonly: true });
});
