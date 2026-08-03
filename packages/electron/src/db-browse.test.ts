import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SqliteStore } from './sqlite-store.js';
import { BROWSE_ROW_CAP, listBrowsable, readBrowseRows } from './db-browse.js';
import { convertToEasydb } from './db-convert.js';

/**
 * "Browse a .db" — a read-only look at a file we neither open nor import.
 * Two properties matter most and are asserted directly: VIEWS are included
 * (Import skips them), and the file is left byte-identical, sidecars included.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-db-browse-'));
  dbPath = join(dir, 'source.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function buildFile(): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, title TEXT, hits INTEGER, starred BOOLEAN);
    CREATE TABLE tags (name TEXT);
    CREATE VIEW popular AS SELECT title, hits FROM bookmarks WHERE hits > 0;
  `);
  db.exec(
    "INSERT INTO bookmarks (title, hits, starred) VALUES ('alpha', 7, 1), ('beta', 0, 0), ('gamma', 3, NULL)",
  );
  db.close();
}

describe('listBrowsable', () => {
  it('lists tables AND views, with inferred columns', () => {
    buildFile();
    const objects = listBrowsable(dbPath);

    expect(objects.map((o) => `${o.kind}:${o.name}`).sort()).toEqual([
      'table:bookmarks',
      'table:tags',
      'view:popular',
    ]);

    const bookmarks = objects.find((o) => o.name === 'bookmarks')!;
    expect(bookmarks.rowCount).toBe(3);
    expect(bookmarks.columns.map((c) => `${c.field}:${c.type}`)).toEqual([
      'id:number',
      'title:string',
      'hits:number',
      'starred:boolean',
    ]);

    // A view's rows are not counted — running it is the work Browse defers.
    expect(objects.find((o) => o.name === 'popular')!.rowCount).toBeNull();
    expect(objects.find((o) => o.name === 'popular')!.columns.map((c) => c.field)).toEqual([
      'title',
      'hits',
    ]);
  });

  it('hides our own bookkeeping tables when browsing a file we wrote', () => {
    const s = new SqliteStore({ path: dbPath });
    s.insert('tables', {
      id: 't1',
      workspaceId: 'ws1',
      name: 'notes',
      columns: [{ field: 'body', label: 'Body', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });
    s.close();

    const names = listBrowsable(dbPath).map((o) => o.name);
    expect(names).toEqual(['notes']);
    expect(names.some((n) => n.startsWith('_easydb'))).toBe(false);
  });

  it('leaves the browsed file byte-identical, with no -wal or -journal sidecar', () => {
    buildFile();
    const before = readFileSync(dbPath);

    listBrowsable(dbPath);

    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  });
});

describe('readBrowseRows', () => {
  it('reads a table, decoding by the inferred column types', () => {
    buildFile();
    const bookmarks = listBrowsable(dbPath).find((o) => o.name === 'bookmarks')!;
    const rows = readBrowseRows(dbPath, 'bookmarks', bookmarks.columns);

    expect(rows).toHaveLength(3);
    const alpha = rows.find((r) => r.data.title === 'alpha')!;
    expect(alpha.data).toEqual({ id: 1, title: 'alpha', hits: 7, starred: true });
    // Zero and false survive; NULL is omitted, matching SqliteStore.decodeRow.
    const beta = rows.find((r) => r.data.title === 'beta')!;
    expect(beta.data.hits).toBe(0);
    expect(beta.data.starred).toBe(false);
    expect(rows.find((r) => r.data.title === 'gamma')!.data.starred).toBeUndefined();
  });

  it('gives a table stable rowid-based ids, so a re-read matches', () => {
    buildFile();
    const cols = listBrowsable(dbPath).find((o) => o.name === 'bookmarks')!.columns;
    const first = readBrowseRows(dbPath, 'bookmarks', cols).map((r) => r.id);
    const second = readBrowseRows(dbPath, 'bookmarks', cols).map((r) => r.id);

    expect(first).toEqual(['r1', 'r2', 'r3']);
    expect(second).toEqual(first);
  });

  it('reads a VIEW, falling back to positional ids (a view has no rowid)', () => {
    buildFile();
    const popular = listBrowsable(dbPath).find((o) => o.name === 'popular')!;
    const rows = readBrowseRows(dbPath, 'popular', popular.columns);

    // The view filters hits > 0, so 'beta' is absent.
    expect(rows.map((r) => r.data.title)).toEqual(['alpha', 'gamma']);
    expect(rows.map((r) => r.id)).toEqual(['i0', 'i1']);
  });

  it('caps the read, and never exceeds the cap even when asked for more', () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE many (n INTEGER)');
    const insert = db.prepare('INSERT INTO many (n) VALUES (?)');
    for (let i = 0; i < 20; i++) insert.run(i);
    db.close();

    const cols = listBrowsable(dbPath).find((o) => o.name === 'many')!.columns;
    expect(readBrowseRows(dbPath, 'many', cols, 5)).toHaveLength(5);
    expect(readBrowseRows(dbPath, 'many', cols, BROWSE_ROW_CAP + 1000)).toHaveLength(20);
  });

  it('leaves the file untouched after reading rows too', () => {
    buildFile();
    const cols = listBrowsable(dbPath).find((o) => o.name === 'bookmarks')!.columns;
    const before = readFileSync(dbPath);

    readBrowseRows(dbPath, 'bookmarks', cols);

    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });
});

/**
 * A file that carries our bookkeeping but has an EMPTY registry while holding
 * unregistered tables of its own. Real case: a `northwind.db` opened before the
 * Open guard existed got stamped with `_easydb_docs`/`_easydb_tables`, and the
 * app then showed an empty workspace over 13 tables and 17 views.
 */
describe('a mis-stamped file', () => {
  it('still browses its real tables and views', () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE VIEW big AS SELECT name FROM customers;
    `);
    raw.exec("INSERT INTO customers (name) VALUES ('acme')");
    raw.close();
    new SqliteStore({ path: dbPath }).close(); // the stamp the pre-guard Open left

    expect(listBrowsable(dbPath).map((o) => `${o.kind}:${o.name}`)).toEqual([
      'table:customers',
      'view:big',
    ]);
  });
});

/**
 * Convert to EDA mirrors what the file STORES: its tables. A view is derived, so
 * snapshotting one would freeze a stale copy of a query next to the tables it
 * came from — and it is ruinously expensive, since a view over a big table
 * repeats that table's rows (converting `northwind.db` with its views meant
 * 1,909,973 rows instead of 625,890).
 */
describe('convertToEasydb', () => {
  it('converts tables and leaves views out', () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);
      CREATE VIEW in_stock AS SELECT name FROM items WHERE qty > 0;
    `);
    raw.exec("INSERT INTO items (name, qty) VALUES ('a', 1), ('b', 0)");
    raw.close();

    const dest = join(dir, 'converted.db');
    const result = convertToEasydb(dbPath, dest);

    expect(result.tables.map((t) => t.finalName)).toEqual(['items']);
    const store = new SqliteStore({ path: dest });
    expect((store.find('tables') as Array<{ name: string }>).map((t) => t.name)).toEqual(['items']);
    store.close();
  });
});
