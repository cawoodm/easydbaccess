import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ColumnSpec, Table } from '../../packages/shared/src/types.js';
import { EdbStore } from '../../packages/shared/src/edb-store.js';
import { nodeSqliteDriver } from './node-sqlite-driver.js';

/**
 * Raw SQL against a workspace.
 *
 * The load-bearing claim is that a read cannot write. It is asserted against a
 * real SQLite rather than by reading the implementation, because the guarantee
 * comes from `PRAGMA query_only` and not from anything this repo can inspect.
 */

let driver: ReturnType<typeof nodeSqliteDriver>;
let store: EdbStore;

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'qty', label: 'Qty', type: 'number' },
];

const table = (over: Partial<Table> = {}) => ({ id: 't1', workspaceId: 'w1', name: 'Parts', columns: COLUMNS, updatedAt: 1, ...over }) as unknown as Record<string, unknown>;
const row = (id: string, data: Record<string, unknown>, tableId = 't1') => ({ id, tableId, data, updatedAt: 7 });

beforeEach(() => {
  driver = nodeSqliteDriver();
  store = new EdbStore(driver);
  store.insert('tables', table());
  store.bulkInsert('rows', [row('r1', { name: 'bolt', qty: 4 }), row('r2', { name: 'nut', qty: 9 })]);
});

afterEach(() => {
  driver.close();
});

describe('reading', () => {
  it('returns columns in result order and rows aligned to them', () => {
    const res = store.runSql('SELECT name, qty FROM "Parts" ORDER BY name');
    expect(res.columns).toEqual(['name', 'qty']);
    expect(res.rows).toEqual([
      ['bolt', 4],
      ['nut', 9],
    ]);
  });

  it('reads the user table as a real SQL table — the point of the format', () => {
    expect(store.runSql(`SELECT COUNT(*) AS n FROM "Parts"`).rows).toEqual([[2]]);
  });

  it('binds parameters rather than making the caller interpolate', () => {
    const res = store.runSql('SELECT name FROM "Parts" WHERE qty > ?', { params: [5] });
    expect(res.rows).toEqual([['nut']]);
  });

  it('reports no columns for a query that matched nothing', () => {
    const res = store.runSql('SELECT name FROM "Parts" WHERE qty > 100');
    expect(res.rows).toEqual([]);
    expect(res.columns).toEqual([]);
  });

  it('reports changes as null for a read, not zero', () => {
    // Zero would read as "a write that changed nothing".
    expect(store.runSql('SELECT 1 AS one').changes).toBeNull();
  });

  it('caps the result at maxRows and says it did', () => {
    const res = store.runSql('SELECT name FROM "Parts" ORDER BY name', { maxRows: 1 });
    expect(res.rows).toEqual([['bolt']]);
    expect(res.truncated).toBe(true);
  });

  it('does not claim truncation when the result fits', () => {
    expect(store.runSql('SELECT name FROM "Parts"', { maxRows: 2 }).truncated).toBe(false);
  });
});

describe('a read cannot write', () => {
  it('refuses an UPDATE', () => {
    expect(() => store.runSql(`UPDATE "Parts" SET name = 'x'`)).toThrow();
    expect(store.runSql(`SELECT COUNT(*) AS n FROM "Parts" WHERE name = 'x'`).rows).toEqual([[0]]);
  });

  it('refuses a DELETE', () => {
    expect(() => store.runSql(`DELETE FROM "Parts"`)).toThrow();
    expect(store.countRowsIn('t1')).toBe(2);
  });

  it('refuses a DROP of the registry itself', () => {
    expect(() => store.runSql('DROP TABLE _easydb')).toThrow();
    expect(store.find('tables')).toHaveLength(1);
  });

  it('refuses a write hidden behind a CTE, which keyword-sniffing would miss', () => {
    // The whole reason enforcement is SQLite's job: this statement starts with
    // the word WITH.
    expect(() => store.runSql(`WITH doomed AS (SELECT _id FROM "Parts") DELETE FROM "Parts" WHERE _id IN (SELECT _id FROM doomed)`)).toThrow();
    expect(store.countRowsIn('t1')).toBe(2);
  });

  it('leaves the connection writable after a refused write', () => {
    expect(() => store.runSql(`DELETE FROM "Parts"`)).toThrow();
    // query_only must have come back off, or every later write fails with a
    // message pointing nowhere near the cause.
    expect(() => store.insert('rows', row('r3', { name: 'washer' }))).not.toThrow();
    expect(store.countRowsIn('t1')).toBe(3);
  });

  it('leaves the connection writable after a plain syntax error', () => {
    expect(() => store.runSql('SELECT nonsense FROM nowhere')).toThrow();
    expect(() => store.insert('rows', row('r4', { name: 'nut2' }))).not.toThrow();
  });
});

