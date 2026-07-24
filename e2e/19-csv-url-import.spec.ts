import { test, expect } from './fixtures.js';

/**
 * Importing a .csv file by URL from the Import dialog: the dialog fetches the
 * body and hands it to the CSV importer, creating a typed local table. Network
 * is mocked with page.route.
 */

const CSV = 'city,pop,updated\nBern,133000,2016-01-02\nZug,30000,2016-03-04\n';

test('imports a CSV from a URL into a typed table', async ({ page, workspaceId }) => {
  await page.route('https://ex.example/data.csv', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: CSV,
    }),
  );

  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();

  // The CSV sample is offered in the dropdown.
  const presetLabels = (await dlg.locator('select').first().locator('option').allTextContents())
    .join(' | ')
    .toLowerCase();
  expect(presetLabels).toContain('csv');

  await dlg.locator('input[type="text"]').fill('https://ex.example/data.csv');
  await dlg.locator('select').last().selectOption('csv'); // "Import as: CSV file"
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  const summary = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find(
            (x: any) => x.workspaceId === ws && x.name === 'data',
          );
          if (!t) return 0;
          return (await store.rows(t.id).find()).length;
        }, workspaceId),
      )
      .toBe(2);

    return page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find(
        (x: any) => x.workspaceId === ws && x.name === 'data',
      );
      const cols = Object.fromEntries(
        t.columns.map((c: { field: string; type: string }) => [c.field, c.type]),
      );
      const rows = await store.rows(t.id).find();
      return { cols, pops: rows.map((r: any) => r.data.pop) };
    }, workspaceId);
  })();

  // Header became columns; types were inferred from the values.
  expect(summary.cols.city).toBe('string');
  expect(summary.cols.pop).toBe('number');
  expect(summary.cols.updated).toBe('date');
  // Values coerced to numbers (not "133000" strings), order-independent.
  expect(summary.pops.every((p: unknown) => typeof p === 'number')).toBe(true);
  expect([...summary.pops].sort((a: number, b: number) => a - b)).toEqual([30000, 133000]);
});
