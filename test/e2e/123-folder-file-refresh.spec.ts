import { expect, test, type Page } from '@playwright/test';
import { createTable, waitForPanel } from './helpers.js';

/**
 * A `.edb` in the workspace folder has more than one writer, and a sync has to
 * notice.
 *
 * The case that matters is three tabs on three ORIGINS — `localhost:5190` and
 * `:5191` are different origins — sharing one folder. Everything except the folder
 * is origin-scoped: the OPFS pool holding the imported copy, the IndexedDB handle
 * store, the folder index. So each tab holds its own copy of the same file, and
 * nothing tells it when another tab saved.
 *
 * Playwright cannot give one test two origins with a shared folder, so the other
 * origin is played by a throwaway worker writing the same file — which is what
 * arrives at this tab either way: a file whose bytes changed under it.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `100-edb-browser.spec.ts`: the OS dialog cannot be driven, but what it returns
 * is an ordinary `FileSystemDirectoryHandle`.
 */

const ACTIVE_KEY = 'easydb:edb:active';
const FOLDER = 'shared-folder';

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

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

function saveButton(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

async function runFileCommand(page: Page, title: string): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(title);
  await palette
    .locator('.item')
    .filter({ has: page.getByText(title, { exact: true }) })
    .first()
    .click();
}

/**
 * The first Save of a workspace that has never had a file: it asks where the
 * workspace should live, and the dialog's own button is the gesture the folder
 * picker needs. Everything after that Save goes straight into the folder.
 */
async function saveIntoNewFolder(page: Page, file: string): Promise<void> {
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect.poll(() => folderHas(page, file), { timeout: 20_000, message: `${file} never appeared in the folder` }).toBe(true);
}

/**
 * Wait until this tab's copy and the file agree, saving again if they do not.
 *
 * A panel's geometry is written to the database on a debounce, so a Save taken the
 * moment a window appears is often followed by one more write — which leaves the
 * copy legitimately ahead of the file for a second or two. The scenario under test
 * starts from "nothing outstanding here", so it waits for that.
 */
async function settleClean(page: Page, file: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const s = await stamp(page, file);
    if (s && s.dirty !== true) return;
    await saveButton(page).click();
    // A Save that has to re-point at a name already in the folder confirms first
    // — which it does when the tab adopted the file rather than saving it here.
    const replace = page.locator('host-dialogs').getByRole('button', { name: 'Yes', exact: true });
    await replace.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
    if (await replace.isVisible().catch(() => false)) await replace.click();
    await expect(page.locator('toast-host')).toContainText(/Workspace saved/i, { timeout: 20_000 });
    await page.waitForTimeout(1_500);
  }
  throw new Error(`${file} never settled: this tab keeps writing`);
}

/** Is the file in the stub folder yet? */
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

/**
 * The table names this tab can see, straight from the store.
 *
 * Empty rather than thrown while the app is not there: every assertion below is
 * polled across a reload, and a page mid-navigation has no `__easydb` at all.
 */
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

/** The stamp this browser holds for a file — what says "we and the file agree". */
async function stamp(page: Page, file: string): Promise<{ mtime: number; size: number; dirty?: boolean } | null> {
  return page.evaluate((f) => {
    const raw = localStorage.getItem('eda:fileStamps');
    return raw ? ((JSON.parse(raw) as Record<string, { mtime: number; size: number; dirty?: boolean }>)[f] ?? null) : null;
  }, file);
}

/**
 * Another writer saves a table into the file — the other origin's Save.
 *
 * The file's own bytes go into a throwaway worker on the MEMORY substrate (the
 * pool is exclusive origin-wide and the live session holds it), a table is added
 * to the workspace already in there, and the result is written back.
 */
