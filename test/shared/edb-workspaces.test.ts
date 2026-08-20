import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ColumnSpec, Row, Table, ViewInstance, ViewTemplate } from '../../packages/shared/src/types.js';
import { EdbStore } from '../../packages/shared/src/edb-store.js';
import { settingId } from '../../packages/shared/src/setting-key.js';
import { nodeSqliteDriver } from './node-sqlite-driver.js';

/**
 * Whole-workspace operations.
 *
 * These live on the store because `DataStore` cannot express them: its
 * `settings` view is scoped to the ACTIVE workspace, so nothing above this
 * layer can see another workspace's settings at all. The behaviour pinned here
 * is what the Dexie implementations guaranteed — a clone that does not alias its
 * source, and a delete that leaves nothing behind for a same-named workspace to
 * inherit.
 */

let driver: ReturnType<typeof nodeSqliteDriver>;
let store: EdbStore;

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'qty', label: 'Qty', type: 'number' },
];

function seedWorkspace(id: string, opts: { tables?: number; rows?: number } = {}): void {
  store.upsert('workspaces', { id, name: id, createdAt: 1, pluginUrls: [`https://example.test/${id}.js`] });
  for (let t = 0; t < (opts.tables ?? 1); t++) {
    const tableId = `${id}-t${t}`;
    store.insert('tables', { id: tableId, workspaceId: id, name: `Parts${t}`, columns: COLUMNS, updatedAt: 1 });
    const rows = Array.from({ length: opts.rows ?? 0 }, (_, i) => ({ id: `${tableId}-r${i}`, tableId, data: { name: `p${i}`, qty: i }, updatedAt: 1 }));
    if (rows.length > 0) store.bulkInsert('rows', rows);
  }
  store.upsert('settings', { key: settingId(id, 'server'), workspaceId: id, name: 'server', value: `https://${id}.test` });
}

beforeEach(() => {
  driver = nodeSqliteDriver();
  store = new EdbStore(driver);
});

afterEach(() => {
  driver.close();
});

describe('countWorkspaceContents', () => {
  it('counts each collection for the workspace asked about, and no other', () => {
    seedWorkspace('a', { tables: 2, rows: 3 });
    seedWorkspace('b', { tables: 5, rows: 9 });
    store.upsert('viewTemplates', { id: 'vt1', workspaceId: 'a', name: 'T' });
    store.upsert('viewInstances', { id: 'vi1', workspaceId: 'a', tableId: 'a-t0', templateId: 'vt1' });

    expect(store.countWorkspaceContents('a', { countRows: true })).toEqual({ tables: 2, rows: 6, views: 1, templates: 1, settings: 1 });
  });

  it('reports -1 rows when the caller did not ask to count them', () => {
    seedWorkspace('a', { tables: 1, rows: 4 });
    expect(store.countWorkspaceContents('a').rows).toBe(-1);
  });

  it('counts an unknown workspace as empty rather than throwing', () => {
    expect(store.countWorkspaceContents('nope', { countRows: true })).toEqual({ tables: 0, rows: 0, views: 0, templates: 0, settings: 0 });
  });
});

