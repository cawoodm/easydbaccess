import { expect, test, type Page } from '@playwright/test';

/**
 * Opening a workspace that exists in TWO places asks which copy to open.
 *
 * The bug this covers lost a 7 MB workspace behind an empty screen. Boot reads
 * the OPFS pool, never the user's file (`db/edb/session.ts`), and `decideSpace`
 * preferred whatever copy the browser held — the only thing that could beat it
 * was a file stamp, and a stamp exists only on the origin that imported or wrote
 * the file. So on any NEW origin (a branch port, the Docker build, another
 * profile, another machine) the verdict was `unknown` and the browser's copy won
 * in silence. Where that copy was the empty database a boot creates for a name
 * the pool does not hold, the workspace came up with no tables.
 *
 * The state is built exactly as it arises: an empty database under the
 * workspace's file name in the POOL, the real workspace in a file of that name in
 * the folder, and no stamp between them.
 *
 * The folder is OPFS, which hands over a genuine `FileSystemDirectoryHandle` with
 * no OS dialog — the same trick `100-edb-browser.spec.ts` uses. Only the act of
 * CHOOSING a folder is undriveable; everything the app does with one is not.
 */

const ACTIVE_KEY = 'easydb:edb:active';
const FOLDER = 'which-copy-folder';

/** The app's own dialog host — the question and its confirm both land here. */
const dialogs = (page: Page) => page.locator('host-dialogs');

/** A tab with a granted workspace folder and no file adopted. */
async function bootWithFolder(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ folder }) => {
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
 * Put the workspace in a file, and an EMPTY database of the same name in the pool.
 *
 * Both halves go through the app's own modules. The file is built in a throwaway
 * worker; the pool copy goes in through the LIVE worker's `importBytes`, because
 * the pool is exclusive origin-wide and a second worker's copy would land where
 * no boot looks.
 */
async function seedBothCopies(page: Page, ws: string): Promise<void> {
  await page.evaluate(
    async ({ ws, folder }) => {
      const { createEdbBridge } = await import('/src/db/edb/worker-bridge.ts');
      const { createIpcDataStore } = await import('/src/db/data-store-bridge.ts');
      const { fileInFolder, writeBytes, rememberFolder } = await import('/src/db/edb/file-handle.ts');
      const { edbBridge } = await import('/src/db/edb/active-bridge.ts');

      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder, { create: true });
      await rememberFolder(dir);

      // The real workspace, with a table in it, written into the folder.
      const full = createEdbBridge();
      try {
        await full.open(null, 'which-copy-fixture.edb', { scratch: true });
        const store = createIpcDataStore(full, () => ws);
        await store.workspaces.insert({ id: ws, name: ws, createdAt: Date.now(), pluginUrls: [] });
        await store.tables.insert({ id: `${ws}-t`, workspaceId: ws, name: 'fromfile', code: '', columns: [{ field: 'part', type: 'string' }], view: 'table' });
        const handle = await fileInFolder(dir, `${ws}.edb`, true);
        await writeBytes(handle!, await full.export());
      } finally {
        full.terminate();
      }

      // An EMPTY database under the same name, in the pool. This is what a boot
      // leaves behind when the marker names a file whose bytes were never placed,
      // and it is the copy that used to win.
      const blank = createEdbBridge();
      let bytes: Uint8Array;
      try {
        await blank.open(null, 'which-copy-blank.edb', { scratch: true });
        bytes = await blank.export();
      } finally {
        blank.terminate();
      }
      await edbBridge()!.importBytes(`${ws}.edb`, bytes);
    },
    { ws, folder: FOLDER },
  );
}

/** Ask for the workspace from the project index, which is where boot decides. */
async function reopen(page: Page, ws: string): Promise<void> {
  await page.evaluate((key) => localStorage.removeItem(key), ACTIVE_KEY);
  await page.goto(`/?test=1&space=${encodeURIComponent(ws)}`);
}

/**
 * The tables on screen, safe to POLL across a reload.
 *
 * Answering "open the copy in the file" imports those bytes over the database
 * this tab has open, which closes the worker's store on the way to the reload
 * (`worker.ts`'s `importBytes`) — so a read taken in that window rejects. An
 * empty answer keeps the poll going until the new page is up; a wrong one still
 * fails, on the timeout.
 */
async function tableNames(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(async () => {
      const app = (window as unknown as { __easydb?: { store: { tables: { find(): Promise<{ name: string }[]> } } } }).__easydb;
      if (!app) return [];
      return (await app.store.tables.find()).map((t) => t.name);
    });
  } catch {
    return [];
  }
}

test('asks which copy to open, and says what each one holds', async ({ page }, testInfo) => {
  const ws = `twocopies-${testInfo.testId}`.toLowerCase();
  await bootWithFolder(page, `elsewhere-${testInfo.testId}`.toLowerCase());
  await seedBothCopies(page, ws);
  await reopen(page, ws);

  const dialog = dialogs(page);
  await expect(dialog.getByText('cannot tell which is newer')).toBeVisible({ timeout: 20_000 });
  // Both sides, counted. The question used to be asked on a name alone — and both
  // copies have the same name, so the answer was a guess.
  await expect(dialog.getByText('In this browser: 0 tables')).toBeVisible();
  await expect(dialog.getByText(`${ws}.edb: 1 table`)).toBeVisible();

  for (const label of ['Open the copy in the file', 'Keep the copy in this browser', 'Compare them…']) {
    await expect(dialog.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
});

test('opening the copy in the file brings its tables in', async ({ page }, testInfo) => {
  const ws = `takefile-${testInfo.testId}`.toLowerCase();
  await bootWithFolder(page, `elsewhere-${testInfo.testId}`.toLowerCase());
  await seedBothCopies(page, ws);
  await reopen(page, ws);

  const dialog = dialogs(page);
  await dialog.getByRole('button', { name: 'Open the copy in the file', exact: true }).click({ timeout: 20_000 });

  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await expect.poll(() => tableNames(page), { timeout: 20_000 }).toEqual(['fromfile']);
  expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(`${ws}.edb`);
});

test('keeping the empty copy is confirmed before anything is lost', async ({ page }, testInfo) => {
  const ws = `keepempty-${testInfo.testId}`.toLowerCase();
  await bootWithFolder(page, `elsewhere-${testInfo.testId}`.toLowerCase());
  await seedBothCopies(page, ws);
  await reopen(page, ws);

  const dialog = dialogs(page);
  await dialog.getByRole('button', { name: 'Keep the copy in this browser', exact: true }).click({ timeout: 20_000 });

  // Keeping nothing over a table is almost certainly a slip, and the three
  // buttons cannot carry that warning themselves.
  await expect(dialog.getByText('is empty, and the copy in')).toBeVisible();
  await expect(dialog.getByText('holds 1 table')).toBeVisible();
});
