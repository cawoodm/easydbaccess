import { describe, expect, it, vi } from 'vitest';
import type { DataCollection, DataStore, Row, Table, Unsubscribe } from '@easydb/shared';
import { createProjectionCollection, ProjectionReadOnlyError } from '../../../packages/renderer/src/plugins/projection-collection.js';

// A tiny reactive in-memory store — enough of the DataStore surface for the
// projection collection (tables.find/subscribe, rows().find/findOne/subscribe/patch).
function memStore(): {
  store: DataStore;
  addTable: (t: Table) => void;
  addRow: (r: Row) => void;
  /** The stored data of one row, whichever table it lives in. */
  rowData: (id: string) => Promise<Record<string, unknown> | undefined>;
  removeTable: (id: string) => void;
} {
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
        return tables.filter((t) => Object.entries(query).every(([k, v]) => (t as unknown as Record<string, unknown>)[k] === v));
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
    rowData: (id) => Promise.resolve(rows.find((r) => r.id === id)?.data),
    /** Drop a table AND its rows, the way deleting one in the UI does. */
    removeTable: (id) => {
      const ti = tables.findIndex((t) => t.id === id);
      if (ti >= 0) tables.splice(ti, 1);
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.tableId === id) rows.splice(i, 1);
      notifyRows();
      notifyTables();
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

function projectionTable(variant?: 'computed'): Table {
  const columns: unknown[] = [
    { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } },
    { field: 'dept', label: 'Dept', type: 'string', from: { kind: 'source', alias: 'd', field: 'label' } },
  ];
  if (variant === 'computed') {
    columns.push({
      field: 'shout',
      from: { kind: 'script', script: 'function render(r){return String(r.name).toUpperCase()}' },
    });
  }
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
        columns,
      },
    },
  };
}

describe('createProjectionCollection', () => {
  function setup(variant?: 'computed') {
    const mem = memStore();
    mem.addTable(localTable('p1', 'People'));
    mem.addTable(localTable('d1', 'Dept'));
    mem.addRow({ id: 'pa', tableId: 'p1', data: { name: 'Bob', deptId: 'x' }, updatedAt: 1 });
    mem.addRow({ id: 'pb', tableId: 'p1', data: { name: 'Sue', deptId: 'y' }, updatedAt: 1 });
    mem.addRow({ id: 'dx', tableId: 'd1', data: { id: 'x', label: 'Sales' }, updatedAt: 1 });
    const table = projectionTable(variant);
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
            columns: [{ field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } }],
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

  it('writes a JOINED column back to the joined table, not the base one', async () => {
    const { mem, coll } = setup();
    await coll.patch('pa#0', { data: { name: 'Bob', dept: 'Marketing' } });

    // The edit landed on the Dept row the join actually read from…
    expect(await mem.rowData('dx')).toEqual({ id: 'x', label: 'Marketing' });
    // …and the base row is untouched.
    expect(await mem.rowData('pa')).toEqual({ name: 'Bob', deptId: 'x' });
  });

  it('does not silently drop a joined edit when the patch also carries base fields', async () => {
    // The reported bug. A grid patch is the WHOLE row, so the base fields were
    // "writable", the write reported success, and the joined edit vanished.
    const { mem, coll } = setup();
    await coll.patch('pa#0', { data: { name: 'Bob', dept: 'Ops' } });
    expect(await mem.rowData('dx')).toEqual({ id: 'x', label: 'Ops' });
  });

  it('refuses a joined edit on a row whose join matched nothing, and says why', async () => {
    const { mem, coll } = setup();
    // Sue's department does not exist, so `dept` is empty — there is no row to
    // put the value in, and inventing one is not this code's business.
    await expect(coll.patch('pb#0', { data: { name: 'Sue', dept: 'Marketing' } })).rejects.toThrow(/no matching "Dept" row/);
    expect(await mem.rowData('pb')).toEqual({ name: 'Sue', deptId: 'y' });
  });

  it('refuses an edit to a computed column instead of pretending it saved', async () => {
    const { mem, coll } = setup('computed');
    await expect(coll.patch('pa#0', { data: { name: 'Bob', shout: 'NOPE' } })).rejects.toBeInstanceOf(ProjectionReadOnlyError);
    await expect(coll.patch('pa#0', { data: { name: 'Bob', shout: 'NOPE' } })).rejects.toThrow(/computed by a script/);
    expect(await mem.rowData('pa')).toEqual({ name: 'Bob', deptId: 'x' });
  });

  it('accepts a patch that changes nothing, without writing', async () => {
    // A grid re-sends the whole row on blur; an unchanged computed column in
    // that payload is noise, not an attempt to edit it.
    const { mem, coll } = setup('computed');
    const before = await mem.rowData('pa');
    await expect(coll.patch('pa#0', { data: { name: 'Bob', dept: 'Sales', shout: 'BOB' } })).resolves.toBeTruthy();
    expect(await mem.rowData('pa')).toEqual(before);
  });

  it('still writes a base column to the base row', async () => {
    const { mem, coll } = setup();
    await coll.patch('pa#0', { data: { name: 'Robert', dept: 'Sales' } });
    expect(await mem.rowData('pa')).toEqual({ name: 'Robert', deptId: 'x' });
    expect(await mem.rowData('dx')).toEqual({ id: 'x', label: 'Sales' });
  });
});

