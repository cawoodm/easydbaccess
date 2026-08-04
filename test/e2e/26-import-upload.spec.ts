import { test, expect } from './fixtures.js';

/**
 * Import dialog additions:
 *   - upload a local file (CSV/JSON) instead of a URL,
 *   - the column editor (Edit columns) works for uploads AND its "Hide" header
 *     toggles all/none,
 *   - a "Limit rows" option caps how many rows are imported.
 */

const CSV5 = 'city,pop\nA,1\nB,2\nC,3\nD,4\nE,5\n';

function openDialog(page: import('@playwright/test').Page) {
  return page.getByTitle('Import data from a URL').click();
}

async function tableRows(page: import('@playwright/test').Page, ws: string, name: string) {
  return page.evaluate(
    async ({ ws, name }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await store.tables.find()).find((x: any) => x.workspaceId === ws && x.name === name);
      if (!t) return null;
      const rows = await store.rows(t.id).find();
      return { columns: t.columns, count: rows.length };
    },
    { ws, name },
  );
}

test('uploads a CSV file into a typed table', async ({ page, workspaceId }) => {
  await openDialog(page);
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="file"]').setInputFiles({
    name: 'places.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV5),
  });
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  await expect.poll(async () => (await tableRows(page, workspaceId, 'places'))?.count ?? 0).toBe(5);
});

test('Limit rows caps how many rows are imported from an upload', async ({ page, workspaceId }) => {
  await openDialog(page);
  const dlg = page.locator('import-dialog dialog');
  await dlg.locator('input[type="file"]').setInputFiles({
    name: 'places.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV5),
  });
  await dlg.locator('input[type="number"]').fill('2');
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  await expect.poll(async () => (await tableRows(page, workspaceId, 'places'))?.count ?? 0).toBe(2);
});

test('Limit rows on a multi-MB upload imports only the cap (streams a prefix)', async ({ page, workspaceId }) => {
  // Build a CSV well over the 1 MiB streaming chunk so the capped read must span
  // several chunks — the case that silently killed the tab when the whole file
  // was read + parsed before the cap applied.
  const pad = 'x'.repeat(600); // fat cell so few rows exceed 1 MiB
  const lines = ['id,blob'];
  for (let i = 1; i <= 4000; i++) lines.push(`${i},${pad}`);
  const big = lines.join('\n') + '\n';
  expect(big.length).toBeGreaterThan(2 * 1024 * 1024); // > 2 MiB

  await openDialog(page);
  const dlg = page.locator('import-dialog dialog');
  await dlg.locator('input[type="file"]').setInputFiles({
    name: 'big.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(big),
  });
  await dlg.locator('input[type="number"]').fill('50');
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  await expect.poll(async () => (await tableRows(page, workspaceId, 'big'))?.count ?? 0).toBe(50);
});

test('column editor: clicking the Hide header toggles all columns hidden', async ({ page, workspaceId }) => {
  await openDialog(page);
  const dlg = page.locator('import-dialog dialog');
  await dlg.locator('input[type="file"]').setInputFiles({
    name: 'places.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV5),
  });
  // Tick "Edit columns" (CSV only) then import → the column editor opens.
  await dlg.locator('label.check input[type="checkbox"]').check();
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  const editor = page.locator('column-names-dialog dialog');
  await expect(editor).toBeVisible();
  const checks = editor.locator('.hidecell input[type="checkbox"]');
  await expect(checks).toHaveCount(2); // city, pop
  // None hidden yet.
  expect(await checks.nth(0).isChecked()).toBe(false);

  // Click the "Hide" header → all become hidden.
  await editor.locator('.head.toggle').click();
  expect(await checks.nth(0).isChecked()).toBe(true);
  expect(await checks.nth(1).isChecked()).toBe(true);
  // Click again → all revealed (all/none toggle).
  await editor.locator('.head.toggle').click();
  expect(await checks.nth(0).isChecked()).toBe(false);

  // Hide just the first column, then import.
  await checks.nth(0).check();
  await editor.getByRole('button', { name: 'Import', exact: true }).click();

  await expect
    .poll(async () => {
      const t = await tableRows(page, workspaceId, 'places');
      if (!t) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (t.columns as any[]).map((c) => `${c.field}:${c.hidden ? 'h' : 'v'}`).join(',');
    })
    .toBe('city:h,pop:v');
});
