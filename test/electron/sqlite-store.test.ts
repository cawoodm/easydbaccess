import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SqliteStore, copyDatabase } from '../../packages/electron/src/sqlite-store.js';

/**
 * Unit tests for the main-process SQLite store — the RELATIONAL layout (see
 * `.claude/plans/2026-07-31-electron-sqlite-storage.md`). A user table is a
 * real SQL table plus an `_easydb_meta_<sql>` metadata table, not a
 * `doc TEXT` JSON blob. Uses a real temp file per test (not `:memory:`) so
 * "reopen an existing file" is genuinely exercised, and so the raw
 * `sqlite_master` / `PRAGMA table_info` introspection below can open its own
 * connection onto the same file.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-sqlite-store-'));
  dbPath = join(dir, `${randomUUID()}.db`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Opens a second raw connection for `sqlite_master` / `PRAGMA` introspection. */
function inspect(path: string): DatabaseSyncType {
  return new DatabaseSync(path);
}

function tableNames(raw: DatabaseSyncType): string[] {
  return (
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function columnInfo(raw: DatabaseSyncType, table: string): Array<{ name: string; type: string }> {
  return raw.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{
    name: string;
    type: string;
  }>;
}

function baseTable(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 't1',
    workspaceId: 'w1',
    name: overrides.name ?? 'people',
    code: 'people',
    columns: overrides.columns ?? [{ field: 'name', label: 'Name', type: 'string' }],
    view: 'grid',
    updatedAt: 1,
    ...overrides,
  };
}

describe('SqliteStore — schema + reopen', () => {
  it('creates the schema idempotently and survives close/reopen', () => {
    const store1 = new SqliteStore({ path: dbPath });
    store1.insert('workspaces', { id: 'w1', name: 'Workspace One', createdAt: 1, pluginUrls: [] });
    store1.close();

    expect(existsSync(dbPath)).toBe(true);

    const store2 = new SqliteStore({ path: dbPath });
    const found = store2.findOne('workspaces', 'w1') as { id: string; name: string } | null;
    expect(found).not.toBeNull();
    expect(found?.name).toBe('Workspace One');

    store2.close();
    const store3 = new SqliteStore({ path: dbPath });
    expect(store3.count('workspaces')).toBe(1);
    store3.close();
  });

  it('reopen preserves a previously-created user table, its columns and its rows', () => {
    const store1 = new SqliteStore({ path: dbPath });
    store1.insert('tables', baseTable());
    store1.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    store1.close();

    const store2 = new SqliteStore({ path: dbPath });
    const table = store2.findOne('tables', 't1') as { columns: unknown[] } | null;
    expect(table).not.toBeNull();
    expect(table?.columns).toHaveLength(1);
    const rows = store2.find('rows', { tableId: 't1' }) as Array<{ data: { name: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.name).toBe('Alice');
    store2.close();
  });
});

describe('SqliteStore — unknown collection', () => {
  it('throws a clear error for find/findOne/insert', () => {
    const store = new SqliteStore({ path: dbPath });
    expect(() => store.find('not-a-collection')).toThrow(/not-a-collection/);
    expect(() => store.findOne('not-a-collection', 'x')).toThrow();
    expect(() => store.insert('not-a-collection', { id: 'x' })).toThrow();
    store.close();
  });
});

describe('SqliteStore — tables: real SQL objects', () => {
  it('insert creates a real SQL table and its metadata table, DDL matching the columns', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert(
      'tables',
      baseTable({
        columns: [
          { field: 'name', label: 'Name', type: 'string' },
          { field: 'qty', label: 'Qty', type: 'number' },
          { field: 'active', label: 'Active', type: 'boolean' },
        ],
      }),
    );
    store.close();

    const raw = inspect(dbPath);
    const names = tableNames(raw);
    expect(names).toContain('people');
    expect(names).toContain('_easydb_meta_people');

    const cols = columnInfo(raw, 'people');
    expect(cols.map((c) => c.name)).toEqual(['_id', '_updatedAt', '_extra', 'name', 'qty', 'active']);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c.type]));
    expect(byName.name).toBe('TEXT');
    expect(byName.qty).toBe('REAL');
    expect(byName.active).toBe('INTEGER');
    raw.close();
  });

  it('sanitizes the SQL table name from an unsafe table name', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 't2', name: 'simon-blog/entries' }));
    store.close();

    const raw = inspect(dbPath);
    expect(tableNames(raw)).toContain('simon_blog_entries');
    expect(tableNames(raw)).toContain('_easydb_meta_simon_blog_entries');
    raw.close();
  });

  it('findOne reassembles the full Table from table_json + columns_json', () => {
    const store = new SqliteStore({ path: dbPath });
    const table = baseTable({
      windowGeometry: { x: 1, y: 2, w: 300, h: 200, z: 1, minimized: false, maximized: false },
      sortBy: [{ field: 'name', asc: true }],
    });
    store.insert('tables', table);
    const found = store.findOne('tables', 't1');
    expect(found).toEqual(table);
    store.close();
  });

  it('find() reassembles every registered table, in insertion (ordinal) order', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 't1', name: 'one' }));
    store.insert('tables', baseTable({ id: 't2', name: 'two' }));
    const found = store.find('tables') as Array<{ id: string }>;
    expect(found.map((t) => t.id)).toEqual(['t1', 't2']);
    store.close();
  });

  it('find() filters by an arbitrary doc field (JS fallback)', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 't1', name: 'one', workspaceId: 'wA' }));
    store.insert('tables', baseTable({ id: 't2', name: 'two', workspaceId: 'wB' }));
    const found = store.find('tables', { workspaceId: 'wA' }) as Array<{ id: string }>;
    expect(found.map((t) => t.id)).toEqual(['t1']);
    store.close();
  });
});