async function otherOriginAddsTable(page: Page, workspaceId: string, file: string, tableName: string): Promise<void> {
  await page.evaluate(
    async ({ ws, folder, fileName, table }) => {
      const { createEdbBridge } = await import('/src/db/edb/worker-bridge.ts');
      const { createIpcDataStore } = await import('/src/db/data-store-bridge.ts');
      const { fileInFolder, readBytes, writeBytes } = await import('/src/db/edb/file-handle.ts');
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder, { create: true });
      const handle = await fileInFolder(dir, fileName, false);
      if (!handle) throw new Error(`${fileName} is not in the folder`);
      const scratch = createEdbBridge();
      try {
        await scratch.open(await readBytes(handle), '__other-origin.edb');
        const store = createIpcDataStore(scratch, () => ws);
        await store.tables.insert({ id: `${ws}-${table}`, workspaceId: ws, name: table, code: '', columns: [{ field: 'part', type: 'string' }], view: 'table' });
        await writeBytes(handle, await scratch.export());
      } finally {
        scratch.terminate();
      }
    },
    { ws: workspaceId, folder: FOLDER, fileName: file, table: tableName },
  );
}

/**
 * A `.edb` in the folder holding one workspace with one table, built by a
 * throwaway worker — a workspace that exists on disk and nowhere in this browser.
 */
async function fileHoldingWorkspace(page: Page, workspaceId: string, file: string, tableName: string): Promise<void> {
  await page.evaluate(
    async ({ ws, folder, fileName, table }) => {
      const { createEdbBridge } = await import('/src/db/edb/worker-bridge.ts');
      const { createIpcDataStore } = await import('/src/db/data-store-bridge.ts');
      const { fileInFolder, writeBytes } = await import('/src/db/edb/file-handle.ts');
      const scratch = createEdbBridge();
      try {
        await scratch.open(null, '__fixture.edb');
        const store = createIpcDataStore(scratch, () => ws);
        await store.workspaces.insert({ id: ws, name: ws, createdAt: Date.now(), pluginUrls: [] });
        await store.tables.insert({ id: `${ws}-${table}`, workspaceId: ws, name: table, code: '', columns: [{ field: 'part', type: 'string' }], view: 'table' });
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder, { create: true });
        const handle = await fileInFolder(dir, fileName, true);
        await writeBytes(handle!, await scratch.export());
      } finally {
        scratch.terminate();
      }
    },
    { ws: workspaceId, folder: FOLDER, fileName: file, table: tableName },
  );
}

