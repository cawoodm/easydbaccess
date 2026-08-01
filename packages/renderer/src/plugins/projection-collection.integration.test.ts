import { describe, expect, it, vi } from 'vitest';
import type { DataCollection, DataStore, Row, Table, Unsubscribe } from '@easydb/shared';
import { createProjectionCollection, ProjectionReadOnlyError } from './projection-collection.js';

// A tiny reactive in-memory store — enough of the DataStore surface for the
// projection collection (tables.find/subscribe, rows().find/findOne/subscribe/patch).
function memStore(): { store: DataStore; addTable: (t: Table) => void; addRow: (r: Row) => void } {
  const tables: Table[] = [];
  const rows: Row[] = [];
  const tableSubs = new Set<() => void>();
  const rowSubs = new Set<() => void>();
  const notifyTables = () => tableSubs.forEach((f) => f());
  const notifyRows = () => rowSubs.forEach((f) => f());

  const rowsView = (tableId: string): DataCollection<Row> =>
    ({
      async find() {
        return rows.filter((r) => r.tableId === tableId);
      },
      async findOne(id: string) {
        return rows.find((r) => r.id === id && r.tableId === tableId) ?? null;
      },
      async patch(id: string, patch: Partial<Row>) {
        const r = rows.find((x) => x.id === id);
        if (!r) throw new Error(`no row ${id}`);
        Object.assign(r, patch);
        notifyRows();
        return r;
      },
      subscribe(fn: (docs: Row[]) => void): Unsubscribe {
        const run = () => fn(rows.filter((r) => r.tableId === tableId));
        rowSubs.add(run);
        run();
        return () => rowSubs.delete(run);
      },
    }) as unknown as DataCollection<Row>;

  const store = {
    tables: {
      async find(query?: Partial<Table>) {
        if (!query || Object.keys(query).length === 0) return [...tables];
        return tables.filter((t) =>
          Object.entries(query).every(
            ([k, v]) => (t as unknown as Record<string, unknown>)[k] === v,
          ),
        );
      },
      subscribe(fn: (docs: Table[]) => void): Unsubscribe {
        const run = () => fn([...tables]);
        tableSubs.add(run);
        run();
        return () => tableSubs.delete(run);
      },
    },
    rows: rowsView,
  } as unknown as DataStore;

  return {
    store,
    addTable: (t) => {
      tables.push(t);
      notifyTables();
    },
    addRow: (r) => {
      rows.push(r);
      notifyRows();
    },
  };
}

const localTable = (id: string, name: string, columns: Table['columns'] = []): Table => ({
  id,
  workspaceId: 'ws',
  name,
  code: name,
  columns,
  view: 'table',
  updatedAt: 0,
});

function projectionTable(): Table {
  return {
    ...localTable('proj', 'People x Dept'),
    source: {
      type: 'projection',
      config: {
        version: 1,
        sources: [
          { alias: 'p', tableName: 'People' },
          { alias: 'd', tableName: 'Dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
        ],
        columns: [
          { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } },
          { field: 'dept', label: 'Dept', type: 'string', from: { kind: 'source', alias: 'd', field: 'label' } },
        ],
      },
    },
  };
}

describe('createProjectionCollection', () => {
  function setup() {
    const mem = memStore();
    mem.addTable(localTable('p1', 'People'));
    mem.addTable(localTable('d1', 'Dept'));
    mem.addRow({ id: 'pa', tableId: 'p1', data: { name: 'Bob', deptId: 'x' }, updatedAt: 1 });
    mem.addRow({ id: 'pb', tableId: 'p1', data: { name: 'Sue', deptId: 'y' }, updatedAt: 1 });
    mem.addRow({ id: 'dx', tableId: 'd1', data: { id: 'x', label: 'Sales' }, updatedAt: 1 });
    const table = projectionTable();
    mem.addTable(table);
    return { mem, coll: createProjectionCollection(mem.store, table) };
  }

  it('computes joined rows on find()', async () => {
    const { coll } = setup();
    const rows = await coll.find();
    expect(rows.map((r) => r.data)).toEqual([
      { name: 'Bob', dept: 'Sales' },
      // Unmatched left join → null (SQL NULL), so the rows match the SQL export.
      { name: 'Sue', dept: null },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['pa#0', 'pb#0']);
    expect(rows.every((r) => r.tableId === 'proj')).toBe(true);
  });

  it('re-emits to subscribers when an underlying row changes', async () => {
    const { mem, coll } = setup();
    const seen: string[][] = [];
    const unsub = coll.subscribe((rows) => seen.push(rows.map((r) => String(r.data.name))));
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    await mem.store.rows('p1').patch('pa', { data: { name: 'Bobby', deptId: 'x' } });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['Bobby', 'Sue']));
    unsub();
  });

  it('writes a base-source cell edit back to the underlying base row', async () => {
    const { mem, coll } = setup();
    await coll.patch('pa#0', { data: { name: 'Robert', dept: 'Sales' } });
    const base = await mem.store.rows('p1').findOne('pa');
    expect(base?.data.name).toBe('Robert');
  });

  it('computes every projection when many are read at once', async () => {
    // Regression: an ambient depth counter incremented across `await`s measured
    // CONCURRENCY, not recursion depth, so the 9th simultaneous projection
    // silently rendered empty. Any table write fans a recompute out to every
    // projection at once, so this is reachable with no nesting at all.
    const mem = memStore();
    mem.addTable(localTable('p1', 'People'));
    mem.addRow({ id: 'pa', tableId: 'p1', data: { name: 'Bob' }, updatedAt: 1 });
    const colls = Array.from({ length: 9 }, (_, i) => {
      const t: Table = {
        ...localTable(`proj${i}`, `View ${i}`),
        source: {
          type: 'projection',
          config: {
            version: 1,
            sources: [{ alias: 'p', tableName: 'People' }],
            columns: [
              { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } },
            ],
          },
        },
      };
      mem.addTable(t);
      return createProjectionCollection(mem.store, t);
    });

    const counts = (await Promise.all(colls.map((c) => c.find()))).map((rows) => rows.length);

    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('never publishes an empty frame when find() and subscribe() race in one tick', async () => {
    // Regression: the cycle guard treated a concurrent read of the SAME
    // projection as a cycle, so one of the two bailed to [] and pushed that
    // empty array to subscribers — a visible empty-grid flash.
    const { coll } = setup();
    const seen: number[][] = [];
    const found = coll.find();
    const unsub = coll.subscribe((rows) => seen.push(rows.map(() => 1)));
    const rows = await found;

    expect(rows).toHaveLength(2);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.every((frame) => frame.length === 2)).toBe(true);
    unsub();
  });

  it('rejects a patch that touches only read-only (secondary/computed) columns', async () => {
    const { coll } = setup();
    // The grid never gives a read-only cell an editor (see data-table), so a
    // patch reaching the collection with no writable field is a genuine misuse.
    await expect(coll.patch('pa#0', { data: { dept: 'Marketing' } })).rejects.toBeInstanceOf(
      ProjectionReadOnlyError,
    );
  });
});