describe('SqliteStore — ColumnSpec verbatim round-trip', () => {
  it('preserves renderer/hidden/width and every other ColumnSpec field', () => {
    const store = new SqliteStore({ path: dbPath });
    const columns = [
      {
        field: 'url',
        label: 'URL',
        type: 'string',
        renderer: 'link',
        hidden: true,
        width: 240,
        script: 'function render(row) { return row.url; }',
        sortable: false,
        filterable: false,
        max: 500,
        unique: true,
        notnull: true,
        default: 'https://example.com',
        description: 'A link to the resource',
        units: 'n/a',
      },
    ];
    store.insert('tables', baseTable({ columns }));
    const found = store.findOne('tables', 't1') as { columns: unknown[] } | null;
    expect(found?.columns).toEqual(columns);
    store.close();
  });
});

describe('SqliteStore — table name collisions and edge cases', () => {
  it('de-duplicates two names that sanitize to the same SQL identifier', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 't1', name: 'a/b' }));
    store.insert('tables', baseTable({ id: 't2', name: 'a-b' }));
    store.close();

    const raw = inspect(dbPath);
    const names = tableNames(raw);
    expect(names).toContain('a_b');
    expect(names).toContain('a_b_2');
    raw.close();

    // Registry keeps the real (unsanitized) names for both.
    const store2 = new SqliteStore({ path: dbPath });
    const t1 = store2.findOne('tables', 't1') as { name: string };
    const t2 = store2.findOne('tables', 't2') as { name: string };
    expect(t1.name).toBe('a/b');
    expect(t2.name).toBe('a-b');
    store2.close();
  });

  it('an empty table name does not produce a broken SQL identifier', () => {
    const store = new SqliteStore({ path: dbPath });
    expect(() => store.insert('tables', baseTable({ id: 't1', name: '' }))).not.toThrow();
    store.close();
    const raw = inspect(dbPath);
    const names = tableNames(raw);
    expect(names.some((n) => n.length > 0 && !n.startsWith('_easydb'))).toBe(true);
    raw.close();
  });

  it('a table named like a reserved system table does not collide with it', () => {
    const store = new SqliteStore({ path: dbPath });
    expect(() => store.insert('tables', baseTable({ id: 't1', name: '_easydb_tables' }))).not.toThrow();
    store.insert('tables', baseTable({ id: 't2', name: 'unrelated' }));
    store.close();

    const raw = inspect(dbPath);
    // The real system registry must still be exactly one table, untouched.
    const registryRows = raw.prepare('SELECT id FROM _easydb_tables').all() as Array<{ id: string }>;
    expect(registryRows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
    raw.close();
  });

  it('renaming Table.name does NOT rename the SQL table (sql_table is assigned once)', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });

    store.patch('tables', 't1', { name: 'humans', updatedAt: 2 });
    store.close();

    const raw = inspect(dbPath);
    const names = tableNames(raw);
    // The physical SQL objects are untouched by the rename.
    expect(names).toContain('people');
    expect(names).toContain('_easydb_meta_people');
    expect(names).not.toContain('humans');
    raw.close();

    const store2 = new SqliteStore({ path: dbPath });
    const table = store2.findOne('tables', 't1') as { name: string };
    expect(table.name).toBe('humans'); // registry/table_json DID update
    const rows = store2.find('rows', { tableId: 't1' }) as Array<{ data: { name: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.name).toBe('Alice');
    store2.close();
  });
});

