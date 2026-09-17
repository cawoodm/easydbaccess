import { expect, test, type Page } from '@playwright/test';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Save refuses to overwrite a `.edb` that has moved since this tab last wrote it.
 *
 * The stamp — the file's exact mtime and size at the moment our copy and it last
 * agreed — has been recorded since v0.0.4xx, but only the SYNC command ever read
 * it. `persist()` wrote unconditionally, so an autosave tick would replace another
 * machine's work with no question asked. That is the one loss the app cannot undo:
 * the bytes it overwrote were the only copy.
 *
 * Now every write compares first. A difference from the stamp means something else
 * wrote the file, and the user decides.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `126-one-workspace-per-file.spec.ts`. The "other machine" is a second write to
 * the same OPFS file, made from the page — which is exactly what an outside writer
 * looks like from here: different bytes, a different mtime.
 */

const FOLDER = 'outside-write';

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
/** The two blunt answers, as the buttons word them. */
const PUSH = 'Push — overwrite the file from here';
const PULL = 'Pull — overwrite this copy from the file';
const dialog = (page: Page) => page.locator('host-dialogs');

/** Size and mtime of a file in the stub folder. */
async function statFile(page: Page, name: string): Promise<{ size: number; mtime: number }> {
  return page.evaluate(
    async ({ folder, file }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const f = await (await dir.getFileHandle(file)).getFile();
      return { size: f.size, mtime: f.lastModified };
    },
    { folder: FOLDER, file: name },
  );
}

/**
 * Somebody else writes the file.
 *
 * Appending rather than replacing: the bytes have to be DIFFERENT (so the size
 * moves even where the clock does not) while the file stays something the app can
 * still stat. What is in it does not matter — the guard is about the stamp, and
 * nothing reads the contents unless the user asks to load them.
 */
async function outsideWrite(page: Page, name: string): Promise<void> {
  await page.evaluate(
    async ({ folder, file }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const handle = await dir.getFileHandle(file);
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.write(new Uint8Array(64)); // 64 bytes nobody here wrote
      await w.close();
    },
    { folder: FOLDER, file: name },
  );
}

/** A workspace saved into the folder, so there is a file and a stamp for it. */
async function savedIntoFolder(page: Page, space: string): Promise<string> {
  await boot(page, space);
  const id = await createTable(page, 'Mine', [{ field: 'part', renderer: 'link' }]);
  await waitForPanel(page, id);
  await saveButton(page).click();
  await expect(dialog(page).getByText(/stored in this browser/)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText(`${space}.edb`, { timeout: 30_000 });
  return id;
}

test('a save straight after a save asks nothing — the file is as we left it', async ({ page }) => {
  await savedIntoFolder(page, 'quiet');
  await createTable(page, 'Another', [{ field: 'x', renderer: 'link' }]);

  await saveButton(page).click();

  // The guard must be invisible in the ordinary case, or it is just a nag.
  await expect(page.locator('toast-host')).toContainText('quiet.edb', { timeout: 30_000 });
  await expect(dialog(page).getByText(/has been written since/)).toBeHidden();
});

test('a file written by something else stops the save and says so', async ({ page }) => {
  await savedIntoFolder(page, 'guarded');
  await outsideWrite(page, 'guarded.edb');
  const before = await statFile(page, 'guarded.edb');

  await saveButton(page).click();

  await expect(dialog(page).getByText(/has been written since this tab last saved it/)).toBeVisible({ timeout: 20_000 });
  // Four answers since v0.0.4xx, not two: the blunt pair is still here, with the
  // two that settle the copies table by table in front of them. See
  // `139-replication-merge.spec.ts` for what those do.
  await expect(dialog(page).getByRole('button', { name: 'Take newest', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Compare tables…', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: PUSH })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: PULL })).toBeVisible();

  // Nothing written while the question is open.
  expect(await statFile(page, 'guarded.edb')).toEqual(before);
});

test('choosing the local version goes ahead and writes', async ({ page }) => {
  await savedIntoFolder(page, 'forced');
  await outsideWrite(page, 'forced.edb');
  const before = await statFile(page, 'forced.edb');

  await saveButton(page).click();
  await expect(dialog(page).getByText(/has been written since this tab last saved it/)).toBeVisible({ timeout: 20_000 });
  await dialog(page).getByRole('button', { name: PUSH }).click();

  await expect(page.locator('toast-host')).toContainText('forced.edb', { timeout: 30_000 });
  await expect.poll(async () => (await statFile(page, 'forced.edb')).size).not.toBe(before.size);
});

test('once written, the file is ours again and the next save is quiet', async ({ page }) => {
  await savedIntoFolder(page, 'again');
  await outsideWrite(page, 'again.edb');

  await saveButton(page).click();
  await expect(dialog(page).getByText(/has been written since this tab last saved it/)).toBeVisible({ timeout: 20_000 });
  await dialog(page).getByRole('button', { name: PUSH }).click();
  await expect(page.locator('toast-host')).toContainText('again.edb', { timeout: 30_000 });

  // The write recorded a fresh stamp, so the file matches us once more.
  await createTable(page, 'More', [{ field: 'x', renderer: 'link' }]);
  await saveButton(page).click();
  await expect(dialog(page).getByText(/has been written since/)).toBeHidden();
});

test('dismissing the question writes nothing', async ({ page }) => {
  await savedIntoFolder(page, 'dismissed');
  await outsideWrite(page, 'dismissed.edb');
  const before = await statFile(page, 'dismissed.edb');

  await saveButton(page).click();
  await expect(dialog(page).getByText(/has been written since this tab last saved it/)).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // None of the four answers is "leave both alone" — dismissing is, as it is for
  // every other `choice` in this app, and it is the only one that touches
  // nothing.
  await expect(dialog(page).getByText(/has been written since/)).toBeHidden();
  expect(await statFile(page, 'dismissed.edb')).toEqual(before);
  // Not a dead end: the way to read the file in is named.
  await expect(page.locator('toast-host')).toContainText('Sync workspace folder');
});

test('the question shows both sides', async ({ page }) => {
  await savedIntoFolder(page, 'sided');
  await outsideWrite(page, 'sided.edb');

  await saveButton(page).click();
  await expect(dialog(page).getByText(/has been written since this tab last saved it/)).toBeVisible({ timeout: 20_000 });
  // Which copy to keep is not answerable from the file name alone — both sides
  // are named, with what each holds.
  await expect(dialog(page)).toContainText('In this browser');
  await expect(dialog(page)).toContainText('sided.edb');
});

test('the first save into a brand-new file asks nothing', async ({ page }) => {
  // There is no stamp for a file nobody has agreed with, and a difference nobody
  // can measure is not a red flag. Asking here would put a dialog in front of
  // every first save.
  await boot(page, 'fresh');
  const id = await createTable(page, 'Mine', [{ field: 'part', renderer: 'link' }]);
  await waitForPanel(page, id);

  await saveButton(page).click();
  await expect(dialog(page).getByText(/stored in this browser/)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Connect a folder…', exact: true }).click();

  await expect(page.locator('toast-host')).toContainText('fresh.edb', { timeout: 30_000 });
  await expect(dialog(page).getByText(/has been written since/)).toBeHidden();
  await expect(page.locator(`#${panelDomId(id)}`)).toBeVisible();
});
