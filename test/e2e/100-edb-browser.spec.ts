import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { addRow, createTable, waitForPanel } from './helpers.js';

/**
 * The browser's file-backed mode: a workspace kept in a real SQLite `.edb`.
 *
 * The OS file picker cannot be driven from Playwright, so this spec never opens
 * one. Two ways round it:
 *
 * 1. Most tests set the marker `localStorage` key the picker would have written,
 *    then exercise everything downstream — worker, store, OPFS pool, reload.
 * 2. One test REPLACES `showSaveFilePicker` with a stub that hands back a handle
 *    writing into a page global. Everything after the picker is the real path —
 *    the File menu, the "where does this go?" dialog, `ensureWritable`,
 *    `writeBytes`. Hiding the picker instead would test a browser that cannot
 *    save at all, which is its own test.
 *
 * One test opens the produced bytes in **Node's** SQLite. That is the point of
 * the feature, and the assertion goes nowhere near the app's own code.
 *
 * There is no mirror any more. The database is a file in the `opfs-sahpool`
 * VFS, so SQLite writes its pages there as it goes and every COMMIT is already
 * durable — nothing is serialised, debounced or flushed on the way to storage.
 * That is why a reload needs no waiting here, and why the pool's files are
 * opaque: they are a slab the VFS manages, not a `.edb` sitting in OPFS under a
 * readable name. The way OUT of the pool is `export`, which is what the File
 * menu's Save does — so the "these bytes are a real database" test now goes
 * through the menu instead of reading a mirror file.
 */

/** The key `db/edb/session.ts` reads at boot to decide this tab is file-backed. */
const ACTIVE_KEY = 'easydb:edb:active';

/**
 * Row data in a fixed order, for comparing.
 *
 * `DataCollection.find()` promises no order. SQLite happens to scan a table in
 * insertion order, but a copy goes through the store contract and nothing in it
 * says so — asserting the order would test the copy's incidental shape rather
 * than the copy.
 */
function byPart(rows: Array<{ data: Record<string, unknown> }>): Record<string, unknown>[] {
  return rows.map((r) => r.data).sort((a, b) => String(a['part']).localeCompare(String(b['part'])));
}

/**
 * The names of the top-level OPFS entries.
 *
 * The SAHPool keeps its slab in a directory of its own, named after the VFS
 * (`db/edb/substrate.ts`'s `VFS_NAME`), so its presence is what says the
 * database really is on disk in this origin rather than in RAM.
 */
async function opfsEntries(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
    const names: string[] = [];
    for await (const name of root.keys()) names.push(name);
    return names;
  });
}

/**
 * Boot a tab that has adopted `edbName`, with no file pickers.
 *
 * The marker is written by an init script, so it is in place before the app's
 * first line runs. Both pickers are deleted, so this tab is a browser with no
 * FileSystem Access API — the state in which a Save has nowhere to go.
 * Storage is not wiped: Playwright gives each test its own browser context, so
 * IndexedDB and OPFS start empty anyway.
 */
async function bootFileBacked(page: Page, edbName: string, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      delete (window as unknown as Record<string, unknown>)['showDirectoryPicker'];
    },
    { key: ACTIVE_KEY, value: edbName },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/** Reload the same tab. The marker survives, so the session comes back file-backed. */
async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/**
 * Boot with a save picker that writes into a page global instead of to disk.
 *
 * Playwright cannot drive an OS dialog, so the picker is REPLACED rather than
 * removed. `showSaveFilePicker` hands back a handle whose `createWritable`
 * collects what is written into `window.__savedEdb`. Everything downstream of
 * the picker is the app's real code.
 *
 * The handle's methods live on a PROTOTYPE, which is load-bearing: `saveAs`
 * stores the handle in IndexedDB, structured clone copies own properties only,
 * and a function as an own property would throw `DataCloneError` and fail the
 * Save for a reason that has nothing to do with the app.
 */
async function bootWithSavePicker(page: Page, edbName: string, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
      delete (window as unknown as Record<string, unknown>)['showDirectoryPicker'];
      class StubHandle {
        kind = 'file';
        constructor(public name: string) {}
        async queryPermission() {
          return 'granted';
        }
        async requestPermission() {
          return 'granted';
        }
        async createWritable() {
          const parts: BlobPart[] = [];
          const name = this.name;
          return {
            async write(data: BlobPart) {
              parts.push(data);
            },
            async close() {
              const buffer = await new Blob(parts).arrayBuffer();
              let binary = '';
              for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
              (window as unknown as Record<string, unknown>)['__savedEdb'] = { name, base64: btoa(binary) };
            },
          };
        }
      }
      (window as unknown as Record<string, unknown>)['showSaveFilePicker'] = async (opts?: { suggestedName?: string }) => new StubHandle(opts?.suggestedName ?? 'workspace.edb');
    },
    { key: ACTIVE_KEY, value: edbName },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/**
 * Open the File menu and click one item by its LABEL.
 *
 * Not `getByRole('menuitem', { name })`: a menu item's accessible name is the
 * Material Icons ligature plus the label ("save Save"), so matching on the name
 * couples the test to which icon the item happens to carry. The label lives in
 * its own span, and matching that span exactly is what tells "Save" from
 * "Save As…".
 */