describe('deleteWorkspace', () => {
  beforeEach(() => {
    seedWorkspace('doomed', { tables: 2, rows: 3 });
    seedWorkspace('keeper', { tables: 1, rows: 2 });
    store.upsert('viewTemplates', { id: 'vt1', workspaceId: 'doomed', name: 'T' });
    store.upsert('viewInstances', { id: 'vi1', workspaceId: 'doomed', tableId: 'doomed-t0', templateId: 'vt1' });
  });

  it('reports what it removed, rows included', () => {
    expect(store.deleteWorkspace('doomed')).toEqual({ tables: 2, rows: 6, views: 1, templates: 1, settings: 1 });
  });

  it('takes the tables and their rows', () => {
    store.deleteWorkspace('doomed');
    expect(store.find('tables', { workspaceId: 'doomed' })).toEqual([]);
    expect(store.countRowsIn('doomed-t0')).toBe(0);
    // Dropping the table takes its rows with it — there is no orphaned SQL table.
    expect(store.runSql(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Parts0'`).rows).toEqual([]);
  });

  it('leaves NO settings behind for a same-named workspace to inherit', () => {
    // Workspace ids are slugified names, so recreating "doomed" reuses this id.
    store.deleteWorkspace('doomed');
    expect(store.find('settings', { workspaceId: 'doomed' })).toEqual([]);
    expect(store.findOne('settings', settingId('doomed', 'server'))).toBeNull();
  });

  it('takes its views and templates', () => {
    store.deleteWorkspace('doomed');
    expect(store.find('viewInstances', { workspaceId: 'doomed' })).toEqual([]);
    expect(store.find('viewTemplates', { workspaceId: 'doomed' })).toEqual([]);
  });

  it('removes the workspace record itself', () => {
    store.deleteWorkspace('doomed');
    expect(store.findOne('workspaces', 'doomed')).toBeNull();
  });

  it('does not touch a neighbouring workspace', () => {
    store.deleteWorkspace('doomed');
    expect(store.countWorkspaceContents('keeper', { countRows: true })).toEqual({ tables: 1, rows: 2, views: 0, templates: 0, settings: 1 });
  });
});

describe('cloneWorkspace', () => {
  beforeEach(() => {
    seedWorkspace('src', { tables: 1, rows: 3 });
    store.upsert('viewTemplates', { id: 'vt1', workspaceId: 'src', name: 'T' });
    store.upsert('viewInstances', { id: 'vi1', workspaceId: 'src', tableId: 'src-t0', templateId: 'vt1' });
  });

  it('empty takes nothing, not even the plugin list', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'empty' });
    expect(store.countWorkspaceContents('copy', { countRows: true })).toEqual({ tables: 0, rows: 0, views: 0, templates: 0, settings: 0 });
    expect((store.findOne('workspaces', 'copy') as { pluginUrls: string[] }).pluginUrls).toEqual([]);
  });

  it('settings takes the settings and the plugin list, but no data', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'settings' });
    const counts = store.countWorkspaceContents('copy', { countRows: true });
    expect(counts).toEqual({ tables: 0, rows: 0, views: 0, templates: 0, settings: 1 });
    expect((store.findOne('workspaces', 'copy') as { pluginUrls: string[] }).pluginUrls).toEqual(['https://example.test/src.js']);
  });

  it('all takes tables, rows, templates and views', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    expect(store.countWorkspaceContents('copy', { countRows: true })).toEqual({ tables: 1, rows: 3, views: 1, templates: 1, settings: 1 });
  });

  it('re-keys the settings so the copy owns them', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'settings' });
    expect(store.findOne('settings', settingId('copy', 'server'))).toMatchObject({ workspaceId: 'copy', name: 'server', value: 'https://src.test' });
    // The source keeps its own.
    expect(store.findOne('settings', settingId('src', 'server'))).not.toBeNull();
  });

  it('gives every copied record a fresh id, so nothing is shared with the source', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    const copied = store.find('tables', { workspaceId: 'copy' }) as Table[];
    expect(copied).toHaveLength(1);
    expect(copied[0]!.id).not.toBe('src-t0');

    const rows = store.find('rows', { tableId: copied[0]!.id }) as Row[];
    expect(rows).toHaveLength(3);
    // A copied row that still carried the source's row id would make the row
    // ambiguous across both workspaces.
    expect(rows.map((r) => r.id).some((id) => id.startsWith('src-t0-r'))).toBe(false);
  });

  it('re-points copied rows at the copied table, so they show in one workspace only', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    expect(store.countRowsIn('src-t0')).toBe(3);
    const copiedId = (store.find('tables', { workspaceId: 'copy' }) as Table[])[0]!.id;
    expect(store.countRowsIn(copiedId)).toBe(3);
  });

  it('copies the row DATA, not just the count', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    const copiedId = (store.find('tables', { workspaceId: 'copy' }) as Table[])[0]!.id;
    const data = (store.find('rows', { tableId: copiedId }) as Row[]).map((r) => r.data).sort((a, b) => Number(a.qty) - Number(b.qty));
    expect(data).toEqual([
      { name: 'p0', qty: 0 },
      { name: 'p1', qty: 1 },
      { name: 'p2', qty: 2 },
    ]);
  });

  it('gives the copy its own physical SQL table rather than aliasing the source', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    const names = store.runSql(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Parts%' ORDER BY name`).rows.flat();
    expect(names).toHaveLength(2);
  });

  it('re-points a copied view at the copied table and template', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    const copiedTable = (store.find('tables', { workspaceId: 'copy' }) as Table[])[0]!.id;
    const copiedTemplate = (store.find('viewTemplates', { workspaceId: 'copy' }) as ViewTemplate[])[0]!.id;
    const view = (store.find('viewInstances', { workspaceId: 'copy' }) as ViewInstance[])[0]!;
    expect(view.tableId).toBe(copiedTable);
    expect(view.templateId).toBe(copiedTemplate);
    expect(view.id).not.toBe('vi1');
  });

  it('skips a view whose table did not come along, rather than leaving it dangling', () => {
    store.upsert('viewInstances', { id: 'vi2', workspaceId: 'src', tableId: 'gone', templateId: 'vt1' });
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    expect(store.find('viewInstances', { workspaceId: 'copy' })).toHaveLength(1);
  });

  it('never deletes from the source — the copy is additive', () => {
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    expect(store.countWorkspaceContents('src', { countRows: true })).toEqual({ tables: 1, rows: 3, views: 1, templates: 1, settings: 1 });
  });

  it('copies a table whose spec lost a column, without the orphaned SQL column', () => {
    // Reconciliation is additive-only, so dropping a field from `columns` leaves
    // its SQL column behind. The copy is built from the current spec list, so
    // only the columns both tables have can be carried across.
    store.upsert('tables', { id: 'src-t0', workspaceId: 'src', name: 'Parts0', columns: [COLUMNS[0]!], updatedAt: 2 });
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    const copiedId = (store.find('tables', { workspaceId: 'copy' }) as Table[])[0]!.id;
    expect(store.countRowsIn(copiedId)).toBe(3);
    expect((store.find('rows', { tableId: copiedId }) as Row[])[0]!.data).toHaveProperty('name');
  });
});

describe('a clone keeps what other things bind to', () => {
  beforeEach(() => {
    seedWorkspace('src', { tables: 1, rows: 2 });
  });

  it('keeps the logical table name \u2014 projections and views bind BY NAME', () => {
    // Only the PHYSICAL name (`_sqlTable`) is uniqued. If the logical name moved,
    // every name-bound projection in the copy would silently resolve to nothing.
    store.cloneWorkspace({ from: 'src', to: 'copy', name: 'Copy', mode: 'all' });
    const copied = store.find('tables', { workspaceId: 'copy' }) as Table[];
    expect(copied.map((t) => t.name)).toEqual(['Parts0']);
  });
});
