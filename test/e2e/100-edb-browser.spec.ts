import { expect, test, type Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { addRow, createTable, waitForPanel } from './helpers.js';
import { workspaceIdFromFileName } from '../../packages/renderer/src/db/edb/space-resolve.js';

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
 *    the Save button, the "where does this go?" dialog, `ensureWritable`,
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
 * readable name. The way OUT of the pool is `export`, which is what Save does —
 * so the "these bytes are a real database" test now goes through the Save button
 * instead of reading a mirror file.
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
  // A `.edb` holds the workspace its name says, so these two have to agree — a
  // mismatch now sends the tab to the project index rather than creating a second
  // workspace inside the file. See `126-one-workspace-per-file.spec.ts`.
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

/** The folder the stubbed directory picker hands over. */
const SAVE_FOLDER = 'save-target';

/**
 * Boot with a DIRECTORY picker that hands back an OPFS folder.
 *
 * Save writes into a connected workspace folder and nowhere else — there is no
 * per-file answer any more — and OPFS gives out a real
 * `FileSystemDirectoryHandle` with no OS dialog at all, so everything after the
 * picker is the app's own code, including the handle going through structured
 * clone into IndexedDB. The save-FILE picker is deleted: nothing should be
 * reaching for one.
 *
 * `edbName` is optional. Without it the tab has never adopted a file, which is
 * the state that matters for a first Save.
 */
async function bootWithFolderPicker(page: Page, workspaceId: string, edbName?: string): Promise<void> {
  await page.addInitScript(
    ({ key, value, folder }) => {
      if (value) localStorage.setItem(key, value);
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      (window as unknown as Record<string, unknown>)['showDirectoryPicker'] = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(folder, { create: true });
      };
    },
    { key: ACTIVE_KEY, value: edbName ?? '', folder: SAVE_FOLDER },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/** The bytes of one file in the stub folder, or null while it is not there yet. */
async function folderFile(page: Page, name: string): Promise<Buffer | null> {
  const b64 = await page.evaluate(
    async ({ folder, file }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder);
        const handle = await dir.getFileHandle(file);
        const buffer = await (await handle.getFile()).arrayBuffer();
        let binary = '';
        for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
        return binary.length > 0 ? btoa(binary) : null;
      } catch {
        return null;
      }
    },
    { folder: SAVE_FOLDER, file: name },
  );
  return b64 === null ? null : Buffer.from(b64, 'base64');
}

/**
 * Run one of the file commands through the command palette.
 *
 * There is no File menu any more — these are palette entries, so this is how a
 * user reaches them. The palette is opened by its header button rather than by
 * Ctrl+K, because the button is a real target and the shortcut is covered by its
 * own spec.
 */
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

