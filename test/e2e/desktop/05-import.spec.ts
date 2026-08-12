import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { closeDesktop, desktopDir, launchDesktop, readEdb, stubOpenDialog, writeForeignDb, type Desktop } from './desktop.js';

/**
 * Importing a plain SQLite file — someone else's database, not one of ours.
 *
 * This is the desktop's reason to exist for many users, and it is a genuinely
 * cross-process flow: the main process reads the source with its own connection,
 * the renderer resolves name collisions, and the rows are copied by a worker
 * thread. `test/electron/db-import.test.ts` covers the reading in isolation; only
 * a running app covers the sequence.
 *
 * Import is two-phase on purpose — preview, then commit — because a name clash
 * needs an answer the main process cannot invent. The specs drive both phases the
 * way `plugins/electron-db.ts` does.
 */
test.describe('import a foreign database', () => {
  let desktop: Desktop | null = null;

  test.afterEach(async () => {
    await closeDesktop(desktop);
    desktop = null;
  });

  test('previews the source, then copies its rows into real tables', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir, dbPath } = desktop;

    const source = join(dir, 'stock.db');
    writeForeignDb(source, 'parts', [
      { code: 'A1', qty: 5 },
      { code: 'B2', qty: 9 },
      { code: 'C3', qty: 0 },
    ]);

    // A file we did not write is `foreign`; Open refuses it and offers this path
    // instead, which is the guard `probeDatabaseFile` exists for.
    expect(await page.evaluate((p) => window.easydb!.db.probeDb(p), source)).toBe('foreign');

    const imported = await page.evaluate(async (sourcePath) => {
      const ctx = (window as unknown as { __easydb: { workspaceId: string } }).__easydb;
      const bridge = window.easydb!.db;
      // Phase 1: preview. Nothing is written yet.
      const preview = await bridge.importDb(ctx.workspaceId, sourcePath);
      if (!('preview' in preview)) throw new Error('import was cancelled');
      // Phase 2: create the tables empty, then fill each one.
      const plan = await bridge.importPrepare(sourcePath, ctx.workspaceId, {});
      const counts: number[] = [];
      for (const entry of plan.plan) counts.push(await bridge.importRows(sourcePath, entry));
      return { preview: preview.preview, plan, counts };
    }, source);

    expect(imported.preview.kind).toBe('foreign');
    expect(imported.preview.candidates.map((c) => [c.name, c.rowCount, c.collides])).toEqual([['parts', 3, false]]);
    expect(imported.counts).toEqual([3]);

    await closeDesktop(desktop);
    desktop = null;

    // The imported table is a real SQL table in OUR file, with columns taken from
    // the source's own — not a JSON blob of the foreign rows.
    const file = readEdb(dbPath);
    try {
      const doc = file.docs('tables').find((d) => d['name'] === 'parts')!;
      const sqlTable = String(doc['_sqlTable']);
      expect(file.columns(sqlTable)).toEqual(['_id', '_updatedAt', '_extra', 'code', 'qty']);
      expect(file.rows(sqlTable).map((r) => [r['code'], r['qty']])).toEqual([
        ['A1', 5],
        ['B2', 9],
        ['C3', 0],
      ]);
    } finally {
      file.close();
    }
  });

  test('a second import of the same name is reported as a collision', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;

    const source = join(dir, 'stock.db');
    writeForeignDb(source, 'parts', [{ code: 'A1', qty: 5 }]);

    const twice = await page.evaluate(async (sourcePath) => {
      const ctx = (window as unknown as { __easydb: { workspaceId: string } }).__easydb;
      const bridge = window.easydb!.db;
      const first = await bridge.importDb(ctx.workspaceId, sourcePath);
      if (!('preview' in first)) throw new Error('import was cancelled');
      const plan = await bridge.importPrepare(sourcePath, ctx.workspaceId, {});
      for (const entry of plan.plan) await bridge.importRows(sourcePath, entry);
      // Same file again — now the target workspace already holds `parts`.
      const second = await bridge.importDb(ctx.workspaceId, sourcePath);
      if (!('preview' in second)) throw new Error('import was cancelled');
      // Renaming is one of the four answers the renderer can give.
      const renamedPlan = await bridge.importPrepare(sourcePath, ctx.workspaceId, { parts: { action: 'rename', renameTo: 'parts (old)' } });
      for (const entry of renamedPlan.plan) await bridge.importRows(sourcePath, entry);
      const tables = (await window.easydb!.store.find('tables')) as Array<{ name: string }>;
      return { collides: second.preview.candidates.map((c) => c.collides), names: tables.map((t) => t.name).sort() };
    }, source);

    expect(twice.collides).toEqual([true]);
    expect(twice.names).toEqual(['parts', 'parts (old)']);
  });

  test('the file picker is used when no path is given', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dir } = desktop;

    const source = join(dir, 'picked.db');
    writeForeignDb(source, 'things', [{ label: 'one' }]);
    await stubOpenDialog(desktop, source);

    // No `sourcePath` argument: this is the menu route, where the OS dialog is
    // what names the file.
    const picked = await page.evaluate(async () => {
      const ctx = (window as unknown as { __easydb: { workspaceId: string } }).__easydb;
      return window.easydb!.db.importDb(ctx.workspaceId);
    });

    expect(picked).toMatchObject({ ok: true, path: source });
    expect('preview' in picked && picked.preview.candidates.map((c) => c.name)).toEqual(['things']);
  });
});