describe('SqliteStore — rows: type round-trip via encode/decode', () => {
  function richTable(): Record<string, unknown> {
    return baseTable({
      id: 't1',
      name: 'items',
      columns: [
        { field: 'name', label: 'Name', type: 'string' },
        { field: 'qty', label: 'Qty', type: 'number' },
        { field: 'active', label: 'Active', type: 'boolean' },
        { field: 'created', label: 'Created', type: 'date' },
        { field: 'seen', label: 'Seen', type: 'datetime' },
      ],
    });
  }

  it('round-trips string/number/boolean/date/datetime, falsy values included', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', richTable());
    store.insert('rows', {
      id: 'r1',
      tableId: 't1',
      data: {
        name: '', // falsy string
        qty: 0, // falsy number
        active: false, // falsy boolean
        created: '2026-01-01',
        seen: '2026-01-01T12:00:00Z',
      },
      updatedAt: 10,
    });
    const found = store.findOne('rows', 'r1') as { data: Record<string, unknown> } | null;
    expect(found?.data).toEqual({
      name: '',
      qty: 0,
      active: false,
      created: '2026-01-01',
      seen: '2026-01-01T12:00:00Z',
    });
    store.close();
  });

  it('omits a column from `data` when its decoded value is null, for every ColumnType', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', richTable());
    store.insert('rows', {
      id: 'r1',
      tableId: 't1',
      data: { name: null, qty: null, active: null, created: null, seen: null },
      updatedAt: 1,
    });
    const found = store.findOne('rows', 'r1') as { data: Record<string, unknown> } | null;
    expect(found?.data).toEqual({});
    store.close();
  });

  it('omits a column from `data` when the field was never present at all', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', richTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Widget' }, updatedAt: 1 });
    const found = store.findOne('rows', 'r1') as { data: Record<string, unknown> } | null;
    // Only the field actually supplied shows up — matches what a fresh Dexie
    // row (which never had `qty`/`active`/…) would return.
    expect(found?.data).toEqual({ name: 'Widget' });
    store.close();
  });
});

describe('SqliteStore — rows: `_extra` overflow column', () => {
  it('round-trips a data key with no matching ColumnSpec via `_extra`', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable()); // only a `name` column
    store.insert('rows', {
      id: 'r1',
      tableId: 't1',
      data: { name: 'Alice', ghostField: 'still here', nested: { a: 1 } },
      updatedAt: 1,
    });
    const found = store.findOne('rows', 'r1') as { data: Record<string, unknown> } | null;
    expect(found?.data).toEqual({ name: 'Alice', ghostField: 'still here', nested: { a: 1 } });
    store.close();
  });

  it('stores `_extra` as SQL NULL (not `{}`) when there is no overflow', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    store.close();

    const raw = inspect(dbPath);
    const row = raw.prepare('SELECT _extra FROM people WHERE _id = ?').get('r1') as {
      _extra: string | null;
    };
    expect(row._extra).toBeNull();
    raw.close();
  });

  it('stores `_extra` as a JSON object when there IS overflow', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', {
      id: 'r1',
      tableId: 't1',
      data: { name: 'Alice', extraField: 42 },
      updatedAt: 1,
    });
    store.close();

    const raw = inspect(dbPath);
    const row = raw.prepare('SELECT _extra FROM people WHERE _id = ?').get('r1') as {
      _extra: string | null;
    };
    expect(row._extra).not.toBeNull();
    expect(JSON.parse(row._extra as string)).toEqual({ extraField: 42 });
    raw.close();
  });
});

