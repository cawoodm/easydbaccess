import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ColumnSpec, Table } from '../../packages/shared/src/types.js';
import { EDB_FORMAT_VERSION, EdbStore } from '../../packages/shared/src/edb-store.js';
import { nodeSqliteDriver } from './node-sqlite-driver.js';

/**
 * The `.edb` v2 store, exercised against a real SQLite through the driver
 * interface. What these suites pin is the behaviour a naive edit would break:
 * the physical table name never moving, column reconciliation staying additive,
 * and `_extra` round-tripping a row to something equal to the original.
 */

let driver: ReturnType<typeof nodeSqliteDriver>;
let store: EdbStore;

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'qty', label: 'Qty', type: 'number' },
  { field: 'done', label: 'Done', type: 'boolean' },
];

function table(over: Partial<Table> = {}): Record<string, unknown> {
  return { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1, ...over } as unknown as Record<string, unknown>;
}

function row(id: string, data: Record<string, unknown>, tableId = 't1'): Record<string, unknown> {
  return { id, tableId, data, updatedAt: 7 };
}

beforeEach(() => {
  driver = nodeSqliteDriver();
  store = new EdbStore(driver);
});

afterEach(() => {
  driver.close();
});

describe('format stamp', () => {
  it('stamps a fresh file so it can be recognised as ours', () => {
    expect(store.format()).toEqual({ version: EDB_FORMAT_VERSION, app: 'easydbaccess' });
  });

  it('leaves an existing stamp alone, so a newer file is not silently relabelled', () => {
    driver.prepare(`UPDATE _easydb SET doc = ? WHERE coll = '_meta' AND key = 'format'`).run(JSON.stringify({ version: 99, app: 'easydbaccess' }));
    const reopened = new EdbStore(driver);
    expect(reopened.format()?.version).toBe(99);
  });
});

describe('the single _easydb table', () => {
  it('is the only meta table in the file — no registry, no per-table meta', () => {
    store.insert('tables', table());
    const names = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_%' ESCAPE '\\'`)
      .all()
      .map((r) => String(r.name));
    expect(names).toEqual(['_easydb']);
  });

  it('holds every document collection, keyed by its own primary key', () => {
    store.insert('workspaces', { id: 'w1', name: 'Work' });
    store.insert('settings', { key: 's1', workspaceId: 'w1', value: 1 });
    store.insert('plugins', { url: 'https://x/p.js', enabled: true });
    expect(store.findOne('workspaces', 'w1')).toMatchObject({ name: 'Work' });
    expect(store.findOne('settings', 's1')).toMatchObject({ value: 1 });
    expect(store.findOne('plugins', 'https://x/p.js')).toMatchObject({ enabled: true });
  });

  it('scopes a settings query by workspaceId in SQL', () => {
    store.insert('settings', { key: 'a', workspaceId: 'w1', value: 1 });
    store.insert('settings', { key: 'b', workspaceId: 'w2', value: 2 });
    expect(store.find('settings', { workspaceId: 'w1' })).toHaveLength(1);
  });

  it('refuses a collection it does not know, instead of dropping the write', () => {
    expect(() => store.insert('nope', { id: 'x' })).toThrow(/unknown collection/);
  });
});