describe('writing, when the caller asks for it', () => {
  it('applies the write and reports how many rows it changed', () => {
    const res = store.runSql(`UPDATE "Parts" SET qty = 0`, { write: true });
    expect(res.changes).toBe(2);
    expect(store.runSql(`SELECT COUNT(*) AS n FROM "Parts" WHERE qty = 0`).rows).toEqual([[2]]);
  });

  it('is visible through the store contract, not just to SQL', () => {
    store.runSql(`DELETE FROM "Parts" WHERE name = 'nut'`, { write: true });
    expect(store.countRowsIn('t1')).toBe(1);
    expect(store.find('rows', { tableId: 't1' })).toHaveLength(1);
  });

  it('reports zero changes for a write that matched nothing', () => {
    expect(store.runSql(`DELETE FROM "Parts" WHERE name = 'absent'`, { write: true }).changes).toBe(0);
  });

  it('can still return rows — RETURNING is a write that reads', () => {
    const res = store.runSql(`DELETE FROM "Parts" WHERE name = 'nut' RETURNING name`, { write: true });
    expect(res.rows).toEqual([['nut']]);
  });
});

describe('the row cap is a fetch cap, not a render cap', () => {
  it('stops reading at the cap instead of materialising the whole result', () => {
    // Proven by counting what the driver was asked for: `all()` would pull every
    // row and slice after. A 609k-row table is the case this protects.
    let iterated = 0;
    const counting = {
      exec: (sql: string) => driver.exec(sql),
      prepare: (sql: string) => {
        const inner = driver.prepare(sql);
        return {
          get: (...p: unknown[]) => inner.get(...p),
          all: (...p: unknown[]) => inner.all(...p),
          run: (...p: unknown[]) => inner.run(...p),
          *iterate(...p: unknown[]) {
            for (const row of inner.iterate!(...p)) {
              iterated++;
              yield row;
            }
          },
        };
      },
    };
    const counted = new EdbStore(counting);
    counted.insert('tables', table({ id: 'big', name: 'Big' }));
    counted.bulkInsert(
      'rows',
      Array.from({ length: 50 }, (_, i) => row(`b${i}`, { name: `n${i}` }, 'big')),
    );

    iterated = 0;
    const res = counted.runSql('SELECT * FROM "Big"', { maxRows: 5 });
    expect(res.rows).toHaveLength(5);
    expect(res.truncated).toBe(true);
    // One past the cap is what makes `truncated` knowable; anything more is waste.
    expect(iterated).toBe(6);
  });
});

describe('changes(), across a script', () => {
  it('reports nothing for a SELECT that follows a write', () => {
    // SQLite does not reset `changes()` on a SELECT, so reporting it whenever
    // `write` was asked for made a caller summing a script double-count.
    store.runSql(`UPDATE "Parts" SET qty = 0`, { write: true });
    const read = store.runSql(`SELECT name FROM "Parts"`, { write: true });
    expect(read.changes).toBeNull();
  });

  it('still reports the count for the write itself', () => {
    expect(store.runSql(`UPDATE "Parts" SET qty = 1`, { write: true }).changes).toBe(2);
  });
});
