import { beforeEach, describe, expect, it } from 'vitest';
import type { Table as DexieTable } from 'dexie';
import type { Row, Table } from '../../../packages/shared/src/types.js';
import { assertIncomingFits, assertRoomForRows, BROWSER_ROW_LIMIT, forgetRowBudget, RowLimitError, rowLimitMessage, __setBrowserStore } from '../../../packages/renderer/src/db/row-budget.js';

/**
 * The hard limit on a browser workspace: 10,000 rows.
 *
 * Two properties matter more than the number, and both are about not lying to the
 * user:
 *
 * 1. **A refusal is always measured.** The cached total is only ever too HIGH (a
 *    delete in another tab, a sync pull), so a check about to say no must count
 *    first, or a user loses a write they were entitled to.
 * 2. **Counting stops at the limit.** The answer is only compared against 10,000,
 *    and walking the index is what costs 14 s on a big table.
 *
 * A hand-written fake rather than Dexie on a fake IndexedDB, following
 * `delete-workspace.test.ts`: what is under test is which reads this module
 * issues, so they are logged and asserted.
 */

interface Seed {
  tables: Array<{ id: string; workspaceId: string }>;
  rows: Array<{ id: string; tableId: string }>;
}

function fakeDb(seed: Seed) {
  const log: string[] = [];
  const rows = {
    where(field: string) {
      expect(field).toBe('tableId');
      return {
        anyOf(ids: string[]) {
          const matching = seed.rows.filter((r) => ids.includes(r.tableId));
          return {
            limit(n: number) {
              return {
                primaryKeys: async () => {
                  // The fake must behave like Dexie here or the test proves nothing:
                  // `limit` bounds the WALK, so at most n+... keys come back.
                  log.push(`rows.primaryKeys(limit=${n})`);
                  return matching.slice(0, n).map((r) => r.id);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as DexieTable<Row, string>;

  const tables = {
    get: async (id: string) => {
      log.push(`tables.get(${id})`);
      return seed.tables.find((t) => t.id === id) as Table | undefined;
    },
    where(field: string) {
      expect(field).toBe('workspaceId');
      return {
        equals(ws: string) {
          return {
            primaryKeys: async () => {
              log.push(`tables.primaryKeys(${ws})`);
              return seed.tables.filter((t) => t.workspaceId === ws).map((t) => t.id);
            },
          };
        },
      };
    },
  } as unknown as DexieTable<Table, string>;

  return { rows, tables, log };
}

/** `n` rows spread over the given tables. */
function seedRows(tableId: string, n: number): Array<{ id: string; tableId: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `${tableId}-r${i}`, tableId }));
}

const TABLES = [
  { id: 't1', workspaceId: 'ws' },
  { id: 't2', workspaceId: 'ws' },
  { id: 'other', workspaceId: 'ws2' },
];

beforeEach(() => {
  forgetRowBudget();
  // The rows view's own check does not consult this flag (it only ever runs inside
  // the Dexie store); the pre-flight does, so most tests want it on.
  __setBrowserStore(true);
});

describe('the number', () => {
  it('is ten thousand', () => {
    // Deliberately pessimistic: the first thing to go over a second in IndexedDB is
    // the per-column filter, at about 12,000 rows. See the analysis in
    // `.claude/plans/2026-08-13-sqlite-threshold.md`.
    expect(BROWSER_ROW_LIMIT).toBe(10_000);
  });

  it('is in the message, with the total that was refused and where to go', () => {
    const msg = rowLimitMessage(9_000, 33_318, 10_000);
    // Grouped through `toLocaleString`, so the expectation has to be too: Node here
    // is Swiss (10’000) where a browser may be en-US (10,000).
    expect(msg).toContain(`${(10_000).toLocaleString()} rows`);
    expect(msg).toContain((42_318).toLocaleString());
    expect(msg).toContain('New .edb file');
  });
});

describe('assertIncomingFits — the pre-flight that saves a wipe-then-write', () => {
  it('says nothing at all where the browser store is not in use', () => {
    // Electron and a `.edb` session both build a different store, and neither has a
    // limit. A store-agnostic caller must not refuse a 40,000-row pull into a file.
    __setBrowserStore(false);
    expect(() => assertIncomingFits(40_000)).not.toThrow();
  });

  it('refuses an incoming set bigger than the limit', () => {
    __setBrowserStore(true);
    expect(() => assertIncomingFits(10_001)).toThrow(RowLimitError);
  });

  it('allows what will fit once the wipe has freed the room', () => {
    // The caller is about to delete the whole workspace, so only the incoming size
    // is judged — an import of 9,000 into a full workspace is exactly the case that
    // has to keep working.
    __setBrowserStore(true);
    expect(() => assertIncomingFits(9_000)).not.toThrow();
  });
});

describe('assertRoomForRows', () => {
  it('allows a write that fits', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 100) });
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 50)).resolves.toBeUndefined();
  });

  it('refuses the write that would cross the limit, before anything is written', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 9_990) });
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 20)).rejects.toThrow(RowLimitError);
  });

  it('counts every table of the workspace, not just the one being written', async () => {
    // The measured cost is per DATABASE — Dexie keeps every table's rows in one
    // store — so twenty tables of 10,000 must not slip through a per-table check.
    const db = fakeDb({ tables: TABLES, rows: [...seedRows('t1', 6_000), ...seedRows('t2', 4_500)] });
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 1)).rejects.toThrow(RowLimitError);
  });

  it('ignores rows belonging to another workspace', async () => {
    const db = fakeDb({ tables: TABLES, rows: [...seedRows('t1', 100), ...seedRows('other', 20_000)] });
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 100)).resolves.toBeUndefined();
  });

  it('reports how far over the write went', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 8_000) });
    const err = await assertRoomForRows(db.rows, db.tables, 't1', 5_000).catch((e: unknown) => e as RowLimitError);
    expect(err).toBeInstanceOf(RowLimitError);
    expect((err as RowLimitError).used).toBe(8_000);
    expect((err as RowLimitError).incoming).toBe(5_000);
    expect((err as RowLimitError).max).toBe(10_000);
  });

  it('never counts past the limit, however big the table is', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 50_000) });
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 1)).rejects.toThrow(RowLimitError);
    // 10,001 keys, not 50,000: the walk is what costs seconds on a real store.
    expect(db.log).toContain('rows.primaryKeys(limit=10001)');
  });

  it('does not read the store again for a write that the cached total covers', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 100) });
    await assertRoomForRows(db.rows, db.tables, 't1', 10);
    const reads = db.log.filter((l) => l.startsWith('rows.')).length;
    await assertRoomForRows(db.rows, db.tables, 't1', 10);
    expect(db.log.filter((l) => l.startsWith('rows.')).length).toBe(reads);
  });

  it('MEASURES before refusing, so a stale total cannot cost a legal write', async () => {
    // The store holds 100 rows. Spend the budget up to the limit through the cache,
    // then have the rows disappear (a delete elsewhere, a sync). The next check must
    // count rather than believe the total it accumulated.
    const seed: Seed = { tables: TABLES, rows: seedRows('t1', 100) };
    const db = fakeDb(seed);
    await assertRoomForRows(db.rows, db.tables, 't1', 9_800);
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 500)).resolves.toBeUndefined();
  });

  it('lets a write through when the table has no record yet', async () => {
    // The first write of an import can land before the table row does. Refusing it
    // would break a legitimate import; the next write is counted.
    const db = fakeDb({ tables: TABLES, rows: [] });
    await expect(assertRoomForRows(db.rows, db.tables, 'unknown', 1)).resolves.toBeUndefined();
  });

  it('says nothing about a write of nothing', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 10_000) });
    await expect(assertRoomForRows(db.rows, db.tables, 't1', 0)).resolves.toBeUndefined();
    expect(db.log).toEqual([]);
  });

  it('forgets one workspace without forgetting the others', async () => {
    const db = fakeDb({ tables: TABLES, rows: seedRows('t1', 100) });
    await assertRoomForRows(db.rows, db.tables, 't1', 10);
    forgetRowBudget('ws');
    await assertRoomForRows(db.rows, db.tables, 't1', 10);
    expect(db.log.filter((l) => l.startsWith('rows.')).length).toBe(2);
  });
});