/** The header's Save button — the one file operation that is still a button. */
function saveButton(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

/**
 * Save with no folder connected yet, and hand back the bytes that landed in the
 * folder.
 *
 * The first Save of a workspace that has never had one asks for a folder — the
 * only thing it asks for. After that the name is a foregone conclusion
 * (`<workspace-id>.edb`), so nothing else is clicked here.
 */
async function saveIntoNewFolder(page: Page, workspaceId: string, to?: string): Promise<Buffer> {
  await saveButton(page).click();

  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();

  const name = `${workspaceId}.edb`;
  let bytes: Buffer | null = null;
  await expect.poll(async () => (bytes = await folderFile(page, name)) !== null, { timeout: 20_000, message: `${name} never appeared in the folder` }).toBe(true);
  if (to) writeFileSync(to, bytes!);
  return bytes!;
}

test.describe('browser .edb storage', () => {
  test('keeps the workspace in the OPFS pool, and nothing in IndexedDB', async ({ page }, testInfo) => {
    await bootFileBacked(page, `edb-${testInfo.testId}.edb`, `edb-${testInfo.testId}`);

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
    await bootFileBacked(page, edbName, workspaceIdFromFileName(edbName));

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
    const workspaceId = `edb-${testInfo.testId}`;
    await bootWithFolderPicker(page, workspaceId);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await waitForPanel(page, tableId);

    // Out through Save, because that is the only way out: the pool's
    // OPFS files are an opaque slab the VFS manages, not a `.edb` sitting under
    // a readable name. Save is the way, and it writes into the folder it just
    // asked for, under the workspace's own name.
    const file = testInfo.outputPath('workspace.edb');
    const bytes = await saveIntoNewFolder(page, workspaceId, file);
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

  test('a Save with no folder asks for one, and writes nothing until it has one', async ({ page }, testInfo) => {
    const workspaceId = `edb-${testInfo.testId}`;
    await bootWithFolderPicker(page, workspaceId);

    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await waitForPanel(page, tableId);

    const dialog = page.locator('host-dialogs');

    // Cancelling writes NOTHING. This is the assertion the old IndexedDB dump made
    // impossible: a Save used to always land somewhere, so "saved" could mean a
    // copy the user never chose the location of and could not hand to anyone. Now a
    // Save either reaches the user's disk or does not happen, and the workspace
    // stays durable in the pool either way.
    await saveButton(page).click();
    await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
    // And it says so without claiming the data is at risk.
    await expect(dialog.getByText(/stays there/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await folderFile(page, `${workspaceId}.edb`)).toBeNull();

    // Connecting one writes the file, under the workspace's own name and with no
    // second question about what to call it.
    const bytes = await saveIntoNewFolder(page, workspaceId);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  /**
   * The file operations live in the command palette, under "File". There is no
   * footer menu: it was a second way to navigate five things the palette already
   * listed, and the footer otherwise belongs to the workspace's own buttons.
   *
   * The other half of this test is what must NOT be offered. Every entry left out
   * is one something else already does.
   */
  test('the file operations are palette commands, not a File menu', async ({ page }, testInfo) => {
    const workspaceId = `edb-${testInfo.testId}`;
    await bootWithFolderPicker(page, workspaceId);

    // The button that opened the menu is gone. Save is the one that stayed, and it
    // is in the header rather than the footer.
    await expect(page.locator('app-shell').getByRole('button', { name: 'File', exact: true })).toHaveCount(0);
    await expect(saveButton(page)).toBeVisible();

    await page
      .locator('app-shell header')
      .getByTitle(/open the command palette/i)
      .click();
    const palette = page.locator('command-palette-dialog dialog');
    await palette.locator('input').fill('file');
    const entries = palette.locator('.item');

    await expect(entries.filter({ has: page.getByText('Open workspace file…', { exact: true }) })).toHaveCount(1);
    await expect(entries.filter({ has: page.getByText('Turn on autosave', { exact: true }) })).toHaveCount(1);
    // No folder has been granted yet, so the command says "Connect".
    await expect(entries.filter({ has: page.getByText('Connect workspace folder…', { exact: true }) })).toHaveCount(1);
    await expect(entries.filter({ has: page.getByText('Change workspace folder…', { exact: true }) })).toHaveCount(0);
    // Save is here because the palette lists every BUTTON too — once, not twice: the
    // plugin registers no Save command while the header button exists.
    await expect(entries.filter({ has: page.getByText('Save', { exact: true }) })).toHaveCount(1);
    // Gone: New workspace → Advanced makes a file-backed workspace, and a file's
    // NAME is the workspace inside it, so writing this workspace out under another
    // name is the one thing that must not happen.
    await expect(entries.filter({ has: page.getByText(/New .edb/) })).toHaveCount(0);
    await expect(entries.filter({ has: page.getByText(/Save As/) })).toHaveCount(0);

    // Connect a folder — by saving into it, which is the only way there is — and the
    // folder command turns over to "Change".
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await saveIntoNewFolder(page, workspaceId);

    await page
      .locator('app-shell header')
      .getByTitle(/open the command palette/i)
      .click();
    await palette.locator('input').fill('folder');
    await expect(entries.filter({ has: page.getByText('Change workspace folder…', { exact: true }) })).toHaveCount(1);
    await expect(entries.filter({ has: page.getByText('Connect workspace folder…', { exact: true }) })).toHaveCount(0);
  });

  /**
   * A palette is one flat list, so a command has to answer for the state it is run
   * in rather than being hidden. Both of these used to be menu items the menu could
   * leave out.
   */
  test('a command with nothing to act on says so', async ({ page }, testInfo) => {
    await bootWithFolderPicker(page, `edb-${testInfo.testId}`);
    const toast = page.locator('toast-host');

    await runFileCommand(page, 'Sync workspace folder');
    await expect(toast.getByText(/No workspace folder is connected/)).toBeVisible();

    await runFileCommand(page, 'Back to browser storage');
    await expect(toast.getByText(/not in a file/)).toBeVisible();
  });

  /**
   * The dot means "there is something not on disk", so a workspace that has never
   * been saved carries it from the first moment — boot writes the workspace record
   * and the seeded view templates, and none of that is in a file yet. What the test
   * pins down is the CYCLE: the dot clears on a save and comes back on the next
   * edit.
   */
  test('the header Save button marks unsaved work and clears it on a save', async ({ page }, testInfo) => {
    const workspaceId = `edb-${testInfo.testId}`;
    await bootWithFolderPicker(page, workspaceId);
    const save = page.locator('app-shell').getByRole('button', { name: /Save/ });
    // The marker is the red dot the shell draws for `ButtonSpec.badge`, not text in
    // the label — so it is located as an element inside the button.
    const dot = save.locator('.badge');

    const tableId = await createTable(page, 'parts', [{ field: 'part', type: 'string' }]);
    await addRow(page, tableId, { part: 'bolt' });
    await waitForPanel(page, tableId);

    // A write marks it. The store's own change broadcast drives this, so nothing
    // had to remember to announce itself.
    await expect(dot).toBeVisible();
    // Red and round, because "notification dot" is the whole point of it.
    expect(await dot.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
    expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(239, 68, 68)');

    await save.click();
    await page.locator('host-dialogs').getByRole('button', { name: 'Connect a folder…', exact: true }).click();

    // Saved, so the dot goes while the button stays.
    await expect(dot).toHaveCount(0, { timeout: 20_000 });
    await expect(save).toBeVisible();

    // The next edit brings it back — the indicator tracks the file, not the boot.
    await addRow(page, tableId, { part: 'nut' });
    await expect(dot).toBeVisible();
  });

  test('a browser with no file access says so instead of saving nowhere', async ({ page }, testInfo) => {
    // No pickers at all — Firefox and Safari. There is no IndexedDB dump to
    // quietly fall back on any more, so the only honest answer is to say that
    // this browser cannot produce a file, and to say that the workspace is
    // nonetheless still here.
    await bootFileBacked(page, `edb-${testInfo.testId}.edb`, `edb-${testInfo.testId}`);
    const tableId = await createTable(page, 'parts', [{ field: 'part', type: 'string' }]);
    await addRow(page, tableId, { part: 'bolt' });
    await waitForPanel(page, tableId);

    // No header Save button in a browser like this, so the palette command is the
    // only Save there is — and saying why is its whole job here.
    await runFileCommand(page, 'Save workspace to a file');

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
  /**
   * The conversion IS a Save now. "New .edb file → Copy this workspace into it" is
   * gone: New workspace → Advanced already makes a workspace in its own file, and
   * a Save of a workspace that has none writes it into the connected folder and
   * adopts it — no separate convert step, and nothing to keep in step with it.
   */
  test('a Save puts a browser workspace into a file and switches this tab to it', async ({ page }, testInfo) => {
    const workspaceId = `conv-${testInfo.testId}`;
    await bootWithFolderPicker(page, workspaceId);

    // This data lives in this tab's own database. The Save has to find it there and
    // put it in the file.
    const tableId = await createTable(page, 'parts', [
      { field: 'part', type: 'string', renderer: 'link' },
      { field: 'qty', type: 'number' },
    ]);
    await addRow(page, tableId, { part: 'bolt', qty: 4 });
    await addRow(page, tableId, { part: 'nut', qty: 9 });
    await waitForPanel(page, tableId);

    const file = testInfo.outputPath('converted.edb');
    await saveIntoNewFolder(page, workspaceId, file);

    // The tab is file-backed from here on, with no reload: the Save adopted the
    // file it just wrote, so the next Save goes to the same place unasked.
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(`${workspaceId}.edb`);

    const rows = await page.evaluate(
      async (id) => (window as unknown as { __easydb: { store: { rows(id: string): { find(): Promise<{ data: Record<string, unknown> }[]> } } } }).__easydb.store.rows(id).find(),
      tableId,
    );
    expect(byPart(rows)).toEqual([
      { part: 'bolt', qty: 4 },
      { part: 'nut', qty: 9 },
    ]);

    // And the file on disk is a database with both rows in it.
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
    // The last QUESTION. What follows is the notice that the page is about to
    // reload — never a "name the file" prompt, because the file is named after the
    // workspace (`sales.edb`) and that is how Open finds the workspace again.
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

  /**
   * Opening `<name>.edb` lands in the workspace `<name>`.
   *
   * It used to reload with no `?space=` at all, so boot fell back to the
   * device-global last-workspace id and then to whichever record the file returned
   * first — which is how opening a file could show a workspace called `default`, or
   * the one the tab came from, instead of the file's own.
   *
   * The tab starts in a DIFFERENT workspace with `?space=` in the URL, because that
   * stale parameter is the thing that has to lose.
   */
  test('Open lands in the workspace the file is named after', async ({ page }, testInfo) => {
    const fileWs = `opened-${testInfo.testId}`;
    await bootWithFolderPicker(page, `elsewhere-${testInfo.testId}`);

    // A file in the folder holding one workspace of its own, with a table in it.
    await page.evaluate(
      async ({ ws, folder }) => {
        const { createEdbBridge } = await import('/src/db/edb/worker-bridge.ts');
        const { createIpcDataStore } = await import('/src/db/data-store-bridge.ts');
        const { fileInFolder, writeBytes } = await import('/src/db/edb/file-handle.ts');
        const scratch = createEdbBridge();
        try {
          await scratch.open(null, 'open-fixture.edb');
          const store = createIpcDataStore(scratch, () => ws);
          await store.workspaces.insert({ id: ws, name: ws, createdAt: Date.now(), pluginUrls: [] });
          await store.tables.insert({ id: `${ws}-t`, workspaceId: ws, name: 'fromfile', code: '', columns: [{ field: 'part', type: 'string' }], view: 'table' });
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle(folder, { create: true });
          const handle = await fileInFolder(dir, `${ws}.edb`, true);
          await writeBytes(handle!, await scratch.export());
        } finally {
          scratch.terminate();
        }
      },
      { ws: fileWs, folder: SAVE_FOLDER },
    );

    await runFileCommand(page, 'Open workspace file…');
    const dialog = page.locator('host-dialogs');
    await dialog.getByRole('button', { name: `${fileWs}.edb`, exact: true }).click();
    // The alert naming the workspace is the plugin's last step before the reload.
    await expect(dialog.getByText(new RegExp(`as the workspace "${fileWs}"`))).toBeVisible();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();

    await page.waitForURL(new RegExp(`space=${fileWs}`), { timeout: 20_000 });
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    // In the file's own workspace, looking at the file's own table.
    expect(await page.evaluate(() => (window as unknown as { __easydb: { workspaceId: string } }).__easydb.workspaceId)).toBe(fileWs);
    const tables = await page.evaluate(async () => {
      const store = (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ name: string }[]> } } } }).__easydb.store;
      return (await store.tables.find()).map((t) => t.name);
    });
    expect(tables).toEqual(['fromfile']);
  });

  /**
   * `?space=NAME` CREATES the workspace when it cannot find one, and at boot it
   * cannot look inside a folder nobody has connected yet. So a private window that
   * opens such a link always holds an empty workspace of that name by the time the
   * folder is chosen, and the sync used to ask which of the two copies was real —
   * about a workspace the app had made itself seconds earlier.
   *
   * The scenario is built the only way it can be: give the workspace a table, copy
   * it into a `.edb` in the folder, then take the local table away. That leaves the
   * file holding the work and this browser holding an empty workspace of the same
   * name, which is the private-window state exactly.
   */
  test('a folder file wins over the empty workspace the URL just created, unasked', async ({ page }, testInfo) => {
    const ws = `simon-${testInfo.testId}`;
    await page.goto(`/?test=1&space=${ws}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    const tableId = await createTable(page, 'fromfile', [{ field: 'part', type: 'string' }]);
    await addRow(page, tableId, { part: 'bolt' });
    await waitForPanel(page, tableId);

    await page.evaluate(
      async ({ name, table }) => {
        const { createEdbBridge } = await import('/src/db/edb/worker-bridge.ts');
        const { createIpcDataStore } = await import('/src/db/data-store-bridge.ts');
        const { copyWorkspace } = await import('/src/db/edb/convert.ts');
        const { fileInFolder, writeBytes, rememberFolder } = await import('/src/db/edb/file-handle.ts');
        const live = (window as unknown as { __easydb: { store: Parameters<typeof copyWorkspace>[0] } }).__easydb.store;

        const scratch = createEdbBridge();
        try {
          await scratch.open(null, 'sync-fixture.edb');
          await copyWorkspace(
            live,
            createIpcDataStore(scratch, () => name),
            name,
          );
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('folder-sync-test', { create: true });
          const handle = await fileInFolder(dir, `${name}.edb`, true);
          await writeBytes(handle!, await scratch.export());
          await rememberFolder(dir);
        } finally {
          scratch.terminate();
        }

        // The local copy goes back to being the empty shell `?space=` created.
        await live.tables.remove(table);
      },
      { name: ws, table: tableId },
    );

    // Set BEFORE the sync starts, and awaited: the wait below is "this flag is
    // gone", so a flag set inside the un-awaited call could still be missing on
    // the first poll and pass the wait against the page we came from.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)['__beforeAdopt'] = true;
    });

    // A stub for the one dialog that must NOT open. It records into
    // `localStorage`, which survives the reload an adopt ends in.
    const asked = 'test:conflictAsked';
    void page
      .evaluate(
        async ({ name, key }) => {
          const { syncFolder } = await import('/src/db/edb/folder-sync.ts');
          const { rememberedFolder } = await import('/src/db/edb/file-handle.ts');
          const store = (window as unknown as { __easydb: { store: Parameters<typeof syncFolder>[1] } }).__easydb.store;
          const dialogs = {
            choice: async (message: string) => {
              localStorage.setItem(key, message);
              return 'Cancel';
            },
            alert: async () => {},
            toast: () => {},
          } as unknown as Parameters<typeof syncFolder>[2];
          await syncFolder((await rememberedFolder())!, store, dialogs, async () => {});
          void name;
        },
        { name: ws, key: asked },
      )
      .catch(() => {
        /* the adopt reloads the page, which destroys this call's context */
      });

    // The adopt reloads, so the proof is the NEW page: the flag is gone and the
    // app has booted again.
    await page.waitForFunction(() => !(window as unknown as Record<string, unknown>)['__beforeAdopt'] && Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 30_000 });

    // Nothing was asked.
    expect(await page.evaluate((k) => localStorage.getItem(k), asked)).toBeNull();
    // The tab is now the folder's file, and the table from it is here.
    expect(await page.evaluate((k) => localStorage.getItem(k), ACTIVE_KEY)).toBe(`${ws}.edb`);
    const tables = await page.evaluate(async () => {
      const store = (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ id: string; name: string }[]> } } } }).__easydb.store;
      return (await store.tables.find()).map((t) => t.name);
    });
    expect(tables).toEqual(['fromfile']);
  });
});

/**
 * The conflict prompt itself: what it says, and that each answer does what its
 * label claims.
 *
 * The labels used to be "Load from Disk" / "Overwrite", and the question was
 * "which one is the real one?" — which asked the user to rule on a metaphysical
 * point rather than to pick a copy. Both answers now name **the disk version**,
 * because that is the copy the user cannot see and the one the answer turns on.
 *
 * Driven through `syncFolder` with a stub `Dialogs`, as the test above is: the
 * prompt is a `choice` over strings, so a stub that records the message and answers
 * with a label is the whole interaction. The real dialog element is covered where
 * it is opened for real (`123-folder-file-refresh.spec.ts`).
 */
test.describe('the folder-sync conflict prompt', () => {
  const FOLDER = 'conflict-prompt-test';

  /**
   * A workspace here AND in a file, each with tables the other lacks — and a
   * DIFFERENT NUMBER of them, so the prompt's counts have something to say. Two
   * copies that hold the same number are told apart only by the file's size and
   * date, which is the weaker half of the answer.
   */
  async function bothSidesDiffer(page: Page, ws: string): Promise<void> {
    await page.goto(`/?test=1&space=${ws}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

    const onDisk = await createTable(page, 'from_file', [{ field: 'part', type: 'string' }]);
    const alsoOnDisk = await createTable(page, 'also_in_file', [{ field: 'part', type: 'string' }]);
    await waitForPanel(page, onDisk);
    await waitForPanel(page, alsoOnDisk);
    // Snapshot this state into the folder's file, then move on locally: the file
    // holds `from_file`, this browser ends up holding `from_browser`.
    await page.evaluate(
      async ({ name, folder }) => {
        const { createEdbBridge } = await import('/src/db/edb/worker-bridge.ts');
        const { createIpcDataStore } = await import('/src/db/data-store-bridge.ts');
        const { copyWorkspace } = await import('/src/db/edb/convert.ts');
        const { fileInFolder, writeBytes, rememberFolder } = await import('/src/db/edb/file-handle.ts');
        const live = (window as unknown as { __easydb: { store: Parameters<typeof copyWorkspace>[0] } }).__easydb.store;
        const scratch = createEdbBridge();
        try {
          await scratch.open(null, 'conflict-fixture.edb');
          await copyWorkspace(
            live,
            createIpcDataStore(scratch, () => name),
            name,
          );
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle(folder, { create: true });
          const handle = await fileInFolder(dir, `${name}.edb`, true);
          await writeBytes(handle!, await scratch.export());
          await rememberFolder(dir);
        } finally {
          scratch.terminate();
        }
      },
      { name: ws, folder: FOLDER },
    );
    const local = await createTable(page, 'from_browser', [{ field: 'part', type: 'string' }]);
    await waitForPanel(page, local);
    await page.evaluate(
      async (ids) => {
        const store = (window as unknown as { __easydb: { store: { tables: { remove(id: string): Promise<unknown> } } } }).__easydb.store;
        for (const id of ids) await store.tables.remove(id);
      },
      [onDisk, alsoOnDisk],
    );
  }

  /** Run a sync, answering the prompt with `answer`. Reports what it was asked. */
  async function syncAnswering(page: Page, answer: string): Promise<{ message: string; options: string[] }> {
    return page.evaluate(async (answer) => {
      const { syncFolder } = await import('/src/db/edb/folder-sync.ts');
      const { rememberedFolder } = await import('/src/db/edb/file-handle.ts');
      const store = (window as unknown as { __easydb: { store: Parameters<typeof syncFolder>[1] } }).__easydb.store;
      let seen = { message: '', options: [] as string[] };
      const dialogs = {
        choice: async (message: string, options: string[]) => {
          seen = { message, options };
          return answer;
        },
        alert: async () => {},
        confirm: async () => true,
        toast: () => {},
      } as unknown as Parameters<typeof syncFolder>[2];
      // The overwrite callback the plugin normally supplies: here it just records
      // that it was asked for, and for which file.
      await syncFolder((await rememberedFolder())!, store, dialogs, async (id, file) => {
        localStorage.setItem('test:overwrote', `${id}|${file}`);
      });
      return seen;
    }, answer);
  }

  test('names the disk version in both answers', async ({ page }, testInfo) => {
    const ws = `clash-${testInfo.testId}`;
    await bothSidesDiffer(page, ws);

    const asked = await syncAnswering(page, 'nothing');
    expect(asked.message).toContain(`"${ws}" is in this browser and in ${ws}.edb`);
    expect(asked.message).toContain('which copy do you want to keep?');
    expect(asked.options).toEqual(['Load disk version', 'Overwrite disk version']);
  });

  /**
   * The numbers are the point: a name cannot tell two copies of `sales` apart, so
   * the prompt shows what each holds — and, for the copy nobody can see, how big
   * the file is and when it was last written.
   */
  test('shows what each copy holds, and what the file looks like', async ({ page }, testInfo) => {
    const ws = `clash-${testInfo.testId}`;
    await bothSidesDiffer(page, ws);

    const asked = await syncAnswering(page, 'nothing');
    expect(asked.message).toContain('In this browser: 1 table');
    expect(asked.message).toContain(`${ws}.edb: 2 tables`);
    // The file's own facts, which is the half of the answer the user cannot look up.
    expect(asked.message).toMatch(/, \d+ KB, saved /);
  });

  test('Overwrite disk version writes this browser copy out to the file', async ({ page }, testInfo) => {
    const ws = `clash-${testInfo.testId}`;
    await bothSidesDiffer(page, ws);

    await syncAnswering(page, 'Overwrite disk version');
    // The plugin's overwrite callback is what actually rewrites the file, so the
    // proof at this level is that the sync asked for it, naming the workspace and
    // the file.
    expect(await page.evaluate(() => localStorage.getItem('test:overwrote'))).toBe(`${ws}|${ws}.edb`);
  });
});
