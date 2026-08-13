import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The export dialog reached from the WORKSPACE, where more than one table can be
 * written, plus the per-format option panels.
 *
 * The workspace path used to be a two-entry menu (JSON dump or SQL script) that
 * always took every table with no options at all.
 */

async function stubSaveFile(page: Page) {
  await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const api = (window as any).__easydb.api;
    (window as any).__savedFiles = [];
    api.backend.saveFile = async (filename: string, body: string, mimeType: string) => {
      (window as any).__savedFiles.push({ filename, body, mimeType });
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

async function savedFiles(page: Page): Promise<Array<{ filename: string; body: string; mimeType: string }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => (window as any).__savedFiles ?? []);
}

const dialog = (page: Page) => page.locator('export-dialog dialog');
const selector = (page: Page) => page.locator('table-select-dialog dialog');

/** The workspace footer button, which is where a multi-table export starts. */
async function openFromWorkspace(page: Page) {
  await page.locator('app-shell').locator('footer').getByRole('button', { name: 'Export' }).click();
}

async function pickFormat(page: Page, label: string) {
  await dialog(page).getByTestId('export-format').selectOption({ label });
}

test('two tables in the workspace ask which ones to export', async ({ page }) => {
  const a = await createTable(page, 'Alpha', [{ field: 'name' }]);
  await waitForPanel(page, a);
  const b = await createTable(page, 'Beta', [{ field: 'name' }]);
  await waitForPanel(page, b);
  await addRow(page, a, { name: 'a1' });
  await addRow(page, b, { name: 'b1' });

  await stubSaveFile(page);
  await openFromWorkspace(page);

  // The selector already existed for imports — export calls the same one.
  await expect(selector(page)).toBeVisible();
  await expect(selector(page)).toContainText('Alpha');
  await expect(selector(page)).toContainText('Beta');
});

test('the export selector shows no row counts at all', async ({ page }) => {
  // It used to show a per-device cached count, which reads 0 for a table this
  // device has never opened — so tables full of data were offered as "0 rows".
  // Counting them for real is an index scan per table, too much to pay on the
  // way to a dialog asking WHICH tables. So the number is gone, not corrected.
  const a = await createTable(page, 'Alpha', [{ field: 'name' }]);
  await waitForPanel(page, a);
  const b = await createTable(page, 'Beta', [{ field: 'name' }]);
  await waitForPanel(page, b);
  await bulkAddRows(
    page,
    a,
    Array.from({ length: 3 }, (_, i) => ({ name: `a${i}` })),
  );
  await addRow(page, b, { name: 'b1' });

  await stubSaveFile(page);
  await openFromWorkspace(page);
  await expect(selector(page)).toBeVisible();
  await expect(selector(page)).toContainText('Alpha');
  await expect(selector(page)).not.toContainText('rows');
  await expect(selector(page)).not.toContainText('1 row');
});

test('one table in the workspace skips the selector', async ({ page }) => {
  const a = await createTable(page, 'Only', [{ field: 'name' }]);
  await waitForPanel(page, a);
  await stubSaveFile(page);
  await openFromWorkspace(page);

  // Nothing to choose, so nothing is asked.
  await expect(dialog(page)).toBeVisible();
  await expect(selector(page)).toBeHidden();
  await expect(dialog(page)).toContainText('Only');
});

test('several tables as JSON become ONE dump file', async ({ page }) => {
  const a = await createTable(page, 'Alpha', [{ field: 'name' }]);
  await waitForPanel(page, a);
  const b = await createTable(page, 'Beta', [{ field: 'name' }]);
  await waitForPanel(page, b);
  await addRow(page, a, { name: 'a1' });
  await addRow(page, b, { name: 'b1' });

  await stubSaveFile(page);
  await openFromWorkspace(page);
  await selector(page).getByRole('button', { name: /^Choose/ }).click();
  await expect(dialog(page)).toBeVisible();
  await pickFormat(page, 'JSON');
  await dialog(page).getByTestId('export-run').click();

  await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
  const [file] = await savedFiles(page);
  expect(file?.filename).toMatch(/^workspace-.*\.json$/);
  const dump = JSON.parse(file!.body) as { tables: Array<{ name: string; rows: unknown[] }> };
  expect(dump.tables.map((t) => t.name).sort()).toEqual(['Alpha', 'Beta']);
});