describe('a projection binds to its sources by NAME', () => {
  /**
   * The scenario this exists for: a source table is deleted and re-imported —
   * the ordinary refresh loop for anything backed by a URL or a Datasette
   * instance. The replacement is a NEW table row with a NEW id under the same
   * name, and the projection must follow it there. A spec that remembered an
   * id resolved to nothing and quietly rendered an empty grid.
   */
  function setup() {
    const mem = memStore();
    mem.addTable(localTable('p1', 'People'));
    mem.addTable(localTable('d1', 'Dept'));
    mem.addRow({ id: 'pa', tableId: 'p1', data: { name: 'Bob', deptId: 'x' }, updatedAt: 1 });
    mem.addRow({ id: 'dx', tableId: 'd1', data: { id: 'x', label: 'Sales' }, updatedAt: 1 });
    const table = projectionTable();
    mem.addTable(table);
    return { mem, coll: createProjectionCollection(mem.store, table) };
  }

  it('keeps working when a source is deleted and recreated with a new id', async () => {
    const { mem, coll } = setup();
    // Subscribed, because that is how the grid holds a projection open — and
    // the cache is only kept current while something is listening.
    const seen: unknown[][] = [];
    const unsub = coll.subscribe((rows) => seen.push(rows.map((r) => r.data.dept)));
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual(['Sales']));

    // Gone: an unresolved source renders the projection empty rather than a
    // partial join (see `compute`) — the grid says "nothing", not "half".
    mem.removeTable('d1');
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual([]));

    // Back under the SAME NAME with a different id — a re-import, not the
    // original row. The projection has to find it again.
    mem.addTable(localTable('d2-fresh-id', 'Dept'));
    mem.addRow({ id: 'dx2', tableId: 'd2-fresh-id', data: { id: 'x', label: 'Revenue' }, updatedAt: 2 });
    await vi.waitFor(() => expect(seen[seen.length - 1]).toEqual(['Revenue']));

    // …and a fresh read agrees with what the subscribers were told.
    expect((await coll.find()).map((r) => r.data)).toEqual([{ name: 'Bob', dept: 'Revenue' }]);
    unsub();
  });

  it('resolves a source that only ever existed under a recreated id', async () => {
    // No stale id to fall back on: the projection is opened AFTER the swap, so
    // the name is the only thing that could have found the table.
    const mem = memStore();
    mem.addTable(localTable('p1', 'People'));
    mem.addRow({ id: 'pa', tableId: 'p1', data: { name: 'Bob', deptId: 'x' }, updatedAt: 1 });
    mem.addTable(localTable('some-other-id', 'Dept'));
    mem.addRow({ id: 'dz', tableId: 'some-other-id', data: { id: 'x', label: 'Ops' }, updatedAt: 1 });
    const table = projectionTable();
    mem.addTable(table);

    const coll = createProjectionCollection(mem.store, table);
    expect((await coll.find()).map((r) => r.data)).toEqual([{ name: 'Bob', dept: 'Ops' }]);
  });
});