describe('a user table becomes a real SQL table', () => {
  it('creates one column per ColumnSpec, with the mapped affinity', () => {
    store.insert('tables', table());
    const info = driver.prepare(`PRAGMA table_info("Parts")`).all();
    const byName = new Map(info.map((c) => [String(c.name), String(c.type)]));
    expect(byName.get('_id')).toBe('TEXT');
    expect(byName.get('name')).toBe('TEXT');
    expect(byName.get('qty')).toBe('REAL');
    expect(byName.get('done')).toBe('INTEGER');
  });

  it('hides the storage-only fields from what a caller reads back', () => {
    store.insert('tables', table());
    const read = store.findOne('tables', 't1') as Record<string, unknown>;
    expect(read.name).toBe('Parts');
    expect(Object.keys(read)).not.toContain('_sqlTable');
    expect(Object.keys(read)).not.toContain('_ordinal');
  });

  it('falls back to a safe name when the table name would collide with a reserved one', () => {
    store.insert('tables', table({ id: 'a', name: '_easydb' } as Partial<Table>));
    const names = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => String(r.name));
    expect(names).toContain('table');
  });

  it('gives two tables of the same name distinct SQL tables', () => {
    store.insert('tables', table({ id: 'a' }));
    store.insert('tables', table({ id: 'b' }));
    const names = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => String(r.name));
    expect(names).toContain('Parts');
    expect(names).toContain('Parts_2');
  });

  it('keeps the SQL table where it is when the table is renamed', () => {
    store.insert('tables', table());
    store.patch('tables', 't1', { name: 'Widgets' });
    const names = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => String(r.name));
    expect(names).toContain('Parts'); // the physical name is assigned once
    expect(names).not.toContain('Widgets');
    expect((store.findOne('tables', 't1') as Table).name).toBe('Widgets');
  });

  it('drops the SQL table with the table doc', () => {
    store.insert('tables', table());
    store.remove('tables', 't1');
    const names = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => String(r.name));
    expect(names).not.toContain('Parts');
    expect(store.findOne('tables', 't1')).toBeNull();
  });

  it('refuses to insert the same table id twice', () => {
    store.insert('tables', table());
    expect(() => store.insert('tables', table())).toThrow(/already exists/);
  });
});

describe('column reconciliation is additive only', () => {
  it('adds a SQL column for a new field', () => {
    store.insert('tables', table());
    store.patch('tables', 't1', { columns: [...COLUMNS, { field: 'note', label: 'Note', type: 'string' }] });
    const cols = driver
      .prepare(`PRAGMA table_info("Parts")`)
      .all()
      .map((c) => String(c.name));
    expect(cols).toContain('note');
  });

  it('leaves a removed field’s column in place rather than guessing a drop', () => {
    // A ColumnSpec has no stable id, so a rename cannot be told from a
    // drop-plus-add. Dropping on that guess destroyed data once (v0.0.218).
    store.insert('tables', table());
    store.insert('rows', row('r1', { name: 'bolt', qty: 4 }));
    store.patch('tables', 't1', { columns: [COLUMNS[0]!] });
    const cols = driver
      .prepare(`PRAGMA table_info("Parts")`)
      .all()
      .map((c) => String(c.name));
    expect(cols).toContain('qty');
    expect(driver.prepare(`SELECT qty FROM "Parts" WHERE _id = 'r1'`).get()?.qty).toBe(4);
  });
});

