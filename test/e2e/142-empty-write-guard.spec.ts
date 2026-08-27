import { expect, test, type Page } from '@playwright/test';
import { createTable, waitForPanel } from './helpers.js';

/**
 * A save must not put an empty workspace on top of a file that holds work —
 * not without saying so in red, twice.
 *
 * This is the reported data loss: the tables are gone from the screen for some
 * other reason, the workspace is therefore empty, and the next Save writes that
 * emptiness over the file that still had everything in it. The file was the good
 * copy and the save destroyed it.
 *
 * The guard measures BYTES on both sides (`db/edb/empty-write.ts`,
 * `db/edb/guarded-write.ts`) rather than reading the store or a file stamp, so a
 * bug in that bookkeeping cannot make the guard agree with it.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `127-folder-sync-writes-out.spec.ts`.
 */

const FOLDER = 'empty-write-guard';

test.describe.configure({ timeout: 120_000 });

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

const saveButton = (page: Page) => page.locator('app-shell').getByRole('button', { name: /Save/ });
const guard = (page: Page) => page.locator('danger-confirm dialog');

/** The size of a file in the stubbed folder, or 0 when it is not there. */
async function fileSize(page: Page, name: string): Promise<number> {
  return page.evaluate(
    async ({ folder, file }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder);
        return (await (await dir.getFileHandle(file)).getFile()).size;
      } catch {
        return 0;
      }
    },
    { folder: FOLDER, file: name },
  );
}

/**
 * Is the table still in the FILE?
 *
 * Read out of the raw bytes: the table's name appears in its own document and in
 * the SQL schema of the table holding its rows, and neither survives a save that
 * emptied the workspace. Crude on purpose — the point is to trust nothing the app
 * says about the file, only the file.
 */
async function fileStillHas(page: Page, name: string, table: string): Promise<boolean> {
  return page.evaluate(
    async ({ folder, file, needle }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(file)).getFile()).arrayBuffer());
      return new TextDecoder('latin1').decode(bytes).includes(needle);
    },
    { folder: FOLDER, file: name, needle: table },
  );
}

/** The first Save of a workspace with no file: it asks for a folder, then writes. */
async function firstSaveIntoAFolder(page: Page): Promise<void> {
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText(/Workspace saved to alpha\.edb/i, { timeout: 30_000 });
}

/** Take the tables away, which is what leaves the workspace empty. */
async function dropEveryTable(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ id: string }[]>; remove(id: string): Promise<unknown> } } } }).__easydb;
    for (const t of await app.store.tables.find()) await app.store.tables.remove(t.id);
  });
  await expect.poll(() => page.locator('data-table').count()).toBe(0);
}

async function setUpFileWithWork(page: Page): Promise<number> {
  await boot(page, 'alpha');
  const id = await createTable(page, 'keep', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ tableId }) => {
      const app = (window as unknown as { __easydb: { store: { rows(t: string): { insert(d: unknown): Promise<unknown> } } } }).__easydb;
      await app.store.rows(tableId).insert({ id: 'r1', tableId, data: { a: 'precious' }, updatedAt: Date.now() });
    },
    { tableId: id },
  );
  await firstSaveIntoAFolder(page);
  const size = await fileSize(page, 'alpha.edb');
  expect(size).toBeGreaterThan(0);
  return size;
}

test('an ordinary save is not interrupted', async ({ page }) => {
  // The guard must be invisible in the case that happens a thousand times a day,
  // or it will be clicked through without reading in the case that matters.
  await setUpFileWithWork(page);

  await saveButton(page).click();
  await expect(page.locator('toast-host')).toContainText(/Workspace saved/i, { timeout: 30_000 });
  expect(await guard(page).count()).toBe(0);
});

test('saving an empty workspace over a file with work asks twice, in red', async ({ page }) => {
  const before = await setUpFileWithWork(page);
  await dropEveryTable(page);

  await saveButton(page).click();

  // Step one: red, marked, and it says what is about to go.
  const dlg = guard(page);
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  await expect(dlg).toContainText(/step 1 of 2/i);
  await expect(dlg).toContainText('alpha.edb');
  await expect(dlg).toContainText('1 table');
  await expect(dlg).toContainText('no undo');
  await expect(dlg.locator('.mark')).toHaveText('❗');
  await expect(dlg.locator('h2')).toContainText('⚠');
  // The safe answer holds the focus, so a held Enter cannot walk through both steps.
  await expect(dlg.locator('button.safe')).toBeFocused();

  // Step two, and only after the first is confirmed.
  await dlg.locator('button.destroy').click();
  await expect(dlg).toContainText(/step 2 of 2/i);
  await expect(dlg).toContainText('deletes 1 table');
  await expect(dlg.locator('button.safe')).toBeFocused();

  // Cancel: the file is untouched, and the app says so.
  await dlg.locator('button.safe').click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('toast-host')).toContainText(/is untouched/i, { timeout: 20_000 });
  expect(await fileSize(page, 'alpha.edb')).toBe(before);
  expect(await fileStillHas(page, 'alpha.edb', 'precious')).toBe(true);
});

test('Escape on the warning keeps the file', async ({ page }) => {
  const before = await setUpFileWithWork(page);
  await dropEveryTable(page);

  await saveButton(page).click();
  await expect(guard(page)).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  await expect(guard(page)).toBeHidden();
  expect(await fileSize(page, 'alpha.edb')).toBe(before);
});

test('a stopped save leaves the workspace marked unsaved', async ({ page }) => {
  // The dangerous half of a refusal: if the app treated the stopped write as a
  // save it would mark the workspace clean, and the next reload would lose the
  // work anyway — silently this time.
  await setUpFileWithWork(page);
  await dropEveryTable(page);

  await saveButton(page).click();
  await expect(guard(page)).toBeVisible({ timeout: 20_000 });
  await guard(page).locator('button.safe').click();

  // The red dot the shell draws for `ButtonSpec.badge` — see `100-edb-browser`.
  await expect(saveButton(page).locator('.badge')).toBeVisible({ timeout: 20_000 });
});

test('confirming twice does write, so the guard is not a dead end', async ({ page }) => {
  // Emptying a file on purpose has to remain possible: a guard with no way
  // through is a bug report waiting to happen.
  await setUpFileWithWork(page);
  await dropEveryTable(page);

  await saveButton(page).click();
  const dlg = guard(page);
  await expect(dlg).toBeVisible({ timeout: 20_000 });
  await dlg.locator('button.destroy').click();
  await dlg.locator('button.destroy').click();
  await expect(dlg).toBeHidden();

  // The write went through: the app said it saved, and it did NOT say the file was
  // left alone. The file's own bytes are not the check here — SQLite keeps deleted
  // content in free pages, so a scan for the old row finds it in a file that no
  // longer holds the table at all.
  await expect(page.locator('toast-host')).toContainText(/Workspace saved/i, { timeout: 30_000 });
  await expect(page.locator('toast-host')).not.toContainText(/is untouched/i);
});
