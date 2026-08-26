import { expect, test, type Page } from '@playwright/test';
import { createTable } from './helpers.js';

/**
 * A `.edb` whose name denies the workspace inside it.
 *
 * The report from the field: the folder holds `alpha.edb` and `beta.edb` and both
 * hold the workspace `alpha`, and the UI gets confused. It does, and there is no
 * repair the app can pick on its own — see `db/edb/file-identity.ts` for the four
 * ways it goes wrong. So the sync asks: rename the workspace inside the file to
 * match the name, or leave the file out of the list.
 *
 * The second file is made by COPYING the first, which is exactly how the state
 * arises in life: a user duplicates a workspace file in a file manager, or a sync
 * tool leaves `alpha (1).edb` beside it.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `127-folder-sync-writes-out.spec.ts`.
 */

const FOLDER = 'identity-folder';

test.describe.configure({ timeout: 90_000 });

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

async function runCommand(page: Page, title: string): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(title);
  // By EXACT text: the palette also lists the footer buttons, and a substring
  // match on "Sync workspace folder" reaches the Sync button as well.
  await palette
    .locator('.item')
    .filter({ has: page.getByText(title, { exact: true }) })
    .first()
    .click();
}

async function folderHas(page: Page, file: string): Promise<boolean> {
  return page.evaluate(
    async ({ folder, name }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder);
        await dir.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    },
    { folder: FOLDER, name: file },
  );
}

/** Duplicate a file in the stub folder, bytes for bytes. */
async function copyInFolder(page: Page, from: string, to: string): Promise<void> {
  await page.evaluate(
    async ({ folder, src, dst }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const bytes = await (await (await dir.getFileHandle(src)).getFile()).arrayBuffer();
      const out = await (await dir.getFileHandle(dst, { create: true })).createWritable();
      await out.write(bytes);
      await out.close();
    },
    { folder: FOLDER, src: from, dst: to },
  );
}

/**
 * What the folder index says lives in each file.
 *
 * The index is what the workspace selector lists, so this is the list the user
 * sees — the thing the bug report was about.
 */
async function indexed(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('eda:folderIndex');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { workspaces?: { id: string; file: string }[] };
    return (parsed.workspaces ?? []).map((w) => `${w.file}:${w.id}`).sort();
  });
}

/** A folder holding `alpha.edb` and a byte-for-byte copy of it called `beta.edb`. */
async function twoFilesOneWorkspace(page: Page): Promise<void> {
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part' }]);
  await connect(page);
  await copyInFolder(page, 'alpha.edb', 'beta.edb');
}

/**
 * Connect the folder and wait for the connect to FINISH.
 *
 * Its report is the only signal that says so. Waiting for `alpha.edb` to exist is
 * not enough: the file appears the moment the write starts, and copying it then
 * produces a half-written second file — which the scan reports as holding no
 * workspace, not as a workspace in the wrong file.
 */
async function connect(page: Page): Promise<void> {
  await runCommand(page, 'Connect workspace folder…');
  await expect(page.locator('toast-host')).toContainText(/workspace\(s\) in \d+ file\(s\)/, { timeout: 30_000 });
  await expect.poll(() => folderHas(page, 'alpha.edb'), { timeout: 30_000 }).toBe(true);
}

test('the sync asks about a file whose name denies the workspace in it', async ({ page }) => {
  await twoFilesOneWorkspace(page);
  await runCommand(page, 'Sync workspace folder');

  const dialog = page.locator('host-dialogs');
  // The question names the file, the workspace it holds and the id its name asks
  // for — with the file's date, so "which of these is current" can be answered.
  await expect(dialog).toContainText(/beta\.edb holds the workspace "alpha"/, { timeout: 30_000 });
  await expect(dialog).toContainText(/beta\.edb: .*saved /);
});

test('renaming the workspace inside the file makes the pair agree', async ({ page }) => {
  await twoFilesOneWorkspace(page);
  await runCommand(page, 'Sync workspace folder');

  const dialog = page.locator('host-dialogs');
  await dialog.getByRole('button', { name: 'Rename it to "beta"', exact: true }).click({ timeout: 30_000 });

  // Two workspaces now, one per file, each in the file its name says. Before this
  // the list held `alpha` twice and both entries opened `alpha.edb`.
  await expect.poll(() => indexed(page), { timeout: 30_000 }).toEqual(['alpha.edb:alpha', 'beta.edb:beta']);
});

test('leaving the file out keeps it off the workspace list', async ({ page }) => {
  await twoFilesOneWorkspace(page);
  await runCommand(page, 'Sync workspace folder');

  const dialog = page.locator('host-dialogs');
  await dialog.getByRole('button', { name: 'Leave it out', exact: true }).click({ timeout: 30_000 });

  // Left out, not deleted: the file is still on disk, untouched.
  await expect.poll(() => indexed(page), { timeout: 30_000 }).toEqual(['alpha.edb:alpha']);
  expect(await folderHas(page, 'beta.edb')).toBe(true);
});

test('Open refuses such a file instead of making an empty workspace in it', async ({ page }) => {
  // The same bug through a different door. Open reads the workspace out of the file
  // NAME, so `beta.edb` used to open, find no `beta`, and create an empty one
  // inside the file — two workspaces in one file, and the data out of sight.
  await twoFilesOneWorkspace(page);
  await runCommand(page, 'Open workspace file…');

  const dialog = page.locator('host-dialogs');
  await dialog.getByRole('button', { name: 'beta.edb', exact: true }).click({ timeout: 30_000 });

  await expect(dialog).toContainText(/"beta\.edb" holds the workspace "alpha", not "beta"/, { timeout: 20_000 });
});