describe('rows', () => {
  beforeEach(() => {
    store.insert('tables', table());
  });

  it('round-trips a row to something equal to what went in', () => {
    const written = row('r1', { name: 'bolt', qty: 4, done: true });
    store.insert('rows', written);
    expect(store.findOne('rows', 'r1')).toEqual(written);
  });

  it('stores a value per column, so the file is queryable as SQL', () => {
    store.insert('rows', row('r1', { name: 'bolt', qty: 4, done: true }));
    const raw = driver.prepare(`SELECT name, qty, done FROM "Parts" WHERE _id = 'r1'`).get();
    expect(raw).toEqual({ name: 'bolt', qty: 4, done: 1 });
  });

  it('puts a field with no ColumnSpec in _extra, and brings it back', () => {
    store.insert('rows', row('r1', { name: 'bolt', ghost: 'kept' }));
    expect(driver.prepare(`SELECT _extra FROM "Parts" WHERE _id = 'r1'`).get()?._extra).toBe('{"ghost":"kept"}');
    expect((store.findOne('rows', 'r1') as { data: Record<string, unknown> }).data).toEqual({ name: 'bolt', ghost: 'kept' });
  });

  it('leaves _extra NULL when there is no overflow, so a row equals a fresh one', () => {
    store.insert('rows', row('r1', { name: 'bolt' }));
    expect(driver.prepare(`SELECT _extra FROM "Parts" WHERE _id = 'r1'`).get()?._extra).toBeNull();
  });

  it('omits a null value rather than reporting a key that was never set', () => {
    store.insert('rows', row('r1', { name: 'bolt', qty: null }));
    expect((store.findOne('rows', 'r1') as { data: Record<string, unknown> }).data).toEqual({ name: 'bolt' });
  });

  it('bulk-inserts every row, with values intact', () => {
    store.bulkInsert(
      'rows',
      Array.from({ length: 250 }, (_, i) => row(`r${i}`, { name: `p${i}`, qty: i })),
    );
    expect(store.countRowsIn('t1')).toBe(250);
    expect((store.findOne('rows', 'r249') as { data: Record<string, unknown> }).data).toEqual({ name: 'p249', qty: 249 });
  });

  it('rolls the whole batch back when one row is unusable', () => {
    expect(() => store.bulkInsert('rows', [row('r1', { name: 'a' }), { id: 'r2', data: {} }])).toThrow(/tableId/);
    expect(store.countRowsIn('t1')).toBe(0);
  });

  it('finds rows of one table only', () => {
    store.insert('tables', table({ id: 't2', name: 'Other' }));
    store.insert('rows', row('r1', { name: 'a' }));
    store.insert('rows', row('r2', { name: 'b' }, 't2'));
    expect(store.find('rows', { tableId: 't1' })).toHaveLength(1);
  });

  it('matches a query key against the row data, not the envelope', () => {
    store.insert('rows', row('r1', { name: 'bolt' }));
    store.insert('rows', row('r2', { name: 'nut' }));
    expect(store.find('rows', { tableId: 't1', name: 'nut' })).toHaveLength(1);
  });

  it('removes a row', () => {
    store.insert('rows', row('r1', { name: 'a' }));
    store.remove('rows', 'r1');
    expect(store.findOne('rows', 'r1')).toBeNull();
  });
});

/**
 * A delete names only a row id, so the store is the only thing that can say
 * which table it emptied. Without that answer the change broadcast goes wide and
 * every open grid re-reads itself — once per chunk of a chunked delete.
 */
describe('a removal reports which table it touched', () => {
  beforeEach(() => {
    store.insert('tables', table());
    store.insert('tables', table({ id: 't2', name: 'Other' }));
  });

  it('returns the table a removed row came out of', () => {
    store.insert('rows', row('r1', { name: 'a' }));
    expect(store.remove('rows', 'r1')).toBe('t1');
  });

  it('returns the table even when the row is not in the first one searched', () => {
    store.insert('rows', row('r1', { name: 'a' }, 't2'));
    expect(store.remove('rows', 'r1')).toBe('t2');
  });

  it('reports nothing for a row that was not there — a no-op, not an error', () => {
    expect(store.remove('rows', 'nope')).toBeUndefined();
  });

  it('reports nothing for a collection whose subscribers are not per-table', () => {
    store.upsert('viewTemplates', { id: 'v1', workspaceId: 'w1', name: 'V' });
    expect(store.remove('viewTemplates', 'v1')).toBeUndefined();
    expect(store.remove('tables', 't2')).toBeUndefined();
  });

  it('returns the one table a bulk delete emptied', () => {
    store.bulkInsert('rows', [row('r1', { name: 'a' }), row('r2', { name: 'b' })]);
    expect(store.bulkRemove('rows', ['r1', 'r2'])).toEqual(['t1']);
    expect(store.countRowsIn('t1')).toBe(0);
  });

  it('returns every table a bulk delete spanned, without duplicates', () => {
    store.bulkInsert('rows', [row('r1', { name: 'a' }), row('r2', { name: 'b' }), row('r3', { name: 'c' }, 't2')]);
    expect(store.bulkRemove('rows', ['r1', 'r2', 'r3']).sort()).toEqual(['t1', 't2']);
  });

  it('returns nothing for an empty batch, without opening a transaction', () => {
    expect(store.bulkRemove('rows', [])).toEqual([]);
  });
});

