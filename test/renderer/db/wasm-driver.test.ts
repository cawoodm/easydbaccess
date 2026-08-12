import { beforeAll, describe, expect, it } from 'vitest';
import { EdbStore } from '../../../packages/shared/src/edb-store.js';
import { wasmDriver } from '../../../packages/renderer/src/db/edb/wasm-driver.js';

/**
 * The claim the whole design rests on: `EdbStore` is one body of code that runs
 * unchanged on two SQLite bindings. `edb-store.test.ts` proves it against
 * `node:sqlite`; this proves the same store against the WASM build the browser
 * will actually use.
 *
 * sqlite-wasm ships a Node entry, so this runs under plain vitest — no browser,
 * no worker, no OPFS. If the driver shim were wrong, the store would fail here
 * exactly as it would in the browser.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;

beforeAll(async () => {
  const mod = await import('@sqlite.org/sqlite-wasm');
  sqlite3 = await mod.default();
});

function freshStore() {
  const driver = wasmDriver(sqlite3, new sqlite3.oo1.DB(':memory:'));
  return { driver, store: new EdbStore(driver) };
}

const COLUMNS = [
  { field: 'name', label: 'Name', type: 'string' as const },
  { field: 'qty', label: 'Qty', type: 'number' as const },
  { field: 'done', label: 'Done', type: 'boolean' as const },
];

describe('EdbStore on sqlite-wasm', () => {
  it('creates the v2 schema and stamps the format', () => {
    const { driver, store } = freshStore();
    expect(store.format()).toEqual({ version: 2, app: 'easydbaccess' });
    driver.close();
  });

  it('makes a user table a real SQL table with one column per spec', () => {
    const { driver, store } = freshStore();
    store.insert('tables', { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1 });
    const cols = driver
      .prepare(`PRAGMA table_info("Parts")`)
      .all()
      .map((c) => String(c.name));
    expect(cols).toEqual(['_id', '_updatedAt', '_extra', 'name', 'qty', 'done']);
    driver.close();
  });

  it('round-trips a row, overflow field and all', () => {
    const { driver, store } = freshStore();
    store.insert('tables', { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1 });
    const written = { id: 'r1', tableId: 't1', data: { name: 'bolt', qty: 4, done: true, ghost: 'kept' }, updatedAt: 7 };
    store.insert('rows', written);
    expect(store.findOne('rows', 'r1')).toEqual(written);
    driver.close();
  });

  it('survives a cached statement being reused across different bindings', () => {
    // The driver caches by SQL text, so the same INSERT is re-bound thousands of
    // times in a bulk import. A missing reset would leak the previous row's
    // values into the next one.
    const { driver, store } = freshStore();
    store.insert('tables', { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1 });
    store.bulkInsert(
      'rows',
      Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, tableId: 't1', data: { name: `p${i}`, qty: i }, updatedAt: 7 })),
    );
    expect(store.countRowsIn('t1')).toBe(200);
    // qty 0 is falsy but present, and must survive as 0 — only a NULL is dropped.
    expect((store.findOne('rows', 'r0') as { data: Record<string, unknown> }).data).toEqual({ name: 'p0', qty: 0 });
    expect((store.findOne('rows', 'r199') as { data: Record<string, unknown> }).data).toEqual({ name: 'p199', qty: 199 });
    driver.close();
  });

  it('filters and sorts through queryRows', () => {
    const { driver, store } = freshStore();
    store.insert('tables', { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1 });
    store.bulkInsert('rows', [
      { id: 'r1', tableId: 't1', data: { name: 'bolt', qty: 3 }, updatedAt: 7 },
      { id: 'r2', tableId: 't1', data: { name: 'nut', qty: 1 }, updatedAt: 7 },
    ]);
    const page = store.queryRows('t1', { sort: [{ field: 'qty', asc: true }] });
    expect(page.rows.map((r) => r.data.name)).toEqual(['nut', 'bolt']);
    expect(page.total).toBe(2);
    driver.close();
  });

  it('exports bytes that are a valid SQLite file', () => {
    const { driver, store } = freshStore();
    store.insert('tables', { id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1 });
    const bytes = driver.export();
    // Every SQLite file starts with this 16-byte magic string. Without it, Save
    // would write something no other tool could open.
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3');
    expect(bytes.byteLength).toBeGreaterThan(0);
    driver.close();
  });
});
