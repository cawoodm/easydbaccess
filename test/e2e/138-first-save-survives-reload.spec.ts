import { expect, test, type Page } from '@playwright/test';
import { createTable, waitForPanel } from './helpers.js';

/**
 * The first Save into a folder has to survive a refresh.
 *
 * The bug: press Save on a workspace that has no file, let it connect a folder and
 * write `alpha.edb`, then refresh — and the app comes up with no tables at all. The
 * work was never lost (the file on disk holds all of it, and Open or a drop brings
 * it back), but every cue said it was.
 *
 * The cause is one step missing from one route. That Save points the tab at
 * `alpha.edb` (`setActiveEdbName`) but only writes the USER's file. Boot reads the
 * OPFS pool and never the user's file — see `db/edb/session.ts` — so the next load
 * asked the pool for a database it had never heard of, the pool made it empty, and
 * boot then re-created the workspace record inside it. Every other adopt places the
 * bytes first (`adoptFolderFile`, `open`); this route did not.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `127-folder-sync-writes-out.spec.ts`.
 */

const FOLDER = 'first-save-survives';
const ACTIVE_KEY = 'easydb:edb:active';

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
  await ready(page);
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

function saveButton(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

/** Empty mid-navigation rather than throwing, so a poll can wait for a reload. */
async function tableNames(page: Page): Promise<string[]> {
  try {
    return (
      await page.evaluate(async () => {
        const app = (window as unknown as { __easydb?: { store: { tables: { find(): Promise<{ name: string }[]> } } } }).__easydb;
        if (!app) return [];
        return (await app.store.tables.find()).map((t) => t.name);
      })
    ).sort();
  } catch {
    return [];
  }
}

/** The first Save of a workspace with no file: it asks for a folder, then writes. */
async function firstSaveIntoAFolder(page: Page): Promise<void> {
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText(/Workspace saved to alpha\.edb/i, { timeout: 30_000 });
}

test('the tables are still there after a refresh', async ({ page }) => {
  await boot(page, 'alpha');
  const id = await createTable(page, 'mine', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await firstSaveIntoAFolder(page);

  await page.reload();
  await ready(page);

  // The whole bug in one line: this came back `[]`.
  await expect.poll(() => tableNames(page), { timeout: 30_000 }).toEqual(['mine']);
  // And the tab is looking at the file, not back at browser storage.
  expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe('alpha.edb');
  // The window is on screen too: a table the store has but the UI does not draw is
  // the same complaint from the user's side.
  await expect(page.locator('data-table').first()).toBeVisible({ timeout: 20_000 });
});

test('rows written before the save come back with it', async ({ page }) => {
  // A table with no rows would pass on the table doc alone. This proves the file's
  // real contents are what the next boot opens.
  await boot(page, 'alpha');
  const id = await createTable(page, 'mine', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ tableId }) => {
      const app = (window as unknown as { __easydb: { store: { rows(t: string): { insert(d: unknown): Promise<unknown> } } } }).__easydb;
      await app.store.rows(tableId).insert({ id: 'r1', tableId, data: { a: 'kept' }, updatedAt: Date.now() });
    },
    { tableId: id },
  );
  await firstSaveIntoAFolder(page);

  await page.reload();
  await ready(page);
  await expect.poll(() => tableNames(page), { timeout: 30_000 }).toEqual(['mine']);

  const values = await page.evaluate(async () => {
    const app = (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ id: string }[]> }; rows(t: string): { find(): Promise<{ data: Record<string, unknown> }[]> } } } }).__easydb;
    const tables = await app.store.tables.find();
    return (await app.store.rows(tables[0]!.id).find()).map((r) => String(r.data['a']));
  });
  expect(values).toEqual(['kept']);
});

test('a second workspace is not dragged into the file', async ({ page }) => {
  // The file holds one workspace (`one-per-file.ts`), and placing its bytes in the
  // pool must not undo that: the boot after the save opens the FILE, so a passenger
  // would show up as a second workspace in the list.
  await boot(page, 'alpha');
  const id = await createTable(page, 'mine', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await page.evaluate(async () => {
    const app = (window as unknown as { __easydb: { store: { workspaces: { upsert(d: unknown): Promise<unknown> } } } }).__easydb;
    await app.store.workspaces.upsert({ id: 'beta', name: 'beta', createdAt: Date.now(), pluginUrls: [] });
  });
  await firstSaveIntoAFolder(page);

  await page.reload();
  await ready(page);
  await expect.poll(() => tableNames(page), { timeout: 30_000 }).toEqual(['mine']);

  const workspaces = await page.evaluate(async () => {
    const app = (window as unknown as { __easydb: { store: { workspaces: { find(): Promise<{ id: string }[]> } } } }).__easydb;
    return (await app.store.workspaces.find()).map((w) => w.id).sort();
  });
  expect(workspaces).toEqual(['alpha']);
});