describe('SqliteStore — additive column reconciliation', () => {
  it('adding a column applies ALTER TABLE ADD COLUMN and updates columns_json', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });

    const newColumns = [
      { field: 'name', label: 'Name', type: 'string' },
      { field: 'age', label: 'Age', type: 'number' },
    ];
    store.patch('tables', 't1', { columns: newColumns, updatedAt: 2 });
    store.close();

    const raw = inspect(dbPath);
    const cols = columnInfo(raw, 'people').map((c) => c.name);
    expect(cols).toEqual(['_id', '_updatedAt', '_extra', 'name', 'age']);
    raw.close();

    const store2 = new SqliteStore({ path: dbPath });
    const table = store2.findOne('tables', 't1') as { columns: unknown[] };
    expect(table.columns).toEqual(newColumns);
    // A new row can now use the added column.
    store2.insert('rows', { id: 'r2', tableId: 't1', data: { name: 'Bob', age: 30 }, updatedAt: 3 });
    const found = store2.findOne('rows', 'r2') as { data: Record<string, unknown> };
    expect(found.data).toEqual({ name: 'Bob', age: 30 });
    store2.close();
  });

  it('removing a column from `columns` leaves the SQL column and existing row data intact', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert(
      'tables',
      baseTable({
        columns: [
          { field: 'name', label: 'Name', type: 'string' },
          { field: 'age', label: 'Age', type: 'number' },
        ],
      }),
    );
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice', age: 30 }, updatedAt: 1 });

    // The column editor "removed" `age` — columns_json no longer lists it.
    store.patch('tables', 't1', {
      columns: [{ field: 'name', label: 'Name', type: 'string' }],
      updatedAt: 2,
    });
    store.close();

    const raw = inspect(dbPath);
    // The SQL column is NEVER dropped.
    const cols = columnInfo(raw, 'people').map((c) => c.name);
    expect(cols).toEqual(['_id', '_updatedAt', '_extra', 'name', 'age']);
    // Nor is the underlying data destroyed.
    const row = raw.prepare('SELECT age FROM people WHERE _id = ?').get('r1') as { age: number };
    expect(row.age).toBe(30);
    raw.close();

    const store2 = new SqliteStore({ path: dbPath });
    const table = store2.findOne('tables', 't1') as { columns: unknown[] };
    // columns_json (not the DDL) is authoritative for what is visible.
    expect(table.columns).toEqual([{ field: 'name', label: 'Name', type: 'string' }]);
    // The row surface via `data` no longer mentions the removed field either
    // (readColumnsJson drives the decode), but nothing threw and nothing was lost at the SQL level.
    const found = store2.findOne('rows', 'r1') as { data: Record<string, unknown> };
    expect(found.data).toEqual({ name: 'Alice' });
    store2.close();
  });

  it('a rename (remove old field + add new field) does NOT drop the old column', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable()); // has `name`
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });

    // Column editor "renamed" name -> fullName: old field removed from
    // columns_json, new field added. Never a DDL RENAME/DROP.
    store.patch('tables', 't1', {
      columns: [{ field: 'fullName', label: 'Full Name', type: 'string' }],
      updatedAt: 2,
    });
    store.close();

    const raw = inspect(dbPath);
    const cols = columnInfo(raw, 'people').map((c) => c.name);
    // Both the old AND the new column exist — nothing was dropped.
    expect(cols).toEqual(['_id', '_updatedAt', '_extra', 'name', 'fullName']);
    // The old column's data is untouched (still there, just no longer surfaced).
    const row = raw.prepare('SELECT name, fullName FROM people WHERE _id = ?').get('r1') as {
      name: string;
      fullName: string | null;
    };
    expect(row.name).toBe('Alice');
    expect(row.fullName).toBeNull();
    raw.close();
  });
});

