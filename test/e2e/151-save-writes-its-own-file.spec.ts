import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { createTable } from './helpers.js';

/**
 * Save writes the file the tab is ON, and no other.
 *
 * Reported from the field, and it cost a workspace: Save said
 * _"Workspace saved to powerplants.edb"_ while the bytes went into `default.edb`.
 * The file the user was told about was never written, and the file that WAS
 * written already held a different workspace.
 *
 * Two records say which file a tab has, and neither knew about the other:
 *
 * - the **marker** (`easydb:edb:active` in `localStorage`) — per tab, and what the
 *   toast reads;
 * - the **handle** (`CURRENT` in the `easydb-edb-handles` IndexedDB) — ONE slot for the
 *   whole origin, overwritten by whichever file was opened last in any tab, and
 *   what `persist()` actually wrote to.
 *
 * Boot handed the slot straight to `setEdbHandle` with no check, so any tab that
 * opened a second file left every other tab saving into it. `ownFile()` compares
 * the names now and drops a handle that belongs to another file.
 *
 * The setup below is that state exactly: the marker says `alpha.edb`, the remembered
 * handle is `beta.edb`. `showDirectoryPicker` is stubbed with an OPFS directory, as
 * in `126-one-workspace-per-file.spec.ts`.
 */

const FOLDER = 'save-own-file';

async function boot(page: Page, space: string): Promise<void> {
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
  await page.goto(`/?test=1&space=${encodeURIComponent(space)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

function saveButton(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

/** Put a handle for `file` in the origin-wide slot boot reads. */
async function rememberHandleFor(page: Page, file: string): Promise<void> {
  await page.evaluate(
    async ({ folder, name }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder, { create: true });
      const handle = await dir.getFileHandle(name, { create: true });
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('easydb-edb-handles', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('handles');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('handles', 'readwrite');
          tx.objectStore('handles').put(handle, 'current');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    },
    { folder: FOLDER, name: file },
  );
}

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

/** The tables inside a `.edb`, read by Node's SQLite rather than the app's. */
function tablesIn(bytes: number[], path: string): string[] {
  if (bytes.length === 0) return [];
  writeFileSync(path, Buffer.from(bytes));
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(`SELECT doc FROM _easydb WHERE coll = 'tables'`).all() as Array<{ doc: string }>).map((r) => String((JSON.parse(r.doc) as { name: string }).name)).sort();
  } catch {
    return []; // not a `.edb` at all — an empty file the handle created
  } finally {
    db.close();
  }
}

async function saveIntoFolder(page: Page, file: string): Promise<void> {
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText(`Workspace saved to ${file}`, { timeout: 30_000 });
}

test('a handle left behind by another file does not take the save', async ({ page }, testInfo) => {
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part' }]);
  await saveIntoFolder(page, 'alpha.edb');

  // Another tab opened `beta.edb` and left its handle in the one slot there is.
  await rememberHandleFor(page, 'beta.edb');

  // Back on `alpha`, with a change to save.
  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await createTable(page, 'Widgets', [{ field: 'widget' }]);
  await saveButton(page).click();
  await expect(page.locator('toast-host')).toContainText('alpha.edb', { timeout: 30_000 });

  // The toast named `alpha.edb`, so `alpha.edb` is what must hold the work.
  expect(tablesIn(await fileBytes(page, 'alpha.edb'), testInfo.outputPath('alpha.edb'))).toEqual(['Parts', 'Widgets']);
  // And `beta.edb` — a file this tab was never on — is untouched.
  expect(tablesIn(await fileBytes(page, 'beta.edb'), testInfo.outputPath('beta.edb'))).toEqual([]);
});

test('a saved file holds the workspace’s tables, not just its name', async ({ page }, testInfo) => {
  // The coverage gap that let the bug through: `126-one-workspace-per-file` reads
  // the WORKSPACE list out of a saved `.edb` and never its tables, so a save that
  // wrote the right workspace record into the wrong file still passed.
  await boot(page, 'alpha');
  await createTable(page, 'Parts', [{ field: 'part' }]);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = (await ctx.store.tables.find())[0];
    await ctx.store.rows(t.id).insert({ id: crypto.randomUUID(), tableId: t.id, data: { part: 'bolt' }, updatedAt: Date.now() });
    // A passenger, so the save takes the filtered path rather than `export()`.
    await ctx.store.workspaces.upsert({ id: 'beta', createdAt: Date.now(), pluginUrls: [] });
  });
  await saveIntoFolder(page, 'alpha.edb');

  const path = testInfo.outputPath('alpha-tables.edb');
  expect(tablesIn(await fileBytes(page, 'alpha.edb'), path)).toEqual(['Parts']);
  const db = new DatabaseSync(path);
  try {
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM "Parts"`).get() as { n: number }).n)).toBe(1);
  } finally {
    db.close();
  }
});
