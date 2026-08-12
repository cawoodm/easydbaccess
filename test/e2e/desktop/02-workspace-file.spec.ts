import { test, expect } from '@playwright/test';
import { bulkAddRows, createTable } from '../helpers.js';
import { closeDesktop, desktopDir, launchDesktop, readEdb, type Desktop } from './desktop.js';

/**
 * What the desktop app actually writes to disk.
 *
 * The claim the `.edb` format makes is that a workspace file is a genuine SQLite
 * database — user tables are real SQL tables with real columns, openable in DB
 * Browser or Datasette. These tests are the end-to-end form of that claim: the
 * app creates the data, then this test process opens the file with a plain
 * `node:sqlite` connection and no app code at all.
 *
 * They also pin the format. Until v0.0.355 the desktop wrote its own layout
 * (`_easydb_tables` plus a per-table `_easydb_meta_<name>`) which no browser
 * `.edb` could open; that layout is gone, and the assertions below fail if any of
 * it comes back.
 */
test.describe('the workspace file', () => {
  let desktop: Desktop | null = null;

  test.afterEach(async () => {
    await closeDesktop(desktop);
    desktop = null;
  });

  test('a table created in the app becomes a real SQL table', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dbPath } = desktop;

    const id = await createTable(page, 'Widgets', [{ field: 'name' }, { field: 'qty', type: 'number' }, { field: 'ok', type: 'boolean' }]);
    await bulkAddRows(page, id, [
      { name: 'Alpha', qty: 3, ok: true },
      { name: 'Beta', qty: 7, ok: false },
    ]);

    await closeDesktop(desktop);
    desktop = null;

    const file = readEdb(dbPath);
    try {
      // The table doc says which physical table holds the rows. Reading it rather
      // than recomputing `sanitizeTableName('Widgets')` is the point: the name is
      // assigned once and stored, and nothing outside the file should have to
      // guess it.
      const tables = file.docs('tables');
      expect(tables).toHaveLength(1);
      const doc = tables[0]!;
      expect(doc['name']).toBe('Widgets');
      const sqlTable = String(doc['_sqlTable']);

      // A column per ColumnSpec, plus the three bookkeeping columns.
      expect(file.columns(sqlTable)).toEqual(['_id', '_updatedAt', '_extra', 'name', 'qty', 'ok']);

      const rows = file.rows(sqlTable).sort((a, b) => String(a['name']).localeCompare(String(b['name'])));
      expect(rows.map((r) => [r['name'], r['qty'], r['ok']])).toEqual([
        ['Alpha', 3, 1],
        ['Beta', 7, 0],
      ]);
      // Nothing overflowed, so `_extra` is SQL NULL rather than the string '{}'.
      expect(rows.map((r) => r['_extra'])).toEqual([null, null]);
    } finally {
      file.close();
    }
  });

  test('the file carries the v2 format stamp and none of the v1 layout', async () => {
    desktop = await launchDesktop(desktopDir());
    await createTable(desktop.page, 'Parts', [{ field: 'code' }]);
    const dbPath = desktop.dbPath;

    await closeDesktop(desktop);
    desktop = null;

    const file = readEdb(dbPath);
    try {
      expect(file.docs('_meta')).toEqual([{ version: 2, app: 'easydbaccess' }]);

      const names = file.objects.filter((o) => o.type === 'table').map((o) => o.name);
      // One metadata table, one user table. The v1 layout would add
      // `_easydb_tables`, `_easydb_docs` and `_easydb_meta_Parts`.
      expect(names).toContain('_easydb');
      expect(names).toContain('Parts');
      expect(names.filter((n) => n.startsWith('_easydb_meta_'))).toEqual([]);
      expect(names).not.toContain('_easydb_tables');
      expect(names).not.toContain('_easydb_docs');
    } finally {
      file.close();
    }
  });

  test('keys with no column of their own go to _extra, not away', async () => {
    desktop = await launchDesktop(desktopDir());
    const { page, dbPath } = desktop;

    const id = await createTable(page, 'Notes', [{ field: 'title' }]);
    await bulkAddRows(page, id, [{ title: 'First', tag: 'urgent', seen: 2 }]);

    // Read it back through the app first. A row that round-trips must look exactly
    // like the one that went in — the overflow is storage, not a visible change.
    const readBack = await page.evaluate(async (tableId) => {
      const ctx = (window as unknown as { __easydb: { store: { rows(id: string): { find(): Promise<Array<{ data: Record<string, unknown> }>> } } } }).__easydb;
      return (await ctx.store.rows(tableId).find()).map((r) => r.data);
    }, id);
    expect(readBack).toEqual([{ title: 'First', tag: 'urgent', seen: 2 }]);

    await closeDesktop(desktop);
    desktop = null;

    const file = readEdb(dbPath);
    try {
      const sqlTable = String(file.docs('tables')[0]!['_sqlTable']);
      expect(file.columns(sqlTable)).toEqual(['_id', '_updatedAt', '_extra', 'title']);
      const row = file.rows(sqlTable)[0]!;
      expect(row['title']).toBe('First');
      expect(JSON.parse(String(row['_extra']))).toEqual({ tag: 'urgent', seen: 2 });
    } finally {
      file.close();
    }
  });
});