describe('SqliteStore — tables: remove drops both SQL objects', () => {
  it('removing a table drops the SQL table, its meta table, and the registry row', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    store.remove('tables', 't1');
    store.close();

    const raw = inspect(dbPath);
    const names = tableNames(raw);
    expect(names).not.toContain('people');
    expect(names).not.toContain('_easydb_meta_people');
    raw.close();

    const store2 = new SqliteStore({ path: dbPath });
    expect(store2.findOne('tables', 't1')).toBeNull();
    expect(store2.count('tables')).toBe(0);
    store2.close();
  });
});

describe('SqliteStore — rows: view semantics', () => {
  it("find(rows, {tableId}) returns only that table's rows — two tables never bleed", () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 'tA', name: 'a' }));
    store.insert('tables', baseTable({ id: 'tB', name: 'b' }));
    store.insert('rows', { id: 'r1', tableId: 'tA', data: { name: 'Alice' }, updatedAt: 1 });
    store.insert('rows', { id: 'r2', tableId: 'tA', data: { name: 'Bob' }, updatedAt: 2 });
    store.insert('rows', { id: 'r3', tableId: 'tB', data: { name: 'Carol' }, updatedAt: 3 });

    const foundA = store.find('rows', { tableId: 'tA' }) as Array<{ id: string }>;
    expect(foundA.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    const foundB = store.find('rows', { tableId: 'tB' }) as Array<{ id: string }>;
    expect(foundB.map((r) => r.id)).toEqual(['r3']);
    store.close();
  });

  it('find(rows) with no tableId unions every registered table', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 'tA', name: 'a' }));
    store.insert('tables', baseTable({ id: 'tB', name: 'b' }));
    store.insert('rows', { id: 'r1', tableId: 'tA', data: { name: 'Alice' }, updatedAt: 1 });
    store.insert('rows', { id: 'r2', tableId: 'tB', data: { name: 'Bob' }, updatedAt: 2 });
    const all = store.find('rows') as Array<{ id: string }>;
    expect(all.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    store.close();
  });

  it('insert(rows) into an unregistered tableId throws a clear error', () => {
    const store = new SqliteStore({ path: dbPath });
    expect(() => store.insert('rows', { id: 'r1', tableId: 'ghost', data: {}, updatedAt: 1 })).toThrow(/ghost/);
    store.close();
  });

  it('insert/upsert(rows) missing a tableId throws a clear error', () => {
    const store = new SqliteStore({ path: dbPath });
    expect(() => store.insert('rows', { id: 'r1', data: {}, updatedAt: 1 })).toThrow(/tableId/);
    expect(() => store.upsert('rows', { id: 'r1', data: {}, updatedAt: 1 })).toThrow(/tableId/);
    store.close();
  });

  it('filters on a non-column (data) query key in JS after decode', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    store.insert('rows', { id: 'r2', tableId: 't1', data: { name: 'Bob' }, updatedAt: 2 });
    const found = store.find('rows', { tableId: 't1', name: 'Bob' } as Record<string, unknown>) as Array<{
      id: string;
    }>;
    expect(found.map((r) => r.id)).toEqual(['r2']);
    store.close();
  });

  it('patch updates a row by id, located without needing its tableId', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    const patched = store.patch('rows', 'r1', { data: { name: 'Alicia' }, updatedAt: 2 }) as {
      data: Record<string, unknown>;
      updatedAt: number;
    };
    expect(patched.data.name).toBe('Alicia');
    expect(patched.updatedAt).toBe(2);
    store.close();
  });

  it('remove deletes a row by id without needing its tableId', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    store.remove('rows', 'r1');
    expect(store.findOne('rows', 'r1')).toBeNull();
    store.close();
  });

  it('count(rows) sums rows across every user table', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable({ id: 'tA', name: 'a' }));
    store.insert('tables', baseTable({ id: 'tB', name: 'b' }));
    store.insert('rows', { id: 'r1', tableId: 'tA', data: { name: 'Alice' }, updatedAt: 1 });
    store.insert('rows', { id: 'r2', tableId: 'tB', data: { name: 'Bob' }, updatedAt: 2 });
    expect(store.count('rows')).toBe(2);
    store.close();
  });
});

