import { test, expect } from './fixtures.js';

/**
 * A Datasette database's hidden tables (FTS/SpatiaLite, or `hidden` metadata)
 * are shown in the import picker — tagged "hidden" and unchecked by default —
 * rather than silently dropped, so the user can still opt them in.
 */
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

test('hidden tables appear in the picker, tagged and unchecked by default', async ({ page }) => {
  await page.route('https://ds.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/hidedb.json') {
      return route.fulfill(
        json({
          tables: [
            { name: 'people', count: 3, primary_keys: ['id'] },
            { name: 'people_fts', count: 0, hidden: true, primary_keys: [] },
          ],
        }),
      );
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await expect(importDialog).toBeVisible();
  await importDialog.locator('input[type="text"]').fill('https://ds.example/hidedb');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  const picker = page.locator('table-select-dialog dialog');
  await expect(picker).toBeVisible();
  const rows = picker.locator('ul.tables li');
  await expect(rows).toHaveCount(2);
  await expect(picker.locator('.tag-hidden')).toHaveCount(1);

  const ftsRow = rows.filter({ hasText: 'people_fts' });
  const peopleRow = rows.filter({ hasNotText: 'people_fts' });
  await expect(ftsRow.locator('.tag-hidden')).toBeVisible();
  // Hidden table is unchecked; the visible one is checked → "1 of 2 selected".
  await expect(ftsRow.locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(peopleRow.locator('input[type="checkbox"]')).toBeChecked();
  await expect(picker.getByText('1 of 2 selected')).toBeVisible();
});
