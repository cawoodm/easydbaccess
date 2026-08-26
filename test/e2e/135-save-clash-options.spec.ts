import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTable } from './helpers.js';

/**
 * Save found a file already carrying this workspace: which copy wins?
 *
 * It used to be a yes/no — "Replace it with the workspace open here?" — and the
 * two answers were not the two outcomes. Yes overwrote the file. No did NOT keep
 * the file's copy; it abandoned the Save. So the answer a reader most likely
 * wanted, "the disk has the newer copy, take that", was not on offer at all,
 * while the question read as though it were.
 *
 * Both outcomes are named now, and each names the copy that SURVIVES rather than
 * what happens mechanically.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `126-one-workspace-per-file.spec.ts`.
 */

const FOLDER = 'save-clash';
/** The key `db/edb/session.ts` reads at boot to decide this tab is file-backed. */
const ACTIVE_KEY = 'easydb:edb:active';

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

/**
 * The table names inside a `.edb` in the stub folder, read by Node's own SQLite
 * rather than by the app.
 *
 * Reading the file directly is what makes "which copy won" answerable: asking the
 * app would only report the database it happens to have open, which is the very
 * thing under test. Same approach as `126-one-workspace-per-file.spec.ts`.
 */
async function tablesInFile(page: Page, name: string): Promise<string[]> {
  const bytes = await page.evaluate(
    async ({ folder, file }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const handle = await dir.getFileHandle(file);
      return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
    },
    { folder: FOLDER, file: name },
  );
  const path = join(tmpdir(), `easydb-${name}-${bytes.length}.edb`);
  writeFileSync(path, Buffer.from(bytes));
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("SELECT json_extract(doc, \'$.name\') AS name FROM _easydb WHERE coll = \'tables\' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    db.close();
  }
}

const saveButton = (page: Page) => page.locator('app-shell').getByRole('button', { name: /Save/ });
const dialog = (page: Page) => page.locator('host-dialogs');

const tableNames = (page: Page) =>
  page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { store: { tables: { find(): Promise<Array<{ name: string }>> } } } }).__easydb;
    return (await ctx.store.tables.find()).map((t) => t.name);
  });

/**
 * `tableNames` across a page RELOAD.
 *
 * Adopting a file reloads the tab — that is how the app switches which database
 * it is looking at — so a plain evaluate lands either on a destroyed execution
 * context or on a boot that has not published `__easydb` yet. Both are "not
 * there yet", not failures, so they poll again.
 */
async function tableNamesAfterReload(page: Page): Promise<string[] | null> {
  try {
    return await page.evaluate(async () => {
      const ctx = (window as unknown as { __easydb?: { store: { tables: { find(): Promise<Array<{ name: string }>> } } } }).__easydb;
      if (!ctx) return null;
      return (await ctx.store.tables.find()).map((t) => t.name);
    });
  } catch {
    return null;
  }
}

/** Remove a table from the browser's own database, by name. */
async function dropTable(page: Page, name: string): Promise<void> {
  await page.evaluate(async (n) => {
    const ctx = (window as unknown as { __easydb: { store: { tables: { find(): Promise<Array<{ id: string; name: string }>>; remove(id: string): Promise<unknown> } } } }).__easydb;
    for (const t of await ctx.store.tables.find()) if (t.name === n) await ctx.store.tables.remove(t.id);
  }, name);
}

/**
 * The state the report is about, with the two copies made to DIFFER.
 *
 * Save the workspace into the folder, then drop the marker that says this tab is
 * file-backed and reload: the tab goes back to the browser's own database, which
 * still holds its own copy of the workspace, while the folder grant survives.
 *
 * The two copies are identical at that point, which is no use for telling which
 * one an answer kept — so the browser's copy is emptied here, and each test then
 * gives it `FromBrowser` while the file keeps `FromDisk`. Every assertion below
 * turns on which of the two names survives.
 */
