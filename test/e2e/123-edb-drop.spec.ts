import { test, expect, type Page } from './fixtures.js';

/**
 * TODO § Quick Wins
 * - Dropping a `.edb` file brings its workspace in: a new one when the name is
 *   unknown here, otherwise a choice between replacing what is here and keeping
 *   both.
 *
 * A drop is NOT an Open. Opening repoints the tab at the user's file and saves
 * into it from then on; dropping a file somebody sent you must not do that. So the
 * file is read, its workspace is copied into this browser's own database, and the
 * file itself is left exactly as it was.
 *
 * Which workspace, out of a file that could hold several: the one the FILE NAME
 * names (`northwind.edb` → `northwind`), which is the convention Save and Open
 * already share.
 */

/** Build a real `.edb` in the page: one workspace, one table, two rows. */
async function edbBytes(page: Page, workspaceId: string, tableName: string): Promise<string> {
  return page.evaluate(
    async ({ ws, tableName }) => {
      const { createEdbBridge } = (await import('/src/db/edb/worker-bridge.ts')) as {
        createEdbBridge: () => {
          open(b: Uint8Array | null, n: string): Promise<unknown>;
          export(): Promise<Uint8Array>;
          terminate(): void;
        };
      };
      const { createIpcDataStore } = (await import('/src/db/data-store-bridge.ts')) as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createIpcDataStore: (b: unknown, ws: () => string) => any;
      };
      const scratch = createEdbBridge();
      try {
        await scratch.open(null, `source-${ws}.edb`);
        const store = createIpcDataStore(scratch, () => ws);
        await store.workspaces.insert({ id: ws, name: ws, createdAt: Date.now(), pluginUrls: [] });
        const tableId = `${ws}-t`;
        await store.tables.insert({
          id: tableId,
          workspaceId: ws,
          name: tableName,
          code: tableName.toLowerCase(),
          columns: [{ field: 'city', type: 'string' }],
          view: 'table',
        });
        await store.rows(tableId).bulkInsert([
          { id: crypto.randomUUID(), tableId, data: { city: 'Zug' }, updatedAt: Date.now() },
          { id: crypto.randomUUID(), tableId, data: { city: 'Chur' }, updatedAt: Date.now() },
        ]);
        const bytes = await scratch.export();
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
      } finally {
        scratch.terminate();
      }
    },
    { ws: workspaceId, tableName },
  );
}

/** Drop those bytes on the shell under `filename`. */
async function dropEdb(page: Page, filename: string, base64: string): Promise<void> {
  await page.evaluate(
    ({ filename, base64 }) => {
      const raw = atob(base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], filename, { type: 'application/x-sqlite3' }));
      const shell = document.querySelector('app-shell') ?? document.body;
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { filename, base64 },
  );
}

/** The workspace the tab is in, and the tables it can see. */
async function state(page: Page): Promise<{ workspaceId: string; tables: string[] }> {
  return page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { workspaceId: string; store: { tables: { find(): Promise<{ name: string; workspaceId: string }[]> } } } }).__easydb;
    const all = await ctx.store.tables.find();
    return { workspaceId: ctx.workspaceId, tables: all.filter((t) => t.workspaceId === ctx.workspaceId).map((t) => t.name) };
  });
}

/**
 * Mark this page, so the reload that follows a drop is detectable.
 *
 * Waiting on the URL alone is not enough: replacing the workspace you are already
 * in reloads into the SAME `?space=`, so `waitForURL` matches the page being
 * replaced and the assertions read the old state. A flag on `window` is gone the
 * moment the document is.
 */
async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __beforeDrop?: boolean }).__beforeDrop = true;
  });
}

async function bootedAt(page: Page, space: string): Promise<void> {
  await page.waitForFunction(() => !(window as unknown as { __beforeDrop?: boolean }).__beforeDrop && Boolean((window as unknown as { __easydb?: unknown }).__easydb), undefined, { timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`space=${space}(&|$)`));
}

test('an unknown file name arrives as a new workspace', async ({ page }) => {
  const bytes = await edbBytes(page, 'northwind', 'Orders');
  await markPage(page);
  // No question asked: nothing here is called `northwind`. The drop copies the
  // workspace in and reloads into it, which is also what takes the toast away —
  // hence the assertions are about where the tab LANDED.
  await dropEdb(page, 'northwind.edb', bytes);
  await bootedAt(page, 'northwind');

  const after = await state(page);
  expect(after.workspaceId).toBe('northwind');
  expect(after.tables).toEqual(['Orders']);

  // The workspace list holds it, and the tab was NOT repointed at the file — a
  // drop reads the file and leaves it alone.
  expect(await page.evaluate((k) => localStorage.getItem(k), 'easydb:edb:active')).toBeNull();
});

test.describe('a file whose workspace is already here', () => {
  /** Land `northwind` here first, then drop a second copy of it. */
  async function firstCopy(page: Page): Promise<string> {
    const bytes = await edbBytes(page, 'northwind', 'Orders');
    await markPage(page);
    await dropEdb(page, 'northwind.edb', bytes);
    await bootedAt(page, 'northwind');
    return bytes;
  }

  test('keeping both puts the copy under a free name', async ({ page }) => {
    const bytes = await firstCopy(page);
    // A second drop of the same name, with a different table inside so the two are
    // tellable apart.
    const other = await edbBytes(page, 'northwind', 'Suppliers');
    await markPage(page);
    await dropEdb(page, 'northwind.edb', other);

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/already a workspace here/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep both, under a new name', exact: true }).click();

    await bootedAt(page, 'northwind-2');
    expect((await state(page)).tables).toEqual(['Suppliers']);

    // And the original is untouched.
    const original = await page.evaluate(async () => {
      const ctx = (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ name: string; workspaceId: string }[]> } } } }).__easydb;
      return (await ctx.store.tables.find()).filter((t) => t.workspaceId === 'northwind').map((t) => t.name);
    });
    expect(original).toEqual(['Orders']);
    expect(bytes.length).toBeGreaterThan(0);
  });

  test('replacing swaps what is here for what is in the file', async ({ page }) => {
    await firstCopy(page);
    const other = await edbBytes(page, 'northwind', 'Suppliers');
    await markPage(page);
    await dropEdb(page, 'northwind.edb', other);

    const dialog = page.locator('host-dialogs');
    await dialog.getByRole('button', { name: 'Replace the one here', exact: true }).click();

    await bootedAt(page, 'northwind');
    // The file's table, and ONLY it: the one that was here is gone.
    expect((await state(page)).tables).toEqual(['Suppliers']);
  });
});

test('a file with no workspace in it says so', async ({ page }) => {
  const notADatabase = await page.evaluate(() => btoa('this is not a database'));
  await dropEdb(page, 'broken.edb', notADatabase);
  await expect(page.locator('host-dialogs').getByText(/no easyDBAccess workspace in "broken.edb"/)).toBeVisible();
});
