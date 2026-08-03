import { describe, expect, it } from 'vitest';
import type { HostApi, ProjectionSpec, Row, Table } from '@easydb/shared';
import { copyTable } from '../../../packages/renderer/src/plugins/table-copy.js';

/** A store double: records what was inserted, serves rows for the original. */
function fakeApi(tables: Table[], rowsByTable: Record<string, Row[]> = {}) {
  const insertedTables: Table[] = [];
  const insertedRows: Row[] = [];
  const api = {
    workspaceId: () => 'ws',
    store: {
      tables: {
        find: () => Promise.resolve([...tables, ...insertedTables]),
        insert: (t: Table) => {
          insertedTables.push(t);
          return Promise.resolve(t);
        },
      },
      rows: (id: string) => ({
        find: () => Promise.resolve(rowsByTable[id] ?? []),
        bulkInsert: (docs: Row[]) => {
          insertedRows.push(...docs);
          return Promise.resolve(docs);
        },
      }),
    },
  } as unknown as HostApi;
  return { api, insertedTables, insertedRows };
}

const row = (tableId: string, id: string, data: Record<string, unknown>): Row => ({ id, tableId, data, updatedAt: 0 });

const plain: Table = {
  id: 't1',
  workspaceId: 'ws',
  name: 'People',
  code: 'people',
  columns: [
    { field: 'name', label: 'Name', type: 'string' },
    { field: 'secret', label: 'Secret', type: 'string', hidden: true },
  ],
  view: 'table',
  updatedAt: 0,
  filters: { name: 'a' },
  sortColumn: 'name',
  sortAsc: true,
};

const PLAIN_ROWS = [row('t1', 'r1', { name: 'Alice', secret: 'x' }), row('t1', 'r2', { name: 'Bob', secret: 'y' })];

const spec: ProjectionSpec = {
  version: 1,
  sources: [{ alias: 'p', tableName: 'People' }],
  columns: [{ field: 'who', from: { kind: 'source', alias: 'p', field: 'name' } }],
};

const projection: Table = {
  id: 't2',
  workspaceId: 'ws',
  name: 'Staff',
  code: 'staff',
  columns: [
    { field: 'who', label: 'Who', type: 'string' },
    { field: 'dept', label: 'Dept', type: 'string', readonly: true },
  ],
  view: 'table',
  updatedAt: 0,
  readonly: true,
  source: { type: 'projection', config: spec as unknown as Record<string, unknown> },
};

describe('copyTable: naming', () => {
  it('names the copy "<name> copy", uniqued against the workspace', async () => {
    const { api } = fakeApi([plain]);
    expect((await copyTable(api, plain, 'duplicate')).name).toBe('People copy');
  });

  it('does not collide with an existing copy', async () => {
    const { api } = fakeApi([plain, { ...plain, id: 'other', name: 'People copy' }]);
    expect((await copyTable(api, plain, 'duplicate')).name).toBe('People copy-2');
  });

  it('never reuses the original window position — that would look like nothing happened', async () => {
    const withGeom: Table = { ...plain, windowGeometry: { x: 10, y: 20, w: 300, h: 200, z: 5, minimized: false, maximized: false } };
    const { api } = fakeApi([withGeom]);
    expect((await copyTable(api, withGeom, 'duplicate')).windowGeometry).toBeUndefined();
  });
});

describe('copyTable: Duplicate', () => {
  it('copies a plain table with all its columns, rows and settings', async () => {
    const { api, insertedRows } = fakeApi([plain], { t1: PLAIN_ROWS });
    const copy = await copyTable(api, plain, 'duplicate');

    expect(copy.columns).toEqual(plain.columns); // hidden column included
    expect(copy.filters).toEqual({ name: 'a' });
    expect(copy.sortColumn).toBe('name');
    expect(insertedRows.map((r) => r.data)).toEqual(PLAIN_ROWS.map((r) => r.data));
    // Fresh row ids and the new table's id.
    expect(insertedRows.every((r) => r.tableId === copy.id)).toBe(true);
    expect(insertedRows.map((r) => r.id)).not.toEqual(['r1', 'r2']);
  });

  it('duplicates a projection as a projection, keeping the spec', async () => {
    const { api, insertedRows } = fakeApi([projection], { t2: [row('t2', 'a#0', { who: 'Alice' })] });
    const copy = await copyTable(api, projection, 'duplicate');

    expect(copy.source).toEqual(projection.source);
    expect(copy.readonly).toBe(true);
    // Its rows are recomputed from the sources, so copying them would be noise.
    expect(insertedRows).toEqual([]);
  });
});

describe('copyTable: Raw Data', () => {
  it('materializes a projection into a plain, editable table', async () => {
    const rows = [row('t2', 'a#0', { who: 'Alice', dept: 'Sales' })];
    const { api, insertedRows } = fakeApi([projection], { t2: rows });
    const copy = await copyTable(api, projection, 'raw');

    // The snapshot no longer tracks anything.
    expect(copy.source).toBeUndefined();
    expect(copy.readonly).toBeUndefined();
    // …and its cells are ordinary cells now, so the per-column readonly flag
    // a projection sets on joined columns must not survive.
    expect(copy.columns.every((c) => c.readonly === undefined)).toBe(true);
    expect(insertedRows.map((r) => r.data)).toEqual([{ who: 'Alice', dept: 'Sales' }]);
  });

  it('keeps every column including hidden ones, and the filters', async () => {
    const { api, insertedRows } = fakeApi([plain], { t1: PLAIN_ROWS });
    const copy = await copyTable(api, plain, 'raw');

    expect(copy.columns.map((c) => c.field)).toEqual(['name', 'secret']);
    // Raw keeps the filters as SETTINGS — the rows themselves are unfiltered,
    // so the copy opens showing what the original showed.
    expect(copy.filters).toEqual({ name: 'a' });
    expect(insertedRows).toHaveLength(2);
  });
});

describe('copyTable: Visible Data', () => {
  it('drops hidden columns and applies the filter to the rows', async () => {
    const { api, insertedRows } = fakeApi([plain], { t1: PLAIN_ROWS });
    const copy = await copyTable(api, plain, 'visible');

    expect(copy.columns.map((c) => c.field)).toEqual(['name']);
    // 'a' matches Alice only.
    expect(insertedRows.map((r) => r.data)).toEqual([{ name: 'Alice', secret: 'x' }]);
  });

  it('does NOT carry the filter over — the rows are already narrowed', async () => {
    // Carrying it would filter the copy a second time, hiding rows the user
    // just asked to keep.
    const { api } = fakeApi([plain], { t1: PLAIN_ROWS });
    const copy = await copyTable(api, plain, 'visible');
    expect(copy.filters).toBeUndefined();
    expect(copy.sortColumn).toBeUndefined();
  });
});

describe('copyTable: edge cases', () => {
  it('copies a table with no rows without inserting anything', async () => {
    const { api, insertedRows } = fakeApi([plain], {});
    await copyTable(api, plain, 'raw');
    expect(insertedRows).toEqual([]);
  });

  it('refuses without a workspace rather than writing a stray table', async () => {
    const { api } = fakeApi([plain]);
    (api as { workspaceId: () => string | null }).workspaceId = () => null;
    await expect(copyTable(api, plain, 'duplicate')).rejects.toThrow(/workspace/);
  });
});