async function clickFileMenu(page: Page, label: string): Promise<void> {
  await page.locator('app-shell').getByRole('button', { name: /File/ }).click();
  await page
    .getByRole('menuitem')
    .filter({ has: page.getByText(label, { exact: true }) })
    .click();
}

/**
 * Save through the File menu, and hand back the bytes the picker's handle got.
 *
 * A workspace with no file yet cannot save silently any more — there is no
 * browser-side copy to fall back on — so Save ASKS where the bytes go. Clicking
 * through that dialog is part of the flow, not setup for it.
 */
async function saveThroughPicker(page: Page, to?: string): Promise<Buffer> {
  await clickFileMenu(page, 'Save');

  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/no file yet/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose a file…', exact: true }).click();

  await expect.poll(async () => page.evaluate(() => Boolean((window as unknown as Record<string, unknown>)['__savedEdb']))).toBe(true);
  const b64 = await page.evaluate(() => ((window as unknown as Record<string, { base64: string }>)['__savedEdb'] as { base64: string }).base64);
  const bytes = Buffer.from(b64, 'base64');
  if (to) writeFileSync(to, bytes);
  return bytes;
}

test.describe('browser .edb storage', () => {
  test('keeps the workspace in the OPFS pool, and nothing in IndexedDB', async ({ page }, testInfo) => {
    await bootFileBacked(page, `${testInfo.testId}.edb`, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });

    // The pool's own directory, named after the VFS. Its presence is the proof
    // that SQLite is writing pages into origin-private storage rather than
    // holding the database in RAM.
    expect(await opfsEntries(page)).toContain('.easydb-sahpool');

    // And no WORKSPACE is in IndexedDB. `easydb` is the database the browser
    // kept them in until the SQLite flip, and `easydb-snapshots` held the raw
    // dump a Save used to write when there was no file. Both are gone: the pool
    // IS the durable copy, so a second one beside it answered nothing. The only
    // IndexedDB database this app still opens holds FileSystem handles, which
    // is the one thing OPFS cannot store.
    const dbNames = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((d) => d.name));
    expect(dbNames).not.toContain('easydb');
    expect(dbNames).not.toContain('easydb-snapshots');
  });

  test('a reload restores the workspace, with nothing saved to a file', async ({ page }, testInfo) => {
    const edbName = `${testInfo.testId}.edb`;
    await bootFileBacked(page, edbName, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await addRow(page, tableId, { part: 'nut', qty: 9 });

    // No wait, and that is the assertion. Under the old mirror the bytes went
    // out on a 2s debounce, so anything written in the last moments before a
    // reload was gone. In the pool each COMMIT has already reached OPFS.
    await reload(page);

    // Nothing was ever written to the user's file — no picker was opened. So
    // this can only have come back from the pool, which is exactly the path a
    // crashed tab takes.
    const tables = await page.evaluate(async () => (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ name: string }[]> } } } }).__easydb.store.tables.find());
    expect(tables.map((t) => t.name)).toContain('parts');

    const rows = await page.evaluate(
      async (id) => (window as unknown as { __easydb: { store: { rows(id: string): { find(): Promise<{ data: Record<string, unknown> }[]> } } } }).__easydb.store.rows(id).find(),
      tableId,
    );
    expect(byPart(rows)).toEqual([
      { part: 'bolt', qty: 4 },
      { part: 'nut', qty: 9 },
    ]);
  });

  test('the bytes are a real SQLite database Node can open', async ({ page }, testInfo) => {
    const edbName = `${testInfo.testId}.edb`;
    await bootWithSavePicker(page, edbName, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await waitForPanel(page, tableId);

    // Out through the File menu, because that is the only way out: the pool's
    // OPFS files are an opaque slab the VFS manages, not a `.edb` sitting under
    // a readable name. Save is the way, and Save now goes through a real file
    // handle — the stub picker's — because there is nowhere else for it to go.
    const file = testInfo.outputPath('workspace.edb');
    const bytes = await saveThroughPicker(page, file);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');

    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const names = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r) => String(r['name']));
      expect(names).toContain('_easydb');

      // The table doc names its own physical table; everything else follows from it.
      const doc = JSON.parse(String(db.prepare(`SELECT doc FROM _easydb WHERE coll = 'tables'`).get()!['doc'])) as Record<string, unknown>;
      expect(doc['name']).toBe('parts');
      const sqlTable = String(doc['_sqlTable']);
      expect(names).toContain(sqlTable);

      // Real columns, not a JSON blob — the whole reason for the format.
      const columns = db
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(sqlTable)
        .map((r) => String(r['name']));
      expect(columns).toEqual(expect.arrayContaining(['_id', '_updatedAt', '_extra', 'part', 'qty']));

      const stored = db.prepare(`SELECT part, qty, _extra FROM "${sqlTable}"`).all();
      expect(stored).toHaveLength(1);
      expect(stored[0]!['part']).toBe('bolt');
      expect(stored[0]!['qty']).toBe(4);
      // Nothing overflowed, so the overflow column is SQL NULL rather than '{}'.
      expect(stored[0]!['_extra']).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a Save with no file asks where it goes, and writes nothing until it has one', async ({ page }, testInfo) => {
    await bootWithSavePicker(page, `${testInfo.testId}.edb`, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await waitForPanel(page, tableId);

    const dialog = page.locator('host-dialogs');

    // Cancelling the question writes NOTHING. This is the assertion the old
    // IndexedDB dump made impossible: a Save used to always land somewhere, so
    // "saved" could mean a copy the user never chose the location of and could
    // not hand to anyone. Now a Save either reaches the user's file or does not
    // happen, and the workspace stays durable in the pool either way.
    await clickFileMenu(page, 'Save');
    await expect(dialog.getByText(/no file yet/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__savedEdb'] ?? null)).toBeNull();

    // Answering it writes the file, once, through the handle the picker gave.
    const bytes = await saveThroughPicker(page);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  test('a browser with no file access says so instead of saving nowhere', async ({ page }, testInfo) => {
    // No pickers at all — Firefox and Safari. There is no IndexedDB dump to
    // quietly fall back on any more, so the only honest answer is to say that
    // this browser cannot produce a file, and to say that the workspace is
    // nonetheless still here.
    await bootFileBacked(page, `${testInfo.testId}.edb`, `edb-${testInfo.testId}`);
    const tableId = await createTable(page, 'parts', [{ field: 'part', type: 'string' }]);
    await addRow(page, tableId, { part: 'bolt' });
    await waitForPanel(page, tableId);

    await clickFileMenu(page, 'Save');

    const dialog = page.locator('host-dialogs');
    await expect(dialog.getByText(/cannot give easyDBAccess a file/)).toBeVisible();
    // It says the data is safe, not only that the save failed.
    await expect(dialog.getByText(/survives a reload/)).toBeVisible();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();

    // And the workspace really is still there.
    await reload(page);
    const rows = await page.evaluate(
      async (id) => (window as unknown as { __easydb: { store: { rows(i: string): { find(): Promise<{ data: Record<string, unknown> }[]> } } } }).__easydb.store.rows(id).find(),
      tableId,
    );
    expect(byPart(rows)).toEqual([{ part: 'bolt' }]);
  });
});

test.describe('converting a browser workspace to a file', () => {
  test('the File menu copies this workspace into a new .edb and switches to it', async ({ page }, testInfo) => {
    // No pickers at all: this is what Firefox and Safari look like, and it is what
    // lets the whole menu flow run without an OS dialog Playwright cannot touch.
    // The directory picker has to go too, or the folder path opens one.
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      delete (window as unknown as Record<string, unknown>)['showDirectoryPicker'];
    });
    const workspaceId = `conv-${testInfo.testId}`;
    await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    // This data goes into this tab's own database. The conversion has to find
    // it there and copy it into the new file.
    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await addRow(page, tableId, { part: 'nut', qty: 9 });

    const shell = page.locator('app-shell');
    await shell.getByRole('button', { name: /File/ }).click();
    await page.getByRole('menuitem', { name: /New .edb file/ }).click();

    const dialog = page.locator('host-dialogs');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Copy this workspace into it', exact: true }).click();

    // The alert that announces the reload is the plugin's last step, so its
    // arrival means the copy, the export and the download all finished.
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    // The tab is now file-backed. A session that failed to start clears this key,
    // so its survival is the proof.
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(`${workspaceId}.edb`);

    const rows = await page.evaluate(
      async (id) => (window as unknown as { __easydb: { store: { rows(id: string): { find(): Promise<{ data: Record<string, unknown> }[]> } } } }).__easydb.store.rows(id).find(),
      tableId,
    );
    expect(byPart(rows)).toEqual([
      { part: 'bolt', qty: 4 },
      { part: 'nut', qty: 9 },
    ]);

    // And the file the user was handed is a database, with both rows in it.
    const file = testInfo.outputPath('converted.edb');
    await (await download).saveAs(file);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const doc = JSON.parse(String(db.prepare(`SELECT doc FROM _easydb WHERE coll = 'tables'`).get()!['doc'])) as Record<string, unknown>;
      const stored = db.prepare(`SELECT part, qty FROM "${String(doc['_sqlTable'])}" ORDER BY part`).all();
      expect(stored).toEqual([
        { part: 'bolt', qty: 4 },
        { part: 'nut', qty: 9 },
      ]);
    } finally {
      db.close();
    }
  });
});

