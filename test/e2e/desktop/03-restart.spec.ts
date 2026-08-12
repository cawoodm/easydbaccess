import { test, expect } from '@playwright/test';
import { bulkAddRows, createTable } from '../helpers.js';
import { closeDesktop, desktopDir, launchDesktop, type Desktop } from './desktop.js';

/**
 * The workspace survives closing the app.
 *
 * On the desktop there is no Save: every write goes straight into the SQLite file
 * through IPC. So the test for persistence is simply to quit and come back.
 *
 * `test/electron/sqlite-store.test.ts` already covers close-and-reopen on the
 * store class. What only a launched app can show is that the whole stack agrees
 * on it: the store singleton `db-files.ts` builds, the IPC bridge, and
 * `app-context.ts` resolving the SAME workspace out of the reopened file. The
 * `tables` collection is workspace-scoped, so a second workspace created beside
 * the first would show up here as an empty list.
 */
test.describe('restart', () => {
  let desktop: Desktop | null = null;

  test.afterEach(async () => {
    await closeDesktop(desktop);
    desktop = null;
  });

  test('tables and rows come back after a quit', async () => {
    const dir = desktopDir();

    desktop = await launchDesktop(dir);
    const id = await createTable(desktop.page, 'Widgets', [{ field: 'name' }, { field: 'qty', type: 'number' }]);
    await bulkAddRows(desktop.page, id, [
      { name: 'Alpha', qty: 3 },
      { name: 'Beta', qty: 7 },
    ]);
    await closeDesktop(desktop);

    // Same directory, so the same workspace file — the restart a user would do.
    desktop = await launchDesktop(dir);

    const reopened = await desktop.page.evaluate(async () => {
      const ctx = (
        window as unknown as {
          __easydb: {
            store: {
              tables: { find(): Promise<Array<{ id: string; name: string; columns: Array<{ field: string }> }>> };
              rows(id: string): { find(): Promise<Array<{ data: Record<string, unknown> }>> };
            };
          };
        }
      ).__easydb;
      const tables = await ctx.store.tables.find();
      const first = tables[0]!;
      return {
        names: tables.map((t) => t.name),
        fields: first.columns.map((c) => c.field),
        rows: (await ctx.store.rows(first.id).find()).map((r) => r.data),
      };
    });

    expect(reopened.names).toEqual(['Widgets']);
    expect(reopened.fields).toEqual(['name', 'qty']);
    // Insertion order: the rows are read back with a SQL scan of one table, not
    // through an index keyed on random UUIDs the way Dexie does it.
    expect(reopened.rows).toEqual([
      { name: 'Alpha', qty: 3 },
      { name: 'Beta', qty: 7 },
    ]);
  });

  test('a column added after the first run does not disturb the existing rows', async () => {
    const dir = desktopDir();

    desktop = await launchDesktop(dir);
    const id = await createTable(desktop.page, 'Widgets', [{ field: 'name' }]);
    await bulkAddRows(desktop.page, id, [{ name: 'Alpha' }]);
    await closeDesktop(desktop);

    desktop = await launchDesktop(dir);
    // Editing the columns is what triggers reconciliation — `ALTER TABLE … ADD
    // COLUMN` for the new field, and nothing at all for the old one.
    await desktop.page.evaluate(async (tableId) => {
      const ctx = (
        window as unknown as {
          __easydb: { store: { tables: { findOne(id: string): Promise<{ columns: unknown[] } | null>; patch(id: string, p: Record<string, unknown>): Promise<unknown> } } };
        }
      ).__easydb;
      const table = await ctx.store.tables.findOne(tableId);
      await ctx.store.tables.patch(tableId, { columns: [...table!.columns, { field: 'qty', label: 'qty', type: 'number' }] });
    }, id);
    await bulkAddRows(desktop.page, id, [{ name: 'Beta', qty: 7 }]);

    const rows = await desktop.page.evaluate(async (tableId) => {
      const ctx = (window as unknown as { __easydb: { store: { rows(id: string): { find(): Promise<Array<{ data: Record<string, unknown> }>> } } } }).__easydb;
      return (await ctx.store.rows(tableId).find()).map((r) => r.data);
    }, id);

    // The pre-existing row keeps its value and simply has no `qty` — a column
    // added later is NULL for it, and a decoded NULL is omitted rather than
    // written in as `null`.
    expect(rows).toEqual([{ name: 'Alpha' }, { name: 'Beta', qty: 7 }]);
  });
});
