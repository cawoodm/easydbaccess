import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { createTable } from './helpers.js';

/**
 * A `.edb` in the workspace folder holds ONE workspace: the one its name says.
 *
 * The whole file layer turns on that convention. Save names the file after the
 * workspace (`spaceFileName`), Open reads the workspace back OUT of the name
 * (`workspaceIdFromFileName`), and the folder index maps one to the other. A file
 * holding somebody else's workspace as well breaks all three: the workspace list
 * shows two workspaces living in one file, a sync asks which copy of the passenger
 * is real, and a file handed to someone else carries workspaces its name denies.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `123-folder-file-refresh.spec.ts` — the OS dialog cannot be driven, but what it
 * returns is an ordinary `FileSystemDirectoryHandle`.
 */

const FOLDER = 'one-per-file';

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

/** A second workspace in the SAME database — what the project index normally holds. */
async function addWorkspace(page: Page, id: string): Promise<void> {
  await page.evaluate(async (wsId) => {
    const ctx = (window as unknown as { __easydb: { store: { workspaces: { upsert(doc: unknown): Promise<unknown> } } } }).__easydb;
    await ctx.store.workspaces.upsert({ id: wsId, name: wsId, createdAt: Date.now(), pluginUrls: [] });
  }, id);
}

/** The bytes of a file in the stub folder. */
async function fileBytes(page: Page, name: string): Promise<number[]> {
  return page.evaluate(
    async ({ folder, file }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const handle = await dir.getFileHandle(file);
      return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
    },
    { folder: FOLDER, file: name },
  );
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
    { folder: FOLDER, file: '', name: file },
  );
}

/** The workspace ids inside a `.edb`, read by Node's SQLite rather than the app's. */
function workspacesIn(bytes: number[], path: string): string[] {
  writeFileSync(path, Buffer.from(bytes));
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(`SELECT key FROM _easydb WHERE coll = 'workspaces' ORDER BY key`).all() as Array<{ key: string }>).map((r) => r.key);
  } finally {
    db.close();
  }
}

/** The key `db/edb/session.ts` reads at boot to decide this tab is file-backed. */
const ACTIVE_KEY = 'easydb:edb:active';

test('the database this browser owns is carried onto its new name', async ({ page }) => {
  // The upgrade path. Up to v0.0.427 this browser's own database — the one holding
  // every workspace not in a file of its own — was called `local.edb`, which made
  // "a `.edb` holds one workspace" false of the database the app writes most. It is
  // `index.edp` now, and a user whose workspaces are under the old name must not
  // lose them to the rename.
  //
  // The old state is set up through the ordinary adopted-file path: a tab pointed
  // at a database called `local.edb`, holding the workspace that name maps to.
  // The init script runs on EVERY navigation, so the marker is set only until the
  // sentinel says the old state is built — otherwise the second load would point
  // the tab back at `local.edb` and there would be no rename to observe.
  await page.addInitScript(
    ({ key, sentinel }) => {
      if (!localStorage.getItem(sentinel)) localStorage.setItem(key, 'local.edb');
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      delete (window as unknown as Record<string, unknown>)['showDirectoryPicker'];
    },
    { key: ACTIVE_KEY, sentinel: 'spec:seeded' },
  );
  await page.goto('/?test=1&space=local');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await createTable(page, 'Kept', [{ field: 'part', renderer: 'link' }]);

  // Now boot as a browser that has never adopted a file: `activeEdbName()` is the
  // index, and the rename runs before anything is opened.
  await page.evaluate((k) => {
    localStorage.setItem('spec:seeded', '1');
    localStorage.removeItem(k);
  }, ACTIVE_KEY);
  await page.goto('/?test=1&space=local');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  const found = await page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { store: { tables: { find(): Promise<Array<{ name: string }>> }; workspaces: { find(): Promise<Array<{ id: string }>> } } } }).__easydb;
    return {
      workspaces: (await ctx.store.workspaces.find()).map((w) => w.id),
      tables: (await ctx.store.tables.find()).map((t) => t.name),
    };
  });
  // The table proves it is the SAME database, not a fresh index that happens to
  // have a workspace of that name created in it by `?space=`.
  expect(found.tables).toContain('Kept');
  expect(found.workspaces).toContain('local');
  expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBeNull();
});

test('a URL naming a workspace nobody has does not create it inside the open file', async ({ page }) => {
  // The other way a `.edb` used to end up with two workspaces in it: not Save, but
  // `?space=`. The tab has `alpha.edb` open, the URL asks for `zz`, and the old
  // `isActive` short-circuit created `zz` in `alpha.edb` — a file named after one
  // workspace holding two.
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part', renderer: 'link' }]);
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText('Workspace saved to alpha.edb', { timeout: 30_000 });
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY), { timeout: 20_000 }).toBe('alpha.edb');

  await page.goto('/?test=1&space=zz');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  // It left the file for the project index rather than creating `zz` inside it.
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY), { timeout: 30_000 }).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { __easydb: { workspaceId: string } }).__easydb.workspaceId)).toBe('zz');
});

test('a workspace saved into the folder gets a file holding only itself', async ({ page }, testInfo) => {
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part', renderer: 'link' }]);
  await addWorkspace(page, 'beta');

  // The first Save of a workspace with no file asks where it should live; the
  // dialog's own button is the gesture the folder picker needs.
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  // The toast, not the file's existence: the handle is created before anything is
  // written to it, so a poll on the name reads an empty file.
  await expect(page.locator('toast-host')).toContainText('Workspace saved to alpha.edb', { timeout: 30_000 });

  expect(workspacesIn(await fileBytes(page, 'alpha.edb'), testInfo.outputPath('alpha.edb'))).toEqual(['alpha']);
});

test('the workspace left behind gets a file of its own rather than a seat in somebody elses', async ({ page }, testInfo) => {
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part', renderer: 'link' }]);
  await addWorkspace(page, 'beta');

  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();

  // `beta` was never saved and has no file. Stripping it out of `alpha.edb`
  // without giving it one would leave its only copy in this browser.
  await expect(page.locator('toast-host')).toContainText('beta.edb was given a file too', { timeout: 30_000 });
  expect(await folderHas(page, 'beta.edb')).toBe(true);
  expect(workspacesIn(await fileBytes(page, 'beta.edb'), testInfo.outputPath('beta.edb'))).toEqual(['beta']);
});
