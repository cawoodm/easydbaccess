import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ColumnSpec, Table } from '../../packages/shared/src/types.js';
import { EdbStore } from '../../packages/shared/src/edb-store.js';
import { nodeSqliteDriver } from './node-sqlite-driver.js';

/**
 * The two reads that let one copy of a workspace be compared with another.
 *
 * They exist because a comparison must be affordable BEFORE the user has asked
 * for anything: a folder sync would otherwise have to read every row of every
 * file to answer "is this different". So both answer in aggregates and ids, and
 * neither returns a row.
 */

let driver: ReturnType<typeof nodeSqliteDriver>;
let store: EdbStore;

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'qty', label: 'Qty', type: 'number' },
];

function table(over: Partial<Table> = {}): Record<string, unknown> {
  return { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1000, ...over } as unknown as Record<string, unknown>;
}

function row(id: string, updatedAt: number, tableId = 't1'): Record<string, unknown> {
  return { id, tableId, data: { name: id }, updatedAt };
}

beforeEach(() => {
  driver = nodeSqliteDriver();
  store = new EdbStore(driver);
});

afterEach(() => {
  driver.close();
});

describe('tableStamps', () => {
  it('reports the document stamp, the row count and the newest row', () => {
    store.insert('tables', table());
    store.bulkInsert('rows', [row('r1', 500), row('r2', 9000), row('r3', 700)]);

    expect(store.tableStamps('w1')).toEqual([{ id: 't1', name: 'Parts', updatedAt: 1000, rows: 3, lastRowAt: 9000 }]);
  });

  it('gives an empty table a zero row stamp rather than leaving it out', () => {
    store.insert('tables', table());
    expect(store.tableStamps('w1')).toEqual([{ id: 't1', name: 'Parts', updatedAt: 1000, rows: 0, lastRowAt: 0 }]);
  });

  it('answers for one workspace only', () => {
    store.insert('tables', table());
    store.insert('tables', table({ id: 't2', workspaceId: 'w2', name: 'Other' }));
    expect(store.tableStamps('w1').map((t) => t.id)).toEqual(['t1']);
    expect(store.tableStamps('w2').map((t) => t.id)).toEqual(['t2']);
  });

  it('sees a row edit that never touched the table document', () => {
    // The whole reason the row stamp is reported beside the document's own:
    // editing a cell writes the row, not the table.
    store.insert('tables', table());
    store.insert('rows', row('r1', 500));
    const before = store.tableStamps('w1')[0];

    store.patch('rows', 'r1', { data: { name: 'changed' }, updatedAt: 8000 });

    const after = store.tableStamps('w1')[0];
    expect(before?.updatedAt).toBe(after?.updatedAt);
    expect(after?.lastRowAt).toBe(8000);
  });

  it('counts a table whose physical table has gone as empty, not as an error', () => {
    // Raw SQL can drop one. This read answers what is THERE; a table nobody can
    // read is a difference to show, not a reason to abandon the comparison.
    store.insert('tables', table());
    store.insert('rows', row('r1', 500));
    driver.exec(`DROP TABLE "Parts"`);

    expect(store.tableStamps('w1')).toEqual([{ id: 't1', name: 'Parts', updatedAt: 1000, rows: 0, lastRowAt: 0 }]);
  });

  it('has nothing to say about a workspace with no tables', () => {
    expect(store.tableStamps('nobody')).toEqual([]);
  });
});

describe('rowStamps', () => {
  it('returns an id and a timestamp per row, and nothing else', () => {
    store.insert('tables', table());
    store.bulkInsert('rows', [row('r1', 100), row('r2', 200)]);

    const stamps = store.rowStamps('t1');
    expect(stamps).toHaveLength(2);
    expect(new Map(stamps.map((s) => [s.id, s.updatedAt]))).toEqual(new Map([
      ['r1', 100],
      ['r2', 200],
    ]));
    // No contents: reading them is what the comparison exists to avoid.
    expect(Object.keys(stamps[0] ?? {}).sort()).toEqual(['id', 'updatedAt']);
  });

  it('answers empty for a table that is not registered', () => {
    expect(store.rowStamps('nope')).toEqual([]);
  });
});
