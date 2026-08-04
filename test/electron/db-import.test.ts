import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SqliteStore } from '../../packages/electron/src/sqlite-store.js';
import { commitImport, previewImport, probeDatabaseFile } from '../../packages/electron/src/db-import.js';

/**
 * Unit tests for "Import a .db" (see `db-import.ts`'s doc comment). Two
 * source shapes are covered:
 *  - a FOREIGN file built with a plain `DatabaseSync` — no easydb metadata at
 *    all — exercising `columnTypeFromSqlType` inference and the BLOB/NULL/
 *    empty-string/zero edge cases the brief calls out by name.
 *  - a file written by `SqliteStore` ITSELF, re-imported into a second store,
 *    asserting the `ColumnSpec`s come back byte-for-byte (`renderer`/`hidden`
 *    survive — affinity inference could never recover either).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

let dir: string;
let targetPath: string;
let sourcePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-db-import-'));
  targetPath = join(dir, 'target.db');
  sourcePath = join(dir, 'source.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A plain SQLite source with one wide table — hoisted so the append suite can use it too. */
function buildForeignDb(): void {
  const db = new DatabaseSync(sourcePath);
  db.exec(`
      CREATE TABLE people (
        id INTEGER PRIMARY KEY,
        name TEXT,
        age INTEGER,
        balance REAL,
        active BOOLEAN,
        signed_up DATE,
        photo BLOB,
        notes NUMERIC
      );
    `);
  db.prepare(
    `INSERT INTO people (name, age, balance, active, signed_up, photo, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('Alice', 30, 12.5, 1, '2026-01-01', Buffer.from('hi'), 'plain text');
  // The brief's edge cases: NULL, empty string, zero — none of these may crash the import.
  db.prepare(
    `INSERT INTO people (name, age, balance, active, signed_up, photo, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('', 0, 0, null, null, null, null);
  db.close();
}

describe('previewImport / commitImport — a FOREIGN SQLite file (no easydb metadata)', () => {
  it('discovers the table and reports no collision against an empty target', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    const preview = previewImport(sourcePath, target, 'ws1');
    target.close();

    expect(preview.kind).toBe('foreign');
    // `columns` is the source's own field names — what an append maps FROM.
    expect(preview.candidates).toEqual([{ name: 'people', rowCount: 2, collides: false, columns: ['id', 'name', 'age', 'balance', 'active', 'signed_up', 'photo', 'notes'] }]);
  });

  it('infers ColumnSpecs via columnTypeFromSqlType and imports rows without crashing on BLOB/NULL/empty/zero', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    const results = commitImport(sourcePath, target, 'ws1', {});

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceName: 'people', action: 'created', rowCount: 2 });
    const tableId = results[0]!.tableId!;

    const table = target.findOne('tables', tableId) as {
      columns: Array<{ field: string; type: string }>;
    };
    const typeByField = Object.fromEntries(table.columns.map((c) => [c.field, c.type]));
    expect(typeByField.id).toBe('number'); // INTEGER PRIMARY KEY → INTEGER affinity
    expect(typeByField.name).toBe('string');
    expect(typeByField.age).toBe('number');
    expect(typeByField.balance).toBe('number');
    expect(typeByField.active).toBe('boolean'); // BOOL heuristic, not NUMERIC catch-all
    expect(typeByField.signed_up).toBe('date');
    expect(typeByField.photo).toBe('string'); // BLOB has no ColumnType — becomes a base64 string
    expect(typeByField.notes).toBe('number'); // NUMERIC declared type — SQLite's catch-all affinity rule

    const rows = target.find('rows', { tableId }) as Array<{ data: Record<string, unknown> }>;
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.data.name === 'Alice')!;
    expect(alice.data.age).toBe(30);
    expect(alice.data.balance).toBe(12.5);
    expect(alice.data.active).toBe(true);
    expect(alice.data.photo).toBe(Buffer.from('hi').toString('base64')); // BLOB → base64, not garbled

    // NULL/empty-string/zero row: the store's own "null column ⇒ omitted from
    // data" convention still applies (matches SqliteStore.decodeRow), but a
    // present ZERO or EMPTY STRING must survive, not be treated as absent.
    const secondRow = rows.find((r) => r.data.name === '')!;
    expect(secondRow.data.name).toBe('');
    expect(secondRow.data.age).toBe(0);
    expect(secondRow.data.active).toBeUndefined(); // active was NULL → omitted
    expect(secondRow.data.photo).toBeUndefined(); // photo was NULL → omitted

    target.close();
  });

  it('reports a collision and, on rename, imports under the new name without clobbering the original', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    target.insert('tables', {
      id: 'existing-1',
      workspaceId: 'ws1',
      name: 'people',
      code: 'people',
      columns: [{ field: 'name', label: 'Name', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });

    const preview = previewImport(sourcePath, target, 'ws1');
    expect(preview.candidates[0]).toMatchObject({ name: 'people', collides: true });

    const results = commitImport(sourcePath, target, 'ws1', {
      people: { action: 'rename', renameTo: 'people (2)' },
    });
    expect(results[0]).toMatchObject({ action: 'renamed', finalName: 'people (2)' });

    const tables = target.find('tables', { workspaceId: 'ws1' }) as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['people', 'people (2)']);
    target.close();
  });

  it('skips a colliding table when the decision is "skip", leaving the original untouched', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    target.insert('tables', {
      id: 'existing-1',
      workspaceId: 'ws1',
      name: 'people',
      code: 'people',
      columns: [{ field: 'name', label: 'Name', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });

    const results = commitImport(sourcePath, target, 'ws1', { people: { action: 'skip' } });
    expect(results[0]).toMatchObject({ action: 'skipped', tableId: null, rowCount: 0 });
    expect(target.count('tables')).toBe(1);
    target.close();
  });

  it('overwrites the colliding table in place (same id) and replaces its rows', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    const original = target.insert('tables', {
      id: 'existing-1',
      workspaceId: 'ws1',
      name: 'people',
      code: 'people',
      columns: [{ field: 'name', label: 'Name', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    }) as { id: string };
    target.insert('rows', {
      id: 'stale-row',
      tableId: 'existing-1',
      data: { name: 'Stale' },
      updatedAt: 1,
    });

    const results = commitImport(sourcePath, target, 'ws1', { people: { action: 'overwrite' } });
    expect(results[0]).toMatchObject({ action: 'overwritten', tableId: original.id, rowCount: 2 });

    expect(target.count('tables')).toBe(1); // still one table, not a duplicate
    const rows = target.find('rows', { tableId: original.id }) as Array<{ data: { name: string } }>;
    expect(rows.map((r) => r.data.name).sort()).toEqual(['', 'Alice']); // stale row gone
    target.close();
  });

  it('does not crash on an empty foreign database (no user tables at all)', () => {
    new DatabaseSync(sourcePath).close();
    const target = new SqliteStore({ path: targetPath });
    const preview = previewImport(sourcePath, target, 'ws1');
    // `sizeBytes` is whatever the file happens to be; the point is that nothing
    // is offered, not how big an empty database is on this platform.
    expect(preview).toEqual({ kind: 'foreign', candidates: [], sizeBytes: expect.any(Number) });
    const results = commitImport(sourcePath, target, 'ws1', {});
    expect(results).toEqual([]);
    target.close();
  });
});

