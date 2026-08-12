import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { bulkAddRows, createTable } from '../helpers.js';
import { closeDesktop, desktopDir, launchDesktop, readEdb, stubSaveDialog, type Desktop } from './desktop.js';

/**
 * Save As, including the part of it that surprises people.
 *
 * Two behaviours worth pinning, and neither is reachable from the vitest suites
 * because both live in `db-files.ts`, which imports `electron`:
 *
 * 1. The copy is complete. The store runs in WAL mode, so a committed row can be
 *    sitting in the `-wal` sidecar while `copyDatabase` copies only the `.db`.
 * 2. Writes follow the new file. Save As repoints the active store, the same as
 *    Save As in a text editor — the alternative, copying but continuing to write
 *    to the original, leaves the user editing a file they think they left.
 *
 * What this does NOT isolate is `saveDbAs`'s explicit `checkpoint()` call.
 * Measured: deleting that line keeps both tests green, because `close()`
 * checkpoints too and Save As closes before it copies. The explicit one earns its
 * place in the case this suite cannot stage — a second connection (the import
 * worker) still holding the file, where closing does not checkpoint.
 */
test.describe('Save As', () => {
  let desktop: Desktop | null = null;

  test.afterEach(async () => {
    await closeDesktop(desktop);
    desktop = null;
  });

  test('writes a complete copy and then writes to it', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;
    const target = join(dir, 'saved-copy.edb');

    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await bulkAddRows(page, id, [{ name: 'Alpha' }]);

    await stubSaveDialog(desktop, target);
    const result = await page.evaluate(() => window.easydb!.db.saveDbAs());
    expect(result).toMatchObject({ ok: true, path: target });
    expect(existsSync(target)).toBe(true);

    // The store now points at the copy, so this row can only land there.
    expect(await page.evaluate(() => window.easydb!.store.dbPath())).toBe(target);
    await bulkAddRows(page, id, [{ name: 'Beta' }]);

    await closeDesktop(desktop);
    desktop = null;

    const copy = readEdb(target);
    try {
      const sqlTable = String(copy.docs('tables')[0]!['_sqlTable']);
      // Alpha was written before Save As, so the copy carried it; Beta after, so
      // the store had repointed. A copy that lost Alpha, or an app still writing
      // Beta to the original, each fail here.
      expect(copy.rows(sqlTable).map((r) => r['name'])).toEqual(['Alpha', 'Beta']);
    } finally {
      copy.close();
    }
  });

  test('a cancelled dialog changes nothing', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dbPath } = desktop;

    await createTable(page, 'Widgets', [{ field: 'name' }]);
    await stubSaveDialog(desktop, null);

    const result = await page.evaluate(() => window.easydb!.db.saveDbAs());
    expect(result).toEqual({ ok: false, cancelled: true });
    // Still on the original file — a cancel must not close or repoint the store.
    expect(await page.evaluate(() => window.easydb!.store.dbPath())).toBe(dbPath);
    expect(await page.evaluate(async () => (await window.easydb!.store.find('tables')).length)).toBe(1);
  });
});