/**
 * LAST on purpose. These are the only tests that import modules the app itself
 * never loads, and the dev server compiles them on demand — which reloaded the
 * page in whichever test ran next and failed it. Nothing follows here, and `100-`
 * is the last spec file.
 */

test.describe('the storage strategy question', () => {
  /** Boot with no pickers, so the file path takes its download fallback. */
  async function boot(page: Page, workspaceId: string): Promise<void> {
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      delete (window as unknown as Record<string, unknown>)['showDirectoryPicker'];
    });
    await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  }

  test('Advanced puts the new workspace in its own .edb file', async ({ page }, testInfo) => {
    await boot(page, `start-${testInfo.testId}`);
    const dialog = page.locator('host-dialogs');

    await page.evaluate(async () => {
      const { newWorkspaceFlow } = await import('/src/chrome/workspace-actions.ts');
      void newWorkspaceFlow();
    });
    await dialog.getByRole('textbox').fill('sales');
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Advanced/ }).click();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    // The flow navigates to `?space=`. Waiting on `__easydb` alone would pass on
    // the OLD page, which still has one, and assert against the workspace we came
    // from.
    await page.waitForURL(/space=sales/, { timeout: 20_000 });
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    // The tab is file-backed and sitting in the new workspace.
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe('sales.edb');
    expect(await page.evaluate(() => (window as unknown as { __easydb: { workspaceId: string } }).__easydb.workspaceId)).toBe('sales');

    // And the file itself holds that workspace and nothing else.
    const file = testInfo.outputPath('sales.edb');
    await (await download).saveAs(file);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT doc FROM _easydb WHERE coll = 'workspaces'`).all();
      expect(rows).toHaveLength(1);
      expect((JSON.parse(String(rows[0]!['doc'])) as { name: string }).name).toBe('sales');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM _easydb WHERE coll = 'tables'`).get()!['n']).toBe(0);
    } finally {
      db.close();
    }
  });

  test('Simple keeps the new workspace in browser storage', async ({ page }, testInfo) => {
    await boot(page, `start-${testInfo.testId}`);
    const dialog = page.locator('host-dialogs');

    await page.evaluate(async () => {
      const { newWorkspaceFlow } = await import('/src/chrome/workspace-actions.ts');
      void newWorkspaceFlow();
    });
    await dialog.getByRole('textbox').fill('plain');
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await dialog.getByRole('button', { name: /^Simple/ }).click();
    // Simple still asks what to inherit — the question Advanced skips.
    await dialog.getByRole('button', { name: 'Empty workspace', exact: true }).click();
    await page.waitForURL(/space=plain/, { timeout: 20_000 });
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { __easydb: { workspaceId: string } }).__easydb.workspaceId)).toBe('plain');
  });
});