test.describe('a file written by another origin', () => {
  test('Sync re-reads this tab own file and shows what the other one saved', async ({ page }, testInfo) => {
    const ws = `shared-${testInfo.testId}`.toLowerCase();
    const file = `${ws}.edb`;
    // A save, an outside write and a reload, each with a worker of its own — well
    // past the 30s a spec gets by default.
    test.setTimeout(180_000);
    await boot(page, ws);

    // This tab's own work, saved into the folder — which is what makes the file
    // and this copy agree, and records the stamp the comparison needs.
    const mine = await createTable(page, 'mine', [{ field: 'part', type: 'string' }]);
    await waitForPanel(page, mine);
    await saveIntoNewFolder(page, file);
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(file);
    await settleClean(page, file);
    const before = await stamp(page, file);
    expect(before).not.toBeNull();

    // The other origin saves a table of its own into the same file.
    await otherOriginAddsTable(page, ws, file, 'theirs');
    // Still invisible here: nothing reads the file on its own.
    expect(await tableNames(page)).toEqual(['mine']);

    await runFileCommand(page, 'Sync workspace folder');

    // The sync finds the file newer than this copy and reloads onto it. Polled
    // rather than waited on: the reload happens inside the sync, so there is no
    // moment to hold on to between the click and the new page.
    await expect.poll(() => tableNames(page), { timeout: 60_000 }).toEqual(['mine', 'theirs']);
    await ready(page);

    // And the stamp moved on with it, so a second sync has nothing left to do.
    const after = await stamp(page, file);
    expect(after).not.toEqual(before);
    await runFileCommand(page, 'Sync workspace folder');
    await expect(page.locator('toast-host')).toContainText(/workspace\(s\) in/i, { timeout: 20_000 });
    expect(await tableNames(page)).toEqual(['mine', 'theirs']);
  });

  /**
   * The other half: switching INTO a workspace whose file has moved on.
   *
   * A `?space=` switch used to prefer this browser's own copy over the file every
   * time, to protect work that was never saved back. That rule is what kept two
   * origins apart for good — each re-opened its own stale import. It now yields
   * when the file has been written since the copy was made AND the copy holds
   * nothing unsaved, which is exactly the case where nothing can be lost.
   */
  test('a switch back into the workspace reads the file, not the stale local copy', async ({ page }, testInfo) => {
    const ws = `switch-${testInfo.testId}`.toLowerCase();
    const file = `${ws}.edb`;
    test.setTimeout(180_000);
    // This tab lives in a workspace of its own, so the one under test is never in
    // the open database — the state a `?space=` link arrives in.
    await boot(page, `home-${testInfo.testId}`.toLowerCase());

    // The workspace exists only as a file, as it would on a second machine.
    await fileHoldingWorkspace(page, ws, file, 'mine');

    // Connect the folder, which is what a `?space=` boot needs: it can only look
    // in a folder the user has already granted (see `space-adopt.ts`).
    await runFileCommand(page, 'Connect workspace folder…');
    await expect(page.locator('toast-host')).toContainText(/workspace\(s\) in/i, { timeout: 20_000 });

    // First visit: nothing local, so the file is imported and this tab switches
    // to it. That import is what leaves a copy in the pool AND a stamp.
    await page.goto(`/?test=1&space=${encodeURIComponent(ws)}`);
    await expect.poll(() => tableNames(page), { timeout: 60_000 }).toEqual(['mine']);
    await ready(page);
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(file);
    // Opening a workspace writes to it — the view templates this fixture file was
    // built without — so the copy is briefly ahead of the file. Nothing outstanding
    // is the premise of this scenario, so settle it first.
    await settleClean(page, file);

    // Back to this browser's own database, which has never heard of `ws`.
    await runFileCommand(page, 'Back to browser storage');
    await page.locator('host-dialogs').getByRole('button', { name: 'Yes', exact: true }).click();
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY), { timeout: 60_000 }).toBeNull();
    await ready(page);

    await otherOriginAddsTable(page, ws, file, 'theirs');

    // The link that used to land on the stale copy in the pool.
    await page.goto(`/?test=1&space=${encodeURIComponent(ws)}`);
    await expect.poll(() => tableNames(page), { timeout: 60_000 }).toEqual(['mine', 'theirs']);
    await ready(page);
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(file);
  });

  test('unsaved work here is not thrown away — the sync asks first', async ({ page }, testInfo) => {
    const ws = `clash-${testInfo.testId}`.toLowerCase();
    const file = `${ws}.edb`;
    // A save, an outside write and a reload, each with a worker of its own — well
    // past the 30s a spec gets by default.
    test.setTimeout(180_000);
    await boot(page, ws);

    const mine = await createTable(page, 'mine', [{ field: 'part', type: 'string' }]);
    await waitForPanel(page, mine);
    await saveIntoNewFolder(page, file);

    await otherOriginAddsTable(page, ws, file, 'theirs');

    // Local work AFTER the last save: the file and this copy have both moved on.
    const extra = await createTable(page, 'unsaved', [{ field: 'part', type: 'string' }]);
    await waitForPanel(page, extra);
    await expect.poll(() => stamp(page, file).then((s) => s?.dirty === true), { timeout: 20_000 }).toBe(true);

    await runFileCommand(page, 'Sync workspace folder');

    // A question, not a decision.
    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(new RegExp(`${file} has been written since this tab read it`, 'i'))).toBeVisible({ timeout: 20_000 });
    // Both copies are described. Neither answer can be reasoned about from a name
    // alone — both copies have the same one — so the prompt says what each holds,
    // and for the file how big it is and when it was written.
    await expect(dialog.getByText(/Here: \d+ workspace/)).toBeVisible();
    await expect(dialog.getByText(new RegExp(`${file}: .*\\d+ KB, saved `))).toBeVisible();
    await dialog.getByRole('button', { name: 'Load disk version', exact: true }).click();

    // Answered with Load, so the file wins — including the table the other origin
    // saved, and without the local one that was never written.
    await expect.poll(() => tableNames(page), { timeout: 60_000 }).toEqual(['mine', 'theirs']);
    await ready(page);
  });
});
