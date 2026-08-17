import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { addRow, createTable, waitForPanel } from './helpers.js';

/**
 * The browser's file-backed mode: a workspace kept in a real SQLite `.edb`.
 *
 * The OS file picker cannot be driven from Playwright, so this spec never opens
 * one. Two ways round it:
 *
 * 1. Most tests set the marker `localStorage` key the picker would have written,
 *    then exercise everything downstream — worker, store, OPFS pool, reload.
 * 2. The rest hide `showSaveFilePicker`, which is what a browser without the
 *    FileSystem API looks like. The plugin then takes its download path, and the
 *    whole menu flow runs for real.
 *
 * Two tests open the produced bytes in **Node's** SQLite. That is the point of
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
 * first line runs. Deleting the pickers is what makes the File menu's Save take
 * its download path — the only way to get bytes out without an OS dialog.
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
 * The `.edb` names IndexedDB currently holds a dump for.
 *
 * Read through the raw IndexedDB API on purpose: the record shape is what the
 * app promises, and the app must be the only thing that ever needs to know it.
 * Resolves `[]` for a database that exists but holds nothing, which is what a
 * boot-time probe leaves behind.
 */
async function snapshotKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('easydb-snapshots');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('snapshots')) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction('snapshots', 'readonly');
          const keys = tx.objectStore('snapshots').getAllKeys();
          tx.oncomplete = () => {
            db.close();
            resolve(keys.result.map(String));
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

/**
 * The bytes the File menu hands over, via Save.
 *
 * The way out of the pool is `export`, and the menu item that calls it is Save
 * — which downloads when there is no file handle, i.e. exactly the browser this
 * spec pretends to be. So this drives the real menu rather than reaching into
 * the store, and what it returns is what a user would have on disk.
 */
async function downloadViaSave(page: Page, to: string): Promise<Buffer> {
  const download = page.waitForEvent('download');
  await page.locator('app-shell').getByRole('button', { name: /File/ }).click();
  await page.getByRole('menuitem', { name: /Save a copy in this browser/ }).click();
  await (await download).saveAs(to);
  return readFileSync(to);
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
    // kept them in until the SQLite flip, so its absence is the assertion.
    //
    // Deliberately not "IndexedDB is empty": `?space=` resolution probes for a
    // saved copy on every boot (`space-adopt.ts`), which opens
    // `easydb-snapshots` before anything has been written to it. That the
    // snapshot store holds nothing until a Save is the next test's job.
    const dbNames = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((d) => d.name));
    expect(dbNames).not.toContain('easydb');
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
    await bootFileBacked(page, edbName, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await waitForPanel(page, tableId);

    // Out through the File menu, because that is the only way out: the pool's
    // OPFS files are an opaque slab the VFS manages, not a `.edb` sitting under
    // a readable name. With no `showSaveFilePicker` the menu item is "Download
    // a copy" and the bytes arrive as a download.
    const file = testInfo.outputPath('workspace.edb');
    const bytes = await downloadViaSave(page, file);
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

  test('a Save with no file to save to dumps the database into IndexedDB, and can be restored from it', async ({ page }, testInfo) => {
    const edbName = `${testInfo.testId}.edb`;
    await bootFileBacked(page, edbName, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await waitForPanel(page, tableId);

    // Nothing yet: the dump is written on Save, not as the workspace goes.
    //
    // Asserted as an empty STORE rather than an absent database. `?space=`
    // resolution probes for a saved copy on every boot (`space-adopt.ts`), and
    // `indexedDB.open` creates what it opens — so the database exists from the
    // first load and only its emptiness can say the dump has not happened.
    expect(await snapshotKeys(page)).toEqual([]);

    await downloadViaSave(page, testInfo.outputPath('saved.edb'));

    // One record, keyed by the .edb name, holding the whole database as a blob
    // and nothing else. Read here through the raw IndexedDB API on purpose:
    // this is the shape the app promises, and the app must be the only thing
    // that ever needs to know it.
    const record = await page.evaluate(
      (slot) =>
        new Promise<{ keys: string[]; stores: string[]; slot: string; byteLength: number; type: string; fields: string[] } | null>((resolve, reject) => {
          const req = indexedDB.open('easydb-snapshots');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const stores = [...db.objectStoreNames];
            const tx = db.transaction('snapshots', 'readonly');
            const store = tx.objectStore('snapshots');
            const all = store.getAll();
            const keys = store.getAllKeys();
            tx.oncomplete = () => {
              const rec = all.result[0] as { slot: string; bytes: Blob; byteLength: number } | undefined;
              db.close();
              resolve(rec ? { keys: keys.result.map(String), stores, slot: rec.slot, byteLength: rec.byteLength, type: rec.bytes.type, fields: Object.keys(rec).sort() } : null);
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      edbName,
    );
    expect(record).not.toBeNull();
    expect(record!.stores).toEqual(['snapshots']);
    expect(record!.keys).toEqual([edbName]);
    expect(record!.slot).toBe(edbName);
    expect(record!.type).toBe('application/x-sqlite3');
    // A SQLite file, not a JSON dump of the workspace — the whole point of
    // calling this a raw copy rather than a store.
    expect(record!.byteLength).toBeGreaterThan(1024);
    expect(record!.fields).toEqual(['at', 'byteLength', 'bytes', 'formatVersion', 'slot']);

    // Change the workspace AFTER the save, so restoring has something to undo.
    await addRow(page, tableId, { part: 'nut', qty: 9 });
    await expect
      .poll(
        async () =>
          (await page.evaluate(async (id) => (window as unknown as { __easydb: { store: { rows(i: string): { find(): Promise<unknown[]> } } } }).__easydb.store.rows(id).find(), tableId)).length,
      )
      .toBe(2);

    await page.locator('app-shell').getByRole('button', { name: /File/ }).click();
    await page.getByRole('menuitem', { name: /Restore this browser's copy/ }).click();
    // The restore reloads, and the wait has to be for THAT load — `__easydb` is
    // already true on the page being replaced, so waiting on it alone would read
    // the pre-restore workspace and pass for the wrong reason.
    const restored = page.waitForEvent('load');
    await page.locator('host-dialogs').getByRole('button', { name: 'Yes', exact: true }).click();
    await restored;
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    // Back to the one row that was there when Save ran. The blob went into
    // SQLite to be read — nothing queried IndexedDB for it.
    const rows = await page.evaluate(async () => {
      const store = (
        window as unknown as { __easydb: { store: { tables: { find(): Promise<{ id: string; name: string }[]> }; rows(id: string): { find(): Promise<{ data: Record<string, unknown> }[]> } } } }
      ).__easydb.store;
      const parts = (await store.tables.find()).find((t) => t.name === 'parts')!;
      return store.rows(parts.id).find();
    });
    expect(byPart(rows)).toEqual([{ part: 'bolt', qty: 4 }]);
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
