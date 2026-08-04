import { test, expect } from './fixtures.js';

/**
 * The Import dialog's "Edit columns" checkbox opens a pre-import column editor.
 * Colliding CSV headers (here "TM" and "Tm", which both slug to "tm") are
 * auto-deduped to unique fields; the editor then lets the user rename them,
 * highlighting duplicate/empty names in red and blocking Import until fixed.
 */

const CSV = 'T,TM,Tm\n16.9,25.1,6.6\n17.0,26.0,7.0\n';

test('edit-columns editor highlights duplicates, blocks import, then applies edits', async ({ page, workspaceId }) => {
  await page.route('https://ex.example/data.csv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: CSV,
    }),
  );

  await page.getByTitle('Import data from a URL').click();
  const importDlg = page.locator('import-dialog dialog');
  await importDlg.locator('input[type="text"]').fill('https://ex.example/data.csv');
  await importDlg.getByTestId('import-format').selectOption('csv');
  await importDlg.locator('input[type="checkbox"]').check(); // Edit columns
  await importDlg.getByRole('button', { name: 'Import', exact: true }).click();

  // The column editor opens with the deduped fields.
  const editor = page.locator('column-names-dialog dialog');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Column 1 name')).toHaveValue('t');
  await expect(editor.getByLabel('Column 2 name')).toHaveValue('tm');
  await expect(editor.getByLabel('Column 3 name')).toHaveValue('tm_2');

  const importBtn = editor.getByRole('button', { name: 'Import', exact: true });

  // Introduce a duplicate: rename column 3 back to "tm".
  await editor.getByLabel('Column 3 name').fill('tm');
  await expect(editor.getByLabel('Column 3 name')).toHaveClass(/invalid/);
  await expect(editor.getByLabel('Column 2 name')).toHaveClass(/invalid/);
  await expect(importBtn).toBeDisabled();

  // Empty is also invalid.
  await editor.getByLabel('Column 3 name').fill('');
  await expect(editor.getByLabel('Column 3 name')).toHaveClass(/invalid/);
  await expect(importBtn).toBeDisabled();

  // Fix it → valid → import enabled.
  await editor.getByLabel('Column 3 name').fill('tmin');
  await expect(editor.getByLabel('Column 3 name')).not.toHaveClass(/invalid/);
  await expect(importBtn).toBeEnabled();
  await importBtn.click();
  await expect(editor).toBeHidden();

  // The table was created with the edited fields and correctly remapped values.
  const summary = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === 'data');
          return t ? (await store.rows(t.id).find()).length : 0;
        }, workspaceId),
      )
      .toBe(2);
    return page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === 'data');
      const rows = await store.rows(t.id).find();
      return { fields: t.columns.map((c: any) => c.field), sample: rows.map((r: any) => r.data) };
    }, workspaceId);
  })();

  expect(summary.fields).toEqual(['t', 'tm', 'tmin']);
  // The "Tm" column's values landed under the renamed field, none lost.
  expect(summary.sample.map((d: any) => d.tmin).sort((a: number, b: number) => a - b)).toEqual([6.6, 7.0]);
});