describe('queryRows', () => {
  beforeEach(() => {
    store.insert('tables', table());
    store.bulkInsert('rows', [row('r1', { name: 'bolt', qty: 3 }), row('r2', { name: 'nut', qty: 1 }), row('r3', { name: 'washer', qty: 2 })]);
  });

  it('filters in SQL and reports the matching total', () => {
    const page = store.queryRows('t1', { filters: { name: 'nut' } });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.data.name).toBe('nut');
  });

  it('sorts and slices, and totals what matched rather than what was returned', () => {
    const page = store.queryRows('t1', { sort: [{ field: 'qty', asc: true }], limit: 2 });
    expect(page.rows.map((r) => r.data.qty)).toEqual([1, 2]);
    expect(page.total).toBe(3);
  });

  it('returns only the fields asked for', () => {
    const page = store.queryRows('t1', { fields: ['name'] });
    expect(Object.keys(page.rows[0]?.data ?? {})).toEqual(['name']);
  });

  it('flags the page partial when a filter had no SQL form, so the caller re-filters', () => {
    // A scripted column's value only exists once the renderer runs it.
    store.patch('tables', 't1', { columns: [...COLUMNS, { field: 'calc', label: 'Calc', type: 'string', script: 'function render(r){return 1}' }] });
    const page = store.queryRows('t1', { filters: { calc: '1' } });
    expect(page.partial).toBe(true);
  });

  it('is an empty page for a table that does not exist, not a throw', () => {
    expect(store.queryRows('nope')).toEqual({ rows: [], total: 0 });
  });
});

describe('distinctValues', () => {
  beforeEach(() => {
    store.insert('tables', table());
    store.bulkInsert('rows', [row('r1', { name: 'bolt', qty: 1 }), row('r2', { name: 'bolt', qty: 2 }), row('r3', { name: 'nut', qty: 3 }), row('r4', { name: '', qty: 4 }), row('r5', { qty: 5 })]);
  });

  it('counts each value, commonest first', () => {
    const page = store.distinctValues('t1', { field: 'name' });
    expect(page.values).toEqual([
      { value: 'bolt', count: 2 },
      { value: 'nut', count: 1 },
    ]);
  });

  it('counts blanks together and keeps them out of the value list', () => {
    // NULL and '' are the same thing to a picker: a cell with nothing in it.
    const page = store.distinctValues('t1', { field: 'name' });
    expect(page.blanks).toBe(2);
    expect(page.values.map((v) => v.value)).not.toContain('');
  });

  it('narrows to the rows a filter leaves', () => {
    const page = store.distinctValues('t1', { field: 'name', where: { filters: { qty: '2' } } });
    expect(page.values).toEqual([{ value: 'bolt', count: 1 }]);
  });

  it('says the list was cut short rather than looking complete', () => {
    const page = store.distinctValues('t1', { field: 'name', limit: 1 });
    expect(page.values).toHaveLength(1);
    expect(page.truncated).toBe(true);
  });

  it('a blank group past the limit is still counted', () => {
    // The blank group has its own query for exactly this reason: inside the
    // GROUP BY it would take a slot in the LIMIT, and be missed when it sorts
    // past it.
    const page = store.distinctValues('t1', { field: 'name', limit: 1 });
    expect(page.blanks).toBe(2);
  });

  it('gives up on a scripted column, and says so', () => {
    store.patch('tables', 't1', { columns: [...COLUMNS, { field: 'calc', label: 'Calc', type: 'string', script: 'function render(r){return 1}' }] });
    expect(store.distinctValues('t1', { field: 'calc' })).toEqual({ values: [], partial: true });
  });

  it('marks an array column, whose cells are not its members', () => {
    store.patch('tables', 't1', { columns: [...COLUMNS, { field: 'tags', label: 'Tags', type: 'array' }] });
    store.insert('rows', row('r6', { tags: 'a,b' }));
    expect(store.distinctValues('t1', { field: 'tags' }).cells).toBe(true);
  });

  it('is an empty list for a table that does not exist, not a throw', () => {
    expect(store.distinctValues('nope', { field: 'name' })).toEqual({ values: [] });
  });
});
