import { test, expect } from './fixtures.js';

/**
 * The Import dialog's "Import into" control. It replaces the modal that used to
 * interrupt an import halfway through ("a table named X already exists —
 * Append / Overwrite / Create new"): the destination is now chosen BEFORE the
 * read starts, and the import kernel writes there.
 *
 * The control only appears for an importer that runs on the kernel
 * (`supports.kernel`). CSV does; JSON and Datasette do not yet.
 */

const FIRST = 'city,pop\nBern,133000\nZug,30000\n';
// Different HEADER NAMES on purpose. A CSV maps onto an existing table BY
// POSITION, so these two rows must land in `city`/`pop` all the same.
const SECOND = 'Town,Inhabitants\nChur,37000\n';

/** Rows of the one table in this workspace, as `city|pop` strings. */
async function rowsOf(page: import('@playwright/test').Page, ws: string, name: string) {
  return page.evaluate(
    async ([wsId, tableName]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (x: any) => x.workspaceId === wsId && x.name === tableName,
      );
      if (!t) return null;
      const rows = await store.rows(t.id).find();
      return {
        fields: t.columns.map((c: { field: string }) => c.field),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        values: rows.map((r: any) => `${r.data.city}|${r.data.pop}`).sort(),
      };
    },
    [ws, name] as const,
  );
}

/** Import one CSV body from a URL, optionally into an existing table. */
async function importCsv(
  page: import('@playwright/test').Page,
  url: string,
  body: string,
  target?: 'append' | 'overwrite',
) {
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body,
    }),
  );
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill(url);
  await dlg.getByTestId('import-format').selectOption('csv');
  if (target) {
    await dlg.getByTestId('import-target').selectOption(target);
    // The table picker only appears once a non-"new" destination is chosen.
    await expect(dlg.getByTestId('import-target-table')).toBeVisible();
  }
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dlg).toBeHidden();
}

test('the target control is hidden for an importer that is not on the kernel', async ({ page }) => {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();

  await dlg.getByTestId('import-format').selectOption('csv');
  await expect(dlg.getByTestId('import-target')).toBeVisible();

  // JSON and Datasette still run their own collision prompt, so offering a
  // destination here would be a promise the dialog cannot keep.
  await dlg.getByTestId('import-format').selectOption('json');
  await expect(dlg.getByTestId('import-target')).toHaveCount(0);
  await dlg.getByTestId('import-format').selectOption('datasette');
  await expect(dlg.getByTestId('import-target')).toHaveCount(0);
});

test('Reference mode hides the target — a reference always makes a new table', async ({ page }) => {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await dlg.getByTestId('import-format').selectOption('csv');
  await expect(dlg.getByTestId('import-target')).toBeVisible();

  await dlg.getByRole('radio').nth(1).check(); // Reference
  await expect(dlg.getByTestId('import-target')).toHaveCount(0);
});

test('Append adds rows to the chosen table, mapping cells by position', async ({
  page,
  workspaceId,
}) => {
  await importCsv(page, 'https://ex.example/a.csv', FIRST);
  await expect.poll(async () => (await rowsOf(page, workspaceId, 'a'))?.values.length).toBe(2);

  await importCsv(page, 'https://ex.example/b.csv', SECOND, 'append');

  // The existing schema is untouched by the incoming CSV's different header
  // names, and its cells land in `city`/`pop` by position.
  await expect
    .poll(async () => (await rowsOf(page, workspaceId, 'a'))?.values)
    .toEqual(['Bern|133000', 'Chur|37000', 'Zug|30000']);
  expect((await rowsOf(page, workspaceId, 'a'))?.fields).toEqual(['city', 'pop']);
  expect(await rowsOf(page, workspaceId, 'b')).toBeNull(); // no second table
});

test('Replace drops the old rows and keeps the table and its columns', async ({
  page,
  workspaceId,
}) => {
  await importCsv(page, 'https://ex.example/c.csv', FIRST);
  await expect.poll(async () => (await rowsOf(page, workspaceId, 'c'))?.values.length).toBe(2);

  await importCsv(page, 'https://ex.example/d.csv', SECOND, 'overwrite');

  // Poll: the dialog closes as soon as it has the answer, so the write is
  // still in flight when `importCsv` returns.
  await expect
    .poll(async () => (await rowsOf(page, workspaceId, 'c'))?.values)
    .toEqual(['Chur|37000']);
  expect((await rowsOf(page, workspaceId, 'c'))?.fields).toEqual(['city', 'pop']);
  expect(await rowsOf(page, workspaceId, 'd')).toBeNull();
});

test('a name clash with target "new" makes a second table instead of prompting', async ({
  page,
  workspaceId,
}) => {
  await importCsv(page, 'https://ex.example/e.csv', FIRST);
  await expect.poll(async () => (await rowsOf(page, workspaceId, 'e'))?.values.length).toBe(2);

  // Same URL, so the same proposed name. The kernel's one naming policy uniques
  // it to `e-2` — no modal, and no base36-timestamp name like `e (m8x1k2)`.
  await page.unroute('https://ex.example/e.csv');
  await importCsv(page, 'https://ex.example/e.csv', SECOND);

  // A NEW table takes its schema from its own CSV, so it gets the second
  // file's headers rather than the first table's columns.
  await expect
    .poll(async () => (await rowsOf(page, workspaceId, 'e-2'))?.fields)
    .toEqual(['town', 'inhabitants']);
  expect((await rowsOf(page, workspaceId, 'e'))?.values).toEqual(['Bern|133000', 'Zug|30000']);
});