test('several tables as CSV become one file EACH — a CSV has no shape for two tables', async ({ page }) => {
  const a = await createTable(page, 'Alpha', [{ field: 'name' }]);
  await waitForPanel(page, a);
  const b = await createTable(page, 'Beta', [{ field: 'name' }]);
  await waitForPanel(page, b);
  await addRow(page, a, { name: 'a1' });
  await addRow(page, b, { name: 'b1' });

  await stubSaveFile(page);
  await openFromWorkspace(page);
  await selector(page).getByRole('button', { name: /^Choose/ }).click();
  await pickFormat(page, 'CSV');
  await dialog(page).getByTestId('export-run').click();

  await expect.poll(async () => (await savedFiles(page)).length).toBe(2);
  expect((await savedFiles(page)).map((f) => f.filename).sort()).toEqual(['alpha.csv', 'beta.csv']);
});

test('the CSV panel changes the file it writes', async ({ page }) => {
  const id = await createTable(page, 'Sep', [{ field: 'name' }, { field: 'qty' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'Alice', qty: 1 });

  await stubSaveFile(page);
  await page.locator(`#${panelDomId(id)} panel-footer`).getByRole('button', { name: 'Export' }).click();
  await expect(dialog(page)).toBeVisible();

  // The panel is the format's own element, mounted by tag — the dialog imports
  // nothing from the plugin.
  const panel = dialog(page).locator('csv-export-options');
  await expect(panel).toBeVisible();
  await panel.getByTestId('csv-separator').selectOption(';');
  await panel.getByTestId('csv-header').uncheck();
  await dialog(page).getByTestId('export-run').click();

  await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
  expect((await savedFiles(page))[0]!.body.trim()).toBe('Alice;1');
});

test('a typed CSV header carries the column types', async ({ page }) => {
  const id = await createTable(page, 'Typed', [{ field: 'code' }, { field: 'qty', type: 'number' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: '007', qty: 3 });

  await stubSaveFile(page);
  await page.locator(`#${panelDomId(id)} panel-footer`).getByRole('button', { name: 'Export' }).click();
  await dialog(page).locator('csv-export-options').getByTestId('csv-typed-header').check();
  await dialog(page).getByTestId('export-run').click();

  await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
  // `field:label:type`, which csv-import reads back instead of inferring "007"
  // as a number.
  expect((await savedFiles(page))[0]!.body.split('\r\n')[0]).toBe('code:code:string,qty:qty:number');
});

test('switching format switches the panel', async ({ page }) => {
  const id = await createTable(page, 'Panels', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await page.locator(`#${panelDomId(id)} panel-footer`).getByRole('button', { name: 'Export' }).click();
  await expect(dialog(page).locator('csv-export-options')).toBeVisible();

  await pickFormat(page, 'JSON');
  await expect(dialog(page).locator('json-export-options')).toBeVisible();
  await expect(dialog(page).locator('csv-export-options')).toBeHidden();

  // SQL registers no panel of its own, so the block goes away entirely.
  await pickFormat(page, 'SQL');
  await expect(dialog(page).locator('json-export-options')).toBeHidden();
});

test('SQL is still offered, and still writes a script', async ({ page }) => {
  // It used to be hard-coded in the menu the dialog replaced. Registering it is
  // what keeps the format the app already had.
  const id = await createTable(page, 'Scripted', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'Alice' });

  await stubSaveFile(page);
  await page.locator(`#${panelDomId(id)} panel-footer`).getByRole('button', { name: 'Export' }).click();
  await pickFormat(page, 'SQL');
  await dialog(page).getByTestId('export-run').click();

  await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
  const [file] = await savedFiles(page);
  expect(file?.filename).toBe('scripted.sql');
  expect(file!.body).toContain('CREATE TABLE');
  expect(file!.body).toContain("INSERT INTO");
});