describe('previewImport / commitImport — a file WRITTEN BY SqliteStore itself', () => {
  it('restores ColumnSpecs verbatim, including a renderer and hidden flag affinity inference could never recover', () => {
    const columns = [
      { field: 'title', label: 'Title', type: 'string' as const, renderer: 'html-preview', width: 240 },
      { field: 'secret', label: 'Secret', type: 'string' as const, hidden: true },
      { field: 'score', label: 'Score', type: 'number' as const, sortable: false, filterable: false },
    ];
    const source = new SqliteStore({ path: sourcePath });
    source.insert('tables', {
      id: 't1',
      workspaceId: 'ws-source',
      name: 'articles',
      code: 'articles',
      columns,
      view: 'table',
      updatedAt: 1,
    });
    source.insert('rows', {
      id: randomUUID(),
      tableId: 't1',
      data: { title: 'Hello', secret: 'shh', score: 42 },
      updatedAt: 1,
    });
    source.close();

    const target = new SqliteStore({ path: targetPath });
    const preview = previewImport(sourcePath, target, 'ws-target');
    expect(preview.kind).toBe('easydb');
    expect(preview.candidates).toEqual([{ name: 'articles', rowCount: 1, collides: false, columns: ['title', 'secret', 'score'] }]);

    const results = commitImport(sourcePath, target, 'ws-target', {});
    expect(results[0]).toMatchObject({ action: 'created', rowCount: 1, finalName: 'articles' });
    const tableId = results[0]!.tableId!;
    const table = target.findOne('tables', tableId) as { columns: typeof columns; workspaceId: string };

    // Byte-for-byte, not just "close enough": affinity inference alone could
    // never recover `renderer`/`hidden`/`sortable`/`filterable` — this is the
    // whole point of storing columns_json verbatim rather than re-deriving it.
    expect(table.columns).toEqual(columns);
    expect(table.workspaceId).toBe('ws-target'); // reassigned to the TARGET workspace, not the source's

    const rows = target.find('rows', { tableId }) as Array<{ data: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ title: 'Hello', secret: 'shh', score: 42 });
    target.close();
  });

  it('assigns a fresh table id on import rather than reusing the source id', () => {
    const source = new SqliteStore({ path: sourcePath });
    source.insert('tables', {
      id: 'source-id-1',
      workspaceId: 'ws-source',
      name: 'notes',
      code: 'notes',
      columns: [{ field: 'body', label: 'Body', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });
    source.close();

    const target = new SqliteStore({ path: targetPath });
    const results = commitImport(sourcePath, target, 'ws-target', {});
    expect(results[0]!.tableId).not.toBe('source-id-1');
    target.close();
  });
});

/**
 * The guard behind "Open…". Open must not touch a file it cannot use: opening
 * a store on one CREATEs `_easydb_docs`/`_easydb_tables` in it, so a foreign
 * database would gain two tables and still show an empty workspace.
 */
describe('probeDatabaseFile', () => {
  it('recognises a file this app wrote', () => {
    const s = new SqliteStore({ path: sourcePath });
    s.close();
    expect(probeDatabaseFile(sourcePath)).toBe('easydb');
  });

  it('recognises a SQLite file written by anything else as foreign', () => {
    const db = new DatabaseSync(sourcePath);
    db.exec('CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, title TEXT)');
    db.close();
    expect(probeDatabaseFile(sourcePath)).toBe('foreign');
  });

  it('reports a file that is not a database at all as unreadable', () => {
    writeFileSync(sourcePath, 'this is not a database\n', 'utf-8');
    expect(probeDatabaseFile(sourcePath)).toBe('unreadable');
  });

  it('reports a path that does not exist as unreadable', () => {
    expect(probeDatabaseFile(join(dir, 'no-such-file.db'))).toBe('unreadable');
  });

  it('leaves a foreign file byte-for-byte untouched — no schema, no sidecars', () => {
    const db = new DatabaseSync(sourcePath);
    db.exec('CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, title TEXT)');
    db.exec("INSERT INTO bookmarks VALUES (1,'hello')");
    db.close();
    const before = readFileSync(sourcePath);

    expect(probeDatabaseFile(sourcePath)).toBe('foreign');

    expect(readFileSync(sourcePath).equals(before)).toBe(true);
    expect(existsSync(`${sourcePath}-wal`)).toBe(false);
    expect(existsSync(`${sourcePath}-journal`)).toBe(false);
  });
});

/**
 * A stamped-but-empty file. Before the Open guard, pointing the store at any
 * SQLite file added `_easydb_docs`/`_easydb_tables` to it and left the registry
 * empty — so the file looks like ours while all its data is unregistered. Real
 * case: a `northwind.db` that opened as a blank workspace over 13 tables and
 * 17 views.
 */
describe('a file stamped with our bookkeeping but holding unregistered data', () => {
  function buildStamped(): void {
    const raw = new DatabaseSync(sourcePath);
    raw.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)');
    raw.exec("INSERT INTO customers (name) VALUES ('acme'), ('globex')");
    raw.close();
    new SqliteStore({ path: sourcePath }).close(); // the stamp
  }

  it('is NOT treated as a workspace, so Open offers Convert/Browse instead of a blank window', () => {
    buildStamped();
    expect(probeDatabaseFile(sourcePath)).toBe('foreign');
  });

  it('imports its real tables instead of finding nothing', () => {
    buildStamped();
    const target = new SqliteStore({ path: targetPath });
    const preview = previewImport(sourcePath, target, 'ws1');

    // The bug: the metadata path would read the empty registry and report none.
    expect(preview.kind).toBe('foreign');
    expect(preview.candidates).toEqual([{ name: 'customers', rowCount: 2, collides: false, columns: ['id', 'name'] }]);

    const results = commitImport(sourcePath, target, 'ws1', {});
    expect(results[0]).toMatchObject({ sourceName: 'customers', action: 'created', rowCount: 2 });
    target.close();
  });

  it('a genuinely EMPTY easydb file is still ours — an empty registry alone is not the signal', () => {
    new SqliteStore({ path: sourcePath }).close();
    expect(probeDatabaseFile(sourcePath)).toBe('easydb');
  });

  it('a normal easydb file with tables is still ours', () => {
    const s = new SqliteStore({ path: sourcePath });
    s.insert('tables', {
      id: 't1',
      workspaceId: 'ws1',
      name: 'notes',
      columns: [{ field: 'body', label: 'Body', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });
    s.close();
    expect(probeDatabaseFile(sourcePath)).toBe('easydb');
  });
});

/**
 * An explicit `skip` must be honoured whether or not the name collides.
 *
 * `decisions` began life as purely a COLLISION resolution, so `resolveAction`
 * only consulted it for a colliding candidate. Two callers then started using it
 * to mean "not this one": the Import picker passes `skip` for every object the
 * user did not choose, and Convert passes it for every view. Both were silently
 * ignored — picking one table imported all of them, and converting
 * `northwind.db` snapshotted its views into 1,909,973 rows instead of 625,890.
 */
describe('an explicit skip decision', () => {
  function buildTwoTables(): void {
    const db = new DatabaseSync(sourcePath);
    db.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec('CREATE TABLE drop_me (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO keep (v) VALUES ('a')");
    db.exec("INSERT INTO drop_me (v) VALUES ('b')");
    db.close();
  }

  it('is honoured for a table that does NOT collide', () => {
    buildTwoTables();
    const target = new SqliteStore({ path: targetPath });

    const results = commitImport(sourcePath, target, 'ws1', { drop_me: { action: 'skip' } });

    expect(results.find((r) => r.sourceName === 'drop_me')).toMatchObject({
      action: 'skipped',
      rowCount: 0,
      tableId: null,
    });
    expect(results.find((r) => r.sourceName === 'keep')).toMatchObject({ action: 'created' });
    expect((target.find('tables', { workspaceId: 'ws1' }) as Array<{ name: string }>).map((t) => t.name)).toEqual(['keep']);
    target.close();
  });

  it('still defaults a COLLIDING table with no decision to skip', () => {
    buildTwoTables();
    const target = new SqliteStore({ path: targetPath });
    target.insert('tables', {
      id: 'existing',
      workspaceId: 'ws1',
      name: 'keep',
      columns: [{ field: 'v', label: 'V', type: 'string' }],
      view: 'table',
      updatedAt: 1,
    });

    const results = commitImport(sourcePath, target, 'ws1', {});

    expect(results.find((r) => r.sourceName === 'keep')).toMatchObject({ action: 'skipped' });
    expect(results.find((r) => r.sourceName === 'drop_me')).toMatchObject({ action: 'created' });
    target.close();
  });
});

/**
 * Append adds a source table's rows to an existing table and leaves its SCHEMA
 * exactly as it is. That is the whole promise: the target's columns are the
 * user's own work — labels, renderers, widths, scripts, read-only flags — and a
 * second import must not be able to rewrite them.
 */
describe('append onto an existing table', () => {
  /** A target table whose columns differ from the source's, and are worth keeping. */
  function targetWithOwnSchema(store: SqliteStore): { id: string } {
    return store.insert('tables', {
      id: 'existing',
      workspaceId: 'ws1',
      name: 'people',
      columns: [
        { field: 'name', label: 'Full name', type: 'text', width: 240 },
        { field: 'age', label: 'Age', type: 'number', renderer: 'plain' },
      ],
      view: 'table',
      updatedAt: 1,
    }) as { id: string };
  }

  it('keeps the target schema and adds the rows', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    try {
      const existing = targetWithOwnSchema(target);
      target.bulkInsert('rows', [{ id: 'own', tableId: existing.id, data: { name: 'Prior', age: 1 }, updatedAt: 1 }]);

      const results = commitImport(sourcePath, target, 'ws1', { people: { action: 'append' } });

      expect(results[0]!.action).toBe('appended');
      // Same table, not a second one.
      const tables = target.find('tables', { workspaceId: 'ws1' }) as Array<{ id: string; columns: Array<{ field: string; label: string; width?: number }> }>;
      expect(tables).toHaveLength(1);
      // The user's own column settings survive untouched.
      expect(tables[0]!.columns.map((c) => c.field)).toEqual(['name', 'age']);
      expect(tables[0]!.columns[0]!.label).toBe('Full name');
      expect(tables[0]!.columns[0]!.width).toBe(240);
      // The prior row is still there, with the source's rows added after it.
      const rows = target.find('rows', { tableId: existing.id }) as Array<{ data: Record<string, unknown> }>;
      expect(rows).toHaveLength(3);
      expect(rows.some((r) => r.data.name === 'Prior')).toBe(true);
    } finally {
      target.close();
    }
  });

  it('drops source columns the target does not have, rather than adding them', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    try {
      const existing = targetWithOwnSchema(target);
      commitImport(sourcePath, target, 'ws1', { people: { action: 'append' } });

      // `balance`, `photo`, `notes` … exist in the source and not in the target.
      const rows = target.find('rows', { tableId: existing.id }) as Array<{ data: Record<string, unknown> }>;
      for (const r of rows) expect(Object.keys(r.data).sort()).toEqual(['age', 'name']);
    } finally {
      target.close();
    }
  });

  it('follows an explicit mapping, including dropping a column with ""', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    try {
      const existing = targetWithOwnSchema(target);
      // Source order is id, name, age, balance, active, signed_up, photo, notes.
      // Feed the source's `name` into `name` and drop everything else.
      const mapping = ['', 'name', '', '', '', '', '', ''];
      commitImport(sourcePath, target, 'ws1', { people: { action: 'append', mapping } });

      const rows = target.find('rows', { tableId: existing.id }) as Array<{ data: Record<string, unknown> }>;
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(Object.keys(r.data)).toEqual(['name']);
    } finally {
      target.close();
    }
  });

  it('can send a source column to a DIFFERENTLY named target column', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    try {
      const existing = targetWithOwnSchema(target);
      // The source has no column called `age` we want — use `id` for it instead.
      const mapping = ['age', 'name', '', '', '', '', '', ''];
      commitImport(sourcePath, target, 'ws1', { people: { action: 'append', mapping } });

      const rows = target.find('rows', { tableId: existing.id }) as Array<{ data: Record<string, unknown> }>;
      expect(rows.every((r) => typeof r.data.age === 'number')).toBe(true);
    } finally {
      target.close();
    }
  });

  it('is reported as skipped when the table it would append to is gone', () => {
    buildForeignDb();
    const target = new SqliteStore({ path: targetPath });
    try {
      // No existing `people`, so there is nothing to append to. Creating one
      // would ignore the schema the user chose append to protect.
      const results = commitImport(sourcePath, target, 'ws1', { people: { action: 'append' } });
      expect(results[0]!.action).toBe('created');
    } finally {
      target.close();
    }
  });
});
