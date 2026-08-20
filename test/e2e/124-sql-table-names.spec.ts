import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { addRow, createTable, waitForPanel } from './helpers.js';

/**
 * A table is called the same thing in the file as on screen.
 *
 * `Order Details` used to become `Order_Details`, because the physical name went
 * through `sanitizeTableName` — and a rename left the SQL table under whatever it
 * was first called. Both are pointless mangling: every reference is quoted, and a
 * `.edb` exists to be opened by other SQL tools.
 *
 * Proven from OUTSIDE the app, in Node's SQLite, because that is who the promise
 * is to.
 */

const FOLDER = 'name-target';

async function boot(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ folder }) => {
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      (window as unknown as Record<string, unknown>)['showDirectoryPicker'] = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(folder, { create: true });
      };
    },
    { folder: FOLDER },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

function saveButton(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

/** The bytes of the workspace's file in the stub folder, or null while it is not there. */
async function folderFile(page: Page, name: string): Promise<Buffer | null> {
  const b64 = await page.evaluate(
    async ({ folder, file }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder);
        const handle = await dir.getFileHandle(file);
        const buffer = await (await handle.getFile()).arrayBuffer();
        let binary = '';
        for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
        return binary.length > 0 ? btoa(binary) : null;
      } catch {
        return null;
      }
    },
    { folder: FOLDER, file: name },
  );
  return b64 === null ? null : Buffer.from(b64, 'base64');
}

/** Save, answering the "where should this live?" question on a first save. */
async function save(page: Page, file: string, first: boolean): Promise<void> {
  const before = first ? null : await folderFile(page, file);
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  if (first) {
    await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  } else {
    // A later Save may confirm that it is replacing the file it already wrote.
    const yes = dialog.getByRole('button', { name: 'Yes', exact: true });
    await yes.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
    if (await yes.isVisible().catch(() => false)) await yes.click();
  }
  await expect
    .poll(
      async () => {
        const now = await folderFile(page, file);
        return now !== null && (before === null || !now.equals(before));
      },
      { timeout: 30_000, message: `${file} never changed on disk` },
    )
    .toBe(true);
}

/** The table names a foreign SQL tool would list in the saved file. */
function tablesInFile(bytes: Buffer, path: string): string[] {
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => String(r['name']));
  } finally {
    db.close();
  }
}

test('a name with a space is that name in the file, and a rename moves it', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const ws = `names-${testInfo.testId}`.toLowerCase();
  const file = `${ws}.edb`;
  await boot(page, ws);

  const id = await createTable(page, 'Order Details', [
    { field: 'part', type: 'string' },
    { field: 'qty', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { part: 'bolt', qty: 4 });
  await save(page, file, true);

  const first = await folderFile(page, file);
  expect(first).not.toBeNull();
  const names = tablesInFile(first!, testInfo.outputPath('first.edb'));
  expect(names).toContain('Order Details');
  expect(names).not.toContain('Order_Details');

  // Rename, the way the columns editor does — through the store.
  await page.evaluate(
    async ({ tableId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__easydb.store.tables.patch(tableId, { name: 'Order Lines', updatedAt: Date.now() });
    },
    { tableId: id },
  );
  await save(page, file, false);

  const second = await folderFile(page, file);
  const renamed = tablesInFile(second!, testInfo.outputPath('second.edb'));
  expect(renamed).toContain('Order Lines');
  expect(renamed).not.toContain('Order Details');

  // And the row came with it, read straight out of the file.
  writeFileSync(testInfo.outputPath('rows.edb'), second!);
  const db = new DatabaseSync(testInfo.outputPath('rows.edb'), { readOnly: true });
  try {
    expect(db.prepare(`SELECT part, qty FROM "Order Lines"`).all()).toEqual([{ part: 'bolt', qty: 4 }]);
  } finally {
    db.close();
  }
});