async function twoDifferingCopies(page: Page, space: string): Promise<void> {
  await boot(page, space);
  await createTable(page, 'FromDisk', [{ field: 'part', renderer: 'link' }]);
  await saveButton(page).click();
  await expect(dialog(page).getByText(/stored in this browser/)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText(`${space}.edb`, { timeout: 30_000 });

  await page.evaluate((k) => localStorage.removeItem(k), ACTIVE_KEY);
  await boot(page, space);
  await dropTable(page, 'FromDisk');
  await expect.poll(() => tableNames(page)).toEqual([]);
}

test('the clash offers two named copies, not a yes/no about replacing', async ({ page }) => {
  await twoDifferingCopies(page, 'clash');
  await createTable(page, 'FromBrowser', [{ field: 'x', renderer: 'link' }]);

  await saveButton(page).click();

  // Each button names a copy. The old wording asked "Replace it…?" and left the
  // reader to work out which side "it" was.
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeVisible({ timeout: 20_000 });
  await expect(dialog(page).getByRole('button', { name: 'Use disk version', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Use local version', exact: true })).toBeVisible();
});

test('the question shows both sides, so the answer can be reasoned about', async ({ page }) => {
  await twoDifferingCopies(page, 'sides');
  await createTable(page, 'FromBrowser', [{ field: 'x', renderer: 'link' }]);

  await saveButton(page).click();
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeVisible({ timeout: 20_000 });
  // The file's own line names it; the browser's line says where it is. Without
  // these the two copies are indistinguishable — they share the only other thing
  // a reader was given, the name.
  await expect(dialog(page)).toContainText('In this browser');
  await expect(dialog(page)).toContainText('sides.edb');
});

test('Use local version writes the browser copy over the file', async ({ page }) => {
  await twoDifferingCopies(page, 'local-wins');
  await createTable(page, 'FromBrowser', [{ field: 'x', renderer: 'link' }]);

  await saveButton(page).click();
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeVisible({ timeout: 20_000 });
  await dialog(page).getByRole('button', { name: 'Use local version', exact: true }).click();

  await expect(page.locator('toast-host')).toContainText('local-wins.edb', { timeout: 30_000 });
  // The browser's copy is what is open, and it is now what the file holds too —
  // `FromDisk`, which only the file had, is gone from both.
  await expect.poll(() => tableNames(page)).toEqual(['FromBrowser']);
  await expect.poll(() => tablesInFile(page, 'local-wins.edb'), { timeout: 20_000 }).toEqual(['FromBrowser']);
});

test('Use disk version takes the file, and the file’s tables come back', async ({ page }) => {
  await twoDifferingCopies(page, 'disk-wins');
  await createTable(page, 'FromBrowser', [{ field: 'x', renderer: 'link' }]);

  await saveButton(page).click();
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeVisible({ timeout: 20_000 });
  await dialog(page).getByRole('button', { name: 'Use disk version', exact: true }).click();

  // This is the answer the old dialog could not express at all: No abandoned the
  // Save and left the browser copy in front of the user.
  await expect.poll(() => tableNamesAfterReload(page), { timeout: 30_000 }).toEqual(['FromDisk']);
});

test('dismissing touches neither copy', async ({ page }) => {
  await twoDifferingCopies(page, 'neither');
  await createTable(page, 'FromBrowser', [{ field: 'x', renderer: 'link' }]);

  await saveButton(page).click();
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // What the old "No" actually did, and the only answer that writes nothing.
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeHidden();
  await expect.poll(() => tableNames(page)).toEqual(['FromBrowser']);
  expect(await tablesInFile(page, 'neither.edb')).toEqual(['FromDisk']);
});

test('keeping an empty copy over one holding tables asks a second time', async ({ page }) => {
  // The guard the folder sync already applies, now behind this question too: the
  // choice is about which copy is current, and this is the one answer that is
  // almost certainly a mistake.
  await twoDifferingCopies(page, 'empty-local');
  // No `FromBrowser` here — the browser's copy is left empty, and the file holds
  // a table. Keeping the empty one is the mistake the guard exists for.

  await saveButton(page).click();
  await expect(dialog(page).getByText(/which one do you want to keep/i)).toBeVisible({ timeout: 20_000 });
  await dialog(page).getByRole('button', { name: 'Use local version', exact: true }).click();

  await expect(dialog(page).getByText(/The copy you are keeping .* is empty/)).toBeVisible();
});