describe('SqliteStore — workspace-scoped settings and plugins keyed by url', () => {
  it('two workspaces may hold the SAME setting `name` — the physical `key` already differs', () => {
    const store = new SqliteStore({ path: dbPath });
    // `key` mirrors `settingId()` from dexie-db.ts: `<workspaceId>::<name>`.
    // Two workspaces never collide on (coll, key) because the workspace id
    // is already baked into the physical key before it reaches the store.
    store.insert('settings', {
      key: 'w1::gist-sync:token',
      workspaceId: 'w1',
      name: 'gist-sync:token',
      value: 'secret',
    });
    store.insert('settings', {
      key: 'w2::gist-sync:token',
      workspaceId: 'w2',
      name: 'gist-sync:token',
      value: 'other',
    });
    const w1Value = store.findOne('settings', 'w1::gist-sync:token') as { value: string } | null;
    const w2Value = store.findOne('settings', 'w2::gist-sync:token') as { value: string } | null;
    expect(w1Value?.value).toBe('secret');
    expect(w2Value?.value).toBe('other');
    store.close();
  });

  it('find(settings, {workspaceId}) filters in SQL', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('settings', { key: 'w1::a', workspaceId: 'w1', name: 'a', value: 1 });
    store.insert('settings', { key: 'w1::b', workspaceId: 'w1', name: 'b', value: 2 });
    store.insert('settings', { key: 'w2::a', workspaceId: 'w2', name: 'a', value: 3 });
    const byWorkspace = store.find('settings', { workspaceId: 'w1' }) as Array<{ key: string }>;
    expect(byWorkspace.map((s) => s.key).sort()).toEqual(['w1::a', 'w1::b']);
    store.close();
  });

  it('plugins round-trips by its `url` primary key', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('plugins', { url: 'https://example.com/p.js', enabled: true, lastFetched: 1 });
    const found = store.findOne('plugins', 'https://example.com/p.js') as { enabled: boolean } | null;
    expect(found?.enabled).toBe(true);
    store.close();
  });
});

describe('SqliteStore — patch / upsert semantics', () => {
  it('upsert replaces an existing document wholesale', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('workspaces', { id: 'w1', name: 'Original', createdAt: 1, pluginUrls: [] });
    store.upsert('workspaces', { id: 'w1', name: 'Replaced', createdAt: 1, pluginUrls: ['x'] });
    const found = store.findOne('workspaces', 'w1') as { name: string; pluginUrls: string[] };
    expect(found.name).toBe('Replaced');
    expect(found.pluginUrls).toEqual(['x']);
    expect(store.count('workspaces')).toBe(1);
    store.close();
  });

  it('upsert inserts when the document does not yet exist', () => {
    const store = new SqliteStore({ path: dbPath });
    store.upsert('workspaces', { id: 'w9', name: 'Fresh', createdAt: 1, pluginUrls: [] });
    expect(store.count('workspaces')).toBe(1);
    store.close();
  });

  it('patch shallow-merges and preserves untouched fields', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('workspaces', { id: 'w1', name: 'One', createdAt: 1, pluginUrls: ['a'] });
    const patched = store.patch('workspaces', 'w1', { name: 'Renamed' }) as {
      name: string;
      pluginUrls: string[];
      createdAt: number;
    };
    expect(patched.name).toBe('Renamed');
    expect(patched.pluginUrls).toEqual(['a']);
    expect(patched.createdAt).toBe(1);
    store.close();
  });

  it('patch throws naming the collection and key when the doc is missing', () => {
    const store = new SqliteStore({ path: dbPath });
    expect(() => store.patch('workspaces', 'missing-id', { name: 'x' })).toThrow(/workspaces/);
    expect(() => store.patch('workspaces', 'missing-id', { name: 'x' })).toThrow(/missing-id/);
    store.close();
  });
});

