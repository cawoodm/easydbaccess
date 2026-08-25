import { expect, test, type Page } from '@playwright/test';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Connecting a folder synchronises BOTH ways.
 *
 * Reading the folder was the whole of a sync until v0.0.428: every `.edb` was
 * scanned and its workspaces listed, and nothing was ever written. So a browser
 * holding three workspaces and a folder holding none stayed that way, and the
 * user was told the sync had found "0 workspaces in 0 files" — correct, and not
 * what "sync this folder" means.
 *
 * Now every workspace that holds something gets a file. Empty ones do not:
 * `?space=x` creates a shell before any folder is connected, and a folder of
 * empty files is litter rather than a sync.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `126-one-workspace-per-file.spec.ts` — the OS dialog cannot be driven, but what
 * it returns is an ordinary `FileSystemDirectoryHandle`.
 */

const FOLDER = 'sync-writes-out';

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

/** A second workspace in the SAME database — what `local.edb` normally holds. */
async function addWorkspace(page: Page, id: string, withTable: boolean): Promise<void> {
  await page.evaluate(
    async ({ wsId, table }) => {
      const ctx = (
        window as unknown as {
          __easydb: { store: { workspaces: { upsert(doc: unknown): Promise<unknown> }; tables: { upsert(doc: unknown): Promise<unknown> } } };
        }
      ).__easydb;
      await ctx.store.workspaces.upsert({ id: wsId, name: wsId, createdAt: Date.now(), pluginUrls: [] });
      // A workspace is "empty" by tables and views, so one table is what makes it
      // worth a file — see `isEmptyWorkspace`.
      if (table) await ctx.store.tables.upsert({ id: `${wsId}-t`, workspaceId: wsId, name: 'Things', columns: [{ field: 'a' }], createdAt: Date.now(), updatedAt: Date.now() });
    },
    { wsId: id, table: withTable },
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
    { folder: FOLDER, name: file },
  );
}

/** Run the palette command that connects a folder — the picker is stubbed. */
async function connectFolder(page: Page): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('workspace folder');
  await palette.locator('.item', { hasText: /Connect workspace folder/ }).first().click();
}

test('a sync writes out every workspace the folder does not hold', async ({ page }) => {
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part' }]);
  await addWorkspace(page, 'beta', true);

  await connectFolder(page);

  // The open workspace and the passenger both land, each in its own file.
  await expect.poll(() => folderHas(page, 'alpha.edb'), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => folderHas(page, 'beta.edb'), { timeout: 30_000 }).toBe(true);
});

test('an empty workspace is not given a file', async ({ page }) => {
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part' }]);
  // `gamma` is the shell `?space=gamma` would create: a workspace record and
  // nothing else.
  await addWorkspace(page, 'gamma', false);

  await connectFolder(page);

  await expect.poll(() => folderHas(page, 'alpha.edb'), { timeout: 30_000 }).toBe(true);
  expect(await folderHas(page, 'gamma.edb')).toBe(false);
});

test('the tables are still there after the folder is connected', async ({ page }) => {
  // The report from the field: connect a folder and the tables vanish from the
  // UI, while the file in the folder still holds them. Writing the workspace out
  // must not disturb the database this tab is looking at.
  await boot(page, 'kanban');
  const id = await createTable(page, 'tasks', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await connectFolder(page);
  await expect.poll(() => folderHas(page, 'kanban.edb'), { timeout: 30_000 }).toBe(true);

  // The store still holds the table, and its window is still on screen. Asserted
  // in that order: a table the store has lost is data gone, a window that closed
  // over a table still there is only a missing window.
  const tables = await page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { store: { tables: { find(): Promise<Array<{ name: string; workspaceId: string }>> } }; workspaceId: string } }).__easydb;
    return (await ctx.store.tables.find()).map((t) => `${t.workspaceId}/${t.name}`);
  });
  expect(tables).toContain('kanban/tasks');
  await expect(page.locator(`#${panelDomId(id)} data-table`)).toBeVisible({ timeout: 20_000 });
});
