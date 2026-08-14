import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { addRow, bindWorkspaceToFile, createTable, waitForEdbMirror, EDB_REGISTRY_KEY } from './helpers.js';

/**
 * The browser's file-backed mode: a workspace kept in a real SQLite `.edb`.
 *
 * The OS file picker cannot be driven from Playwright, so this spec never opens
 * one. Two ways round it:
 *
 * 1. Most tests write the registry entry the picker would have written, binding
 *    one workspace to one file, then exercise everything downstream — worker,
 *    store, OPFS mirror, reload.
 * 2. The conversion test hides `showSaveFilePicker`, which is what a browser
 *    without the FileSystem API looks like. The plugin then takes its download
 *    path, and the whole menu flow runs for real.
 *
 * Two tests open the produced bytes in **Node's** SQLite. That is the point of
 * the feature, and the assertion goes nowhere near the app's own code.
 */

/**
 * Row data in a fixed order, for comparing.
 *
 * `DataCollection.find()` promises no order, and the two stores really do differ:
 * SQLite scans a table in insertion order, while Dexie walks its `tableId` index,
 * which is ordered by the row's own id — a random UUID. So a conversion, which
 * READS from Dexie, hands back a different order on different runs. Asserting the
 * order tested the shuffle, not the copy.
 */
function byPart(rows: Array<{ data: Record<string, unknown> }>): Record<string, unknown>[] {
  return rows.map((r) => r.data).sort((a, b) => String(a['part']).localeCompare(String(b['part'])));
}

/** The `.edb` the registry says `workspaceId` lives in, or null for IndexedDB. */
async function fileForWorkspace(page: Page, workspaceId: string): Promise<string | null> {
  return page.evaluate(
    ({ key, id }) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return (JSON.parse(raw) as Record<string, { file?: string }>)[id]?.file ?? null;
    },
    { key: EDB_REGISTRY_KEY, id: workspaceId },
  );
}

/**
 * Boot a tab whose `workspaceId` is bound to `edbName`.
 *
 * The registry entry is written by an init script, so it is in place before the
 * app's first line runs. Loading the app even once without it would open the
 * Dexie database this mode replaces, and the "not in Dexie" assertion below could
 * then never be trusted. Storage is not wiped: Playwright gives each test its own
 * browser context, so IndexedDB and OPFS start empty anyway.
 */
async function bootFileBacked(page: Page, edbName: string, workspaceId: string): Promise<void> {
  await bindWorkspaceToFile(page, workspaceId, edbName);
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/** Reload the same tab. The entry survives, so the session comes back file-backed. */
async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

test.describe('browser .edb storage', () => {
  test('keeps the workspace in the worker, not in Dexie', async ({ page }, testInfo) => {
    await bootFileBacked(page, `${testInfo.testId}.edb`, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });

    // The app's own Dexie database is what a browser-storage session would have
    // created. Its absence is the proof that the store really is the worker's.
    const dbNames = await page.evaluate(async () => ((await indexedDB.databases?.()) ?? []).map((d) => d.name));
    expect(dbNames).not.toContain('easydb');
  });

  test('a reload restores the workspace from the OPFS mirror', async ({ page }, testInfo) => {
    const edbName = `${testInfo.testId}.edb`;
    await bootFileBacked(page, edbName, `edb-${testInfo.testId}`);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await addRow(page, tableId, { part: 'nut', qty: 9 });
    await waitForEdbMirror(page, edbName);

    await reload(page);

    // Nothing was ever written to the user's file — no picker was opened. So this
    // can only have come back from the mirror, which is exactly the path a crashed
    // tab takes.
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

    const bytes = await waitForEdbMirror(page, edbName);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');

    const file = testInfo.outputPath('workspace.edb');
    writeFileSync(file, bytes);
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

    // This data goes to Dexie. The conversion has to find it there.
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

    // This workspace is now file-backed, and only this one. The registry entry is
    // the whole record of that.
    expect(await fileForWorkspace(page, workspaceId)).toBe(`${workspaceId}.edb`);

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

    // The new workspace is file-backed and open.
    expect(await fileForWorkspace(page, 'sales')).toBe('sales.edb');
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

    expect(await fileForWorkspace(page, 'plain')).toBeNull();
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
