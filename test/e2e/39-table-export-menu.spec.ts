import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * The per-table footer "Export" button, now that it opens the export dialog.
 *
 * It used to open an anchored CSV / JSON / SQL menu and then ask Raw Data /
 * Visible Data / Structure Only in a second prompt. These are the same outcomes
 * asserted through the dialog: the general options say which columns and which
 * rows, and "Structure Only" is a limit of no rows rather than a third scope.
 */

/** Replaces `api.backend.saveFile` with an in-memory recorder so the test can
 * assert on written content without driving a real browser download. */
async function stubSaveFile(page: Page) {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).__easydb.api;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__savedFiles = [];
    api.backend.saveFile = async (filename: string, body: string, mimeType: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__savedFiles.push({ filename, body, mimeType });
    };
  });
}

async function savedFiles(page: Page): Promise<Array<{ filename: string; body: string }>> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (window as any).__savedFiles ?? [],
  );
}

const dialog = (page: Page) => page.locator('export-dialog dialog');

/** Open the dialog from a table's footer button. */
async function openFromTable(page: Page, id: string) {
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByRole('button', { name: 'Export' })
    .click();
  await expect(dialog(page)).toBeVisible();
}

/** Pick one of a general option's radios, e.g. `choose(page, 'columns', 'all')`. */
async function choose(page: Page, key: string, value: string) {
  await dialog(page).getByTestId(`export-${key}-${value}`).check();
}

test.describe('table export', () => {
  test('the per-table Export button opens the dialog with every registered format', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);
    await openFromTable(page, id);

    // The list comes from the exporter registry, not from a hard-coded menu.
    const options = dialog(page).locator('[data-testid="export-format"] option');
    await expect(options).toHaveText(['CSV', 'JSON', 'SQL']);
    // The one table it was opened for, so no selector was needed.
    await expect(dialog(page)).toContainText('Widgets');
  });

  test('Visible columns + Filtered rows narrows to what is on screen', async ({ page }) => {
    const id = await createTable(page, 'Contacts', [{ field: 'name' }, { field: 'secret' }, { field: 'city' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice', secret: 'x1', city: 'Zurich' });
    await addRow(page, id, { name: 'Bob', secret: 'x2', city: 'Bern' });
    await addRow(page, id, { name: 'Carol', secret: 'x3', city: 'Zug' });

    // Hide "secret" and set an active filter on "city" (substring "Z" → Zurich +
    // Zug, not Bern) — exactly the state the defaults must honor.
    const t = await readTable(page, id);
    t.columns[1].hidden = true;
    await page.evaluate(
      async ({ id, columns }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        await store.tables.patch(id, { columns, filters: { city: 'Z' }, updatedAt: Date.now() });
      },
      { id, columns: t.columns },
    );

    await stubSaveFile(page);
    await openFromTable(page, id);
    // Visible + Filtered are the defaults, so this is one click.
    await dialog(page).getByTestId('export-run').click();

    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [file] = await savedFiles(page);
    expect(file?.filename).toBe('contacts.csv');

    const lines = file!.body.trim().split('\r\n');
    expect(lines[0]).toBe('name,city');
    expect(lines.slice(1).sort()).toEqual(['Alice,Zurich', 'Carol,Zug']);
  });

  test('All columns + Unfiltered rows writes everything', async ({ page }) => {
    const id = await createTable(page, 'Contacts', [{ field: 'name' }, { field: 'secret' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice', secret: 'x1' });
    await addRow(page, id, { name: 'Bob', secret: 'x2' });
    const t = await readTable(page, id);
    t.columns[1].hidden = true;
    await page.evaluate(
      async ({ id, columns }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window as any).__easydb.store.tables.patch(id, { columns, filters: { name: 'Alice' }, updatedAt: Date.now() });
      },
      { id, columns: t.columns },
    );

    await stubSaveFile(page);
    await openFromTable(page, id);
    await choose(page, 'columns', 'all');
    await choose(page, 'rows', 'unfiltered');
    await dialog(page).getByTestId('export-run').click();

    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const lines = (await savedFiles(page))[0]!.body.trim().split('\r\n');
    expect(lines[0]).toBe('name,secret');
    expect(lines).toHaveLength(3);
  });

  test('a limit writes the header and that many rows — the old "Structure Only" is a limit of none', async ({ page }) => {
    const id = await createTable(page, 'Structure', [{ field: 'name' }, { field: 'qty' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice', qty: 1 });
    await addRow(page, id, { name: 'Bob', qty: 2 });

    await stubSaveFile(page);
    await openFromTable(page, id);
    await dialog(page).getByTestId('export-limit').fill('1');
    await dialog(page).getByTestId('export-run').click();

    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [file] = await savedFiles(page);
    expect(file?.filename).toBe('structure.csv');
    expect(file!.body.trim().split('\r\n')).toHaveLength(2);
  });

  test('cancelling writes nothing', async ({ page }) => {
    const id = await createTable(page, 'Nothing', [{ field: 'name' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice' });

    await stubSaveFile(page);
    await openFromTable(page, id);
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toBeHidden();

    // Give any (incorrect) async write a moment to land, then confirm none did.
    await page.waitForTimeout(200);
    expect(await savedFiles(page)).toHaveLength(0);
  });
});
