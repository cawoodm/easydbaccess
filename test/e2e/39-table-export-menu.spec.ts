import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * Per-table footer "Export" button: AnchoredMenu offering CSV / JSON / SQL,
 * each followed by a Visible Data / Raw Data / Structure Only prompt
 * (Visible Data first — it's the dialog's default/primary/Enter choice).
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

test.describe('table export menu', () => {
  test('the per-table Export button opens a menu with CSV, JSON, and SQL entries', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: 'Export' }).click();

    const menu = page.locator('anchored-menu');
    await expect(menu.getByRole('menuitem', { name: 'CSV (.csv)' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'JSON (.table.json)' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'SQL (.sql)' })).toBeVisible();

    // Close it so it doesn't linger for the next test in this worker.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('CSV + Visible Data narrows to non-hidden columns and applies the active filter', async ({ page }) => {
    const id = await createTable(page, 'Contacts', [{ field: 'name' }, { field: 'secret' }, { field: 'city' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice', secret: 'x1', city: 'Zurich' });
    await addRow(page, id, { name: 'Bob', secret: 'x2', city: 'Bern' });
    await addRow(page, id, { name: 'Carol', secret: 'x3', city: 'Zug' });

    // Hide "secret" and set an active filter on "city" (substring "Z" →
    // Zurich + Zug, not Bern) — exactly the state Visible Data must honor.
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

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: 'Export' }).click();
    await page.locator('anchored-menu').getByRole('menuitem', { name: 'CSV (.csv)' }).click();

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByRole('button', { name: 'Visible Data' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Visible Data' }).click();
    await expect(dialog).toBeHidden();

    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [file] = await savedFiles(page);
    expect(file?.filename).toBe('contacts.csv');

    const lines = file!.body.trim().split('\r\n');
    // Header excludes the hidden "secret" column.
    expect(lines[0]).toBe('name,city');
    // Only Zurich + Zug rows pass the "Z" filter on city; Bern is excluded.
    const dataLines = lines.slice(1).sort();
    expect(dataLines).toEqual(['Alice,Zurich', 'Carol,Zug']);
  });

  test('CSV + Structure Only writes just the header line, no data rows', async ({ page }) => {
    const id = await createTable(page, 'Structure', [{ field: 'name' }, { field: 'qty' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice', qty: 1 });
    await addRow(page, id, { name: 'Bob', qty: 2 });

    await stubSaveFile(page);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: 'Export' }).click();
    await page.locator('anchored-menu').getByRole('menuitem', { name: 'CSV (.csv)' }).click();

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByRole('button', { name: 'Structure Only' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Structure Only' }).click();
    await expect(dialog).toBeHidden();

    await expect.poll(async () => (await savedFiles(page)).length).toBe(1);
    const [file] = await savedFiles(page);
    expect(file?.filename).toBe('structure.csv');

    // Header only — the "no data rows" outcome the user asked for.
    expect(file!.body.trim()).toBe('name,qty');
  });

  test('cancelling the scope prompt writes nothing', async ({ page }) => {
    const id = await createTable(page, 'Nothing', [{ field: 'name' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice' });

    await stubSaveFile(page);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: 'Export' }).click();
    await page.locator('anchored-menu').getByRole('menuitem', { name: 'SQL (.sql)' }).click();

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByRole('button', { name: 'Visible Data' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Give any (incorrect) async write a moment to land, then confirm none did.
    await page.waitForTimeout(200);
    expect(await savedFiles(page)).toHaveLength(0);
  });
});
