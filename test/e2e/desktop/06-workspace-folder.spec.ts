import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { closeDesktop, desktopDir, launchDesktop, stubFolderDialog, writeEdbWorkspace, type Desktop } from './desktop.js';

/**
 * The workspace folder on the desktop.
 *
 * The browser has connected a folder of `.edb` files since v0.0.404. This is the
 * same feature in the desktop build, reaching the same dialog and the same
 * header selector through the main process — see
 * `.claude/plans/2026-09-23-desktop-workspace-folder.md`.
 *
 * What only a running app can show, and what these specs are for:
 *
 * - The scan is READ-ONLY. It opens every file in the folder and must leave each
 *   one exactly as it was.
 * - A file the device switched off is named but never opened.
 * - The index the scan writes is the one the workspace selector reads, so the
 *   folder's workspaces appear in the list beside the open file's.
 * - Picking one switches the whole store to that file.
 *
 * `test/renderer/plugins/electron-folder.test.ts` covers the translation between
 * scan and index on its own, and `test/electron/db-folder.test.ts` covers the
 * scan itself. Neither can see the two halves meet.
 */

/** The localStorage key `db/edb/folder-index.ts` keeps the device-local index under. */
const INDEX_KEY = 'eda:folderIndex';

/** A folder of two workspace files, neither of which the app has ever opened. */
function makeFolder(dir: string): string {
  const folder = join(dir, 'spaces');
  mkdirSync(folder, { recursive: true });
  writeEdbWorkspace(join(folder, 'sales.edb'), 'sales', { name: 'sales', title: 'Sales', tables: ['orders', 'customers'] });
  writeEdbWorkspace(join(folder, 'archive.edb'), 'archive', { name: 'archive' });
  return folder;
}