test.describe('the workspace folder', () => {
  /**
   * The folder helpers, driven against OPFS.
   *
   * `showDirectoryPicker` is an OS dialog Playwright cannot open, but what it
   * returns is an ordinary `FileSystemDirectoryHandle` — and OPFS hands one over
   * with no dialog at all. So everything the app does WITH a folder is testable;
   * only the act of choosing one is not.
   */
  test('lists only .edb files, sorted, and creates a file without a picker', async ({ page }, testInfo) => {
    await page.goto(`/?test=1&space=folder-${testInfo.testId}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    const result = await page.evaluate(async () => {
      const { listWorkspaceFiles, fileInFolder } = await import('/src/db/edb/file-handle.ts');
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('folder-test', { create: true });
      for (const name of ['zeta.edb', 'alpha.edb', 'notes.txt']) await dir.getFileHandle(name, { create: true });
      await dir.getDirectoryHandle('sub.edb', { create: true });

      const listed = await listWorkspaceFiles(dir);
      // Creating inside a granted folder needs no dialog — the point of a folder.
      const made = await fileInFolder(dir, 'new.edb', true);
      const missing = await fileInFolder(dir, 'absent.edb', false);
      return { listed, after: await listWorkspaceFiles(dir), made: made?.name ?? null, missing };
    });

    // Sorted, `.txt` dropped, and a DIRECTORY named `.edb` dropped too.
    expect(result.listed).toEqual(['alpha.edb', 'zeta.edb']);
    expect(result.made).toBe('new.edb');
    expect(result.after).toEqual(['alpha.edb', 'new.edb', 'zeta.edb']);
    // A name that is not there is null, not a thrown error the caller must catch.
    expect(result.missing).toBeNull();
  });
});
