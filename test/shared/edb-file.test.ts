import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EdbStore } from '../../packages/shared/src/edb-store.js';
import { nodeSqliteDriver } from './node-sqlite-driver.js';

/**
 * The claim the `.edb` format exists to make: a saved file is a genuine SQLite
 * database, and everything in it survives being closed and reopened.
 *
 * The suites in `edb-store.test.ts` run in memory, where a bug that never
 * actually writes a page would pass unnoticed. This one goes through a real file
 * on disk, and reads the reopened database with plain SQL — the way DB Browser
 * or Datasette would — rather than through the store that wrote it.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edb-'));
  path = join(dir, 'workspace.edb');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const COLUMNS = [
  { field: 'name', label: 'Name', type: 'string' as const },
  { field: 'qty', label: 'Qty', type: 'number' as const },
];

function seed(): void {
  const driver = nodeSqliteDriver(path);
  const store = new EdbStore(driver);
  store.insert('workspaces', { id: 'w1', name: 'Work' });
  store.insert('tables', { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1 });
  store.bulkInsert('rows', [
    { id: 'r1', tableId: 't1', data: { name: 'bolt', qty: 4 }, updatedAt: 7 },
    { id: 'r2', tableId: 't1', data: { name: 'nut', qty: 9 }, updatedAt: 7 },
  ]);
  driver.close();
}

describe('a saved .edb', () => {
  it('reads back through the store after a close and reopen', () => {
    seed();
    const driver = nodeSqliteDriver(path);
    const store = new EdbStore(driver);
    expect(store.findOne('workspaces', 'w1')).toMatchObject({ name: 'Work' });
    expect(store.countRowsIn('t1')).toBe(2);
    expect(store.findOne('rows', 'r1')).toEqual({ id: 'r1', tableId: 't1', data: { name: 'bolt', qty: 4 }, updatedAt: 7 });
    driver.close();
  });

  it('is readable as ordinary SQL by a tool that knows nothing about this app', () => {
    seed();
    const driver = nodeSqliteDriver(path);
    // No EdbStore here on purpose — this is what DB Browser sees.
    const rows = driver.prepare(`SELECT name, qty FROM "Parts" ORDER BY qty`).all();
    expect(rows).toEqual([
      { name: 'bolt', qty: 4 },
      { name: 'nut', qty: 9 },
    ]);
    driver.close();
  });

  it('carries its format stamp across the reopen', () => {
    seed();
    const driver = nodeSqliteDriver(path);
    expect(new EdbStore(driver).format()).toEqual({ version: 2, app: 'easydbaccess' });
    driver.close();
  });

  it('holds exactly one meta table beside the user tables', () => {
    seed();
    const driver = nodeSqliteDriver(path);
    const names = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => String(r.name));
    expect(names).toEqual(['Parts', '_easydb']);
    driver.close();
  });

  it('reopens cleanly a second time, without the schema step disturbing what is there', () => {
    seed();
    for (let i = 0; i < 3; i++) {
      const driver = nodeSqliteDriver(path);
      const store = new EdbStore(driver);
      expect(store.countRowsIn('t1')).toBe(2);
      driver.close();
    }
  });
});