test.describe('the workspace folder', () => {
  let desktop: Desktop | null = null;

  test.afterEach(async () => {
    await closeDesktop(desktop);
    desktop = null;
  });

  test('connecting a folder lists every .edb in it, with what each holds', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);

    const picked = await page.evaluate(() => window.easydb!.db.pickFolder!());
    expect(picked).toBe(folder);

    const scan = await page.evaluate(() => window.easydb!.db.scanFolder!());
    expect(scan).not.toBeNull();
    expect(scan!.folder).toBe('spaces');
    expect(scan!.files.map((f) => f.file)).toEqual(['archive.edb', 'sales.edb']);

    // The peek read each file's own metadata — the workspace, its display title
    // and how many tables are in it.
    const sales = scan!.files.find((f) => f.file === 'sales.edb')!;
    expect(sales.workspaces).toEqual([{ id: 'sales', name: 'sales', title: 'Sales', tables: 2, views: 0 }]);
    expect(sales.size).toBeGreaterThan(0);
  });

  test('a file the device switched off is named but never opened', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);
    await page.evaluate(() => window.easydb!.db.pickFolder!());

    const scan = await page.evaluate(() => window.easydb!.db.scanFolder!(['sales.edb']));
    // Both are listed. The dialog has to show the switched-off one, or there
    // would be no way to switch it back on.
    expect(scan!.files.map((f) => f.file)).toEqual(['archive.edb', 'sales.edb']);
    // Only the ticked one was opened.
    expect(scan!.files.find((f) => f.file === 'archive.edb')!.workspaces).toEqual([]);
    expect(scan!.files.find((f) => f.file === 'sales.edb')!.workspaces).toHaveLength(1);
  });

  test('the folder reaches the workspace selector through the device index', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);

    // Connect, then run the same rescan the boot and the Sync command run.
    await page.evaluate(() => window.easydb!.db.pickFolder!());
    await page.evaluate(async (key) => {
      const scan = await window.easydb!.db.scanFolder!();
      if (!scan) throw new Error('no folder connected');
      const workspaces = scan.files.flatMap((f) => f.workspaces.map((w) => ({ ...w, file: f.file, size: f.size, mtime: f.mtime })));
      localStorage.setItem(key, JSON.stringify({ folder: scan.folder, at: scan.at, files: scan.files.map((f) => f.file), workspaces }));
    }, INDEX_KEY);

    const index = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as { workspaces: Array<{ id: string; file: string }> } | null, INDEX_KEY);
    expect(index).not.toBeNull();
    // Each workspace knows its file. That pair is what the selector keys an
    // option on — two files can hold workspaces of the same name.
    expect(index!.workspaces.map((w) => [w.id, w.file]).sort()).toEqual([
      ['archive', 'archive.edb'],
      ['sales', 'sales.edb'],
    ]);
  });

  test('opening one of the folder files switches the whole store to it', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);
    await page.evaluate(() => window.easydb!.db.pickFolder!());

    const target = await page.evaluate(() => window.easydb!.db.folderFilePath!('sales.edb'));
    expect(target).toBe(join(folder, 'sales.edb'));
    // The file is ours, so it may be opened. A foreign one could not be — Open
    // would add our bookkeeping table to somebody else's database.
    expect(await page.evaluate((p) => window.easydb!.db.probeDb(p!), target)).toBe('easydb');

    await page.evaluate((p) => window.easydb!.db.openDbCommit(p!), target);
    // The main process reloads the window onto the new file.
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 30_000 });
    expect(await page.evaluate(() => window.easydb!.db.currentDb())).toMatchObject({ path: join(folder, 'sales.edb') });

    // The workspace on screen is the one that was in the file, with its tables.
    const shown = await page.evaluate(() => {
      const ctx = (window as unknown as { __easydb: { workspaceId: string } }).__easydb;
      return ctx.workspaceId;
    });
    expect(shown).toBe('sales');

    // The file the app now HAS OPEN must still scan. A live workspace file has a
    // `-wal` beside it, and a read-only open can refuse one of those — which
    // would leave the Local Data dialog showing "not read yet" against the one
    // row it marks "open".
    const rescan = await page.evaluate(() => window.easydb!.db.scanFolder!());
    expect(rescan!.files.find((f) => f.file === 'sales.edb')!.workspaces.map((w) => w.id)).toEqual(['sales']);
  });

  test('switching file drops a ?space= left over from the last one', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);
    await page.evaluate(() => window.easydb!.db.pickFolder!());

    // What switching workspace inside the open file leaves in the URL. It is
    // never taken out again, so the next reload re-requests it.
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set('space', 'workspace');
      history.replaceState(null, '', url.toString());
    });

    const target = await page.evaluate(() => window.easydb!.db.folderFilePath!('sales.edb'));
    await page.evaluate((p) => window.easydb!.db.openDbCommit(p!), target);
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 30_000 });

    // The parameter is gone, and the workspace is the file's own — not an empty
    // `workspace` created inside `sales.edb` because the URL asked for one.
    expect(await page.evaluate(() => new URL(location.href).searchParams.get('space'))).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { __easydb: { workspaceId: string } }).__easydb.workspaceId)).toBe('sales');
  });

  test('a new workspace can be given its own file in the folder', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);
    await page.evaluate(() => window.easydb!.db.pickFolder!());

    const written = await page.evaluate(() => window.easydb!.db.newWorkspaceFile!('q3', 'Q3 numbers'));
    expect(written).toBe(join(folder, 'q3.edb'));

    // It is in the folder from the next scan on, with the name the user typed.
    const scan = await page.evaluate(() => window.easydb!.db.scanFolder!());
    expect(scan!.files.map((f) => f.file)).toEqual(['archive.edb', 'q3.edb', 'sales.edb']);
    expect(scan!.files.find((f) => f.file === 'q3.edb')!.workspaces).toEqual([{ id: 'q3', name: 'Q3 numbers', tables: 0, views: 0 }]);
  });

  test('disconnecting leaves every file where it is', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const folder = makeFolder(dir);
    await stubFolderDialog(desktop, folder);
    await page.evaluate(() => window.easydb!.db.pickFolder!());
    expect(await page.evaluate(() => window.easydb!.db.folder!())).toBe(folder);

    await page.evaluate(() => window.easydb!.db.forgetFolder!());
    expect(await page.evaluate(() => window.easydb!.db.folder!())).toBeNull();
    expect(await page.evaluate(() => window.easydb!.db.scanFolder!())).toBeNull();

    // Only the grant went. Reconnecting finds the same two files.
    await page.evaluate(() => window.easydb!.db.pickFolder!());
    const scan = await page.evaluate(() => window.easydb!.db.scanFolder!());
    expect(scan!.files.map((f) => f.file)).toEqual(['archive.edb', 'sales.edb']);
  });
});