describe('SqliteStore — transactional rollback', () => {
  it('bulkInsert of workspaces rolls back fully on a duplicate key', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('workspaces', { id: 'dup', name: 'Existing', createdAt: 1, pluginUrls: [] });
    expect(() =>
      store.bulkInsert('workspaces', [
        { id: 'new-1', name: 'New One', createdAt: 2, pluginUrls: [] },
        { id: 'dup', name: 'Conflict', createdAt: 3, pluginUrls: [] },
      ]),
    ).toThrow();
    expect(store.count('workspaces')).toBe(1);
    expect(store.findOne('workspaces', 'new-1')).toBeNull();
    store.close();
  });

  it('bulkInsert of rows rolls back fully when one row targets an unregistered table', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    expect(() =>
      store.bulkInsert('rows', [
        { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 },
        { id: 'r2', tableId: 'ghost', data: { name: 'Bob' }, updatedAt: 2 },
      ]),
    ).toThrow();
    expect(store.find('rows', { tableId: 't1' })).toHaveLength(0);
    store.close();
  });

  it('bulkRemove rolls back fully when a key targets an unknown collection', () => {
    const store = new SqliteStore({ path: dbPath });
    store.bulkInsert('workspaces', [
      { id: 'w1', name: 'One', createdAt: 1, pluginUrls: [] },
      { id: 'w2', name: 'Two', createdAt: 2, pluginUrls: [] },
    ]);
    expect(() => store.bulkRemove('not-a-collection', ['w1'])).toThrow();
    expect(store.count('workspaces')).toBe(2);
    store.close();
  });
});

describe('copyDatabase', () => {
  it('produces a file the store can reopen with the same contents, including user tables', () => {
    const store = new SqliteStore({ path: dbPath });
    store.insert('tables', baseTable());
    store.insert('rows', { id: 'r1', tableId: 't1', data: { name: 'Alice' }, updatedAt: 1 });
    store.close();

    const copyPath = join(dir, 'copy.db');
    copyDatabase(dbPath, copyPath);
    expect(existsSync(copyPath)).toBe(true);

    const copiedStore = new SqliteStore({ path: copyPath });
    expect(copiedStore.count('rows')).toBe(1);
    const table = copiedStore.findOne('tables', 't1') as { name: string } | null;
    expect(table?.name).toBe('people');
    const row = copiedStore.findOne('rows', 'r1') as { data: { name: string } } | null;
    expect(row?.data.name).toBe('Alice');
    copiedStore.close();

    // Sanity: the copy is a real independent file, not a symlink/alias.
    expect(readFileSync(copyPath).length).toBeGreaterThan(0);
  });
});

/**
 * A grid asks for its whole table the moment it mounts, and the reply crosses
 * IPC as one structured-clone payload. Unbounded, that killed the app: a
 * workspace converted from `northwind.db` restored 18 open windows wanting
 * 1,893,366 rows between them and crashed on boot before drawing anything.
 */
describe('find("rows") row cap', () => {
  it('returns at most `limit` rows, while the count stays truthful', () => {
    const store = new SqliteStore({ path: dbPath });
    try {
      const table = store.insert('tables', {
        id: 'big',
        workspaceId: 'ws',
        name: 'Big',
        columns: [{ field: 'n', label: 'n', type: 'number' }],
        view: 'table',
        updatedAt: 1,
      }) as { id: string };
      store.bulkInsert(
        'rows',
        Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, tableId: table.id, data: { n: i }, updatedAt: 1 })),
      );

      expect(store.find('rows', { tableId: table.id }, 100)).toHaveLength(100);
      // No cap still means everything — an ordinary caller is unaffected.
      expect(store.find('rows', { tableId: table.id })).toHaveLength(250);
      // The cap must not leak into the count, or a truncated view would report
      // itself as complete.
      expect(store.countRowsIn(table.id)).toBe(250);
    } finally {
      store.close();
    }
  });

  it('reports 0 for a table id it does not know', () => {
    const store = new SqliteStore({ path: dbPath });
    try {
      expect(store.countRowsIn('nope')).toBe(0);
    } finally {
      store.close();
    }
  });
});
