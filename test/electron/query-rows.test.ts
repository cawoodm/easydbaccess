import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../packages/electron/src/sqlite-store.js';
import { matchesColumnFilter } from '../../packages/shared/src/column-filter.js';
import type { Row } from '../../packages/shared/src/types.js';

/**
 * `queryRows` exists so a reader can ask for what it needs instead of a whole
 * table. Two properties decide whether it can be trusted:
 *
 *  - it agrees with the in-memory matcher, which is the specification every
 *    existing consumer already follows;
 *  - it admits when it could not apply a predicate, rather than returning a
 *    narrower-looking answer that quietly includes excluded rows.
 */

let dir: string;
let dbPath: string;
let store: SqliteStore;
let tableId: string;

const COUNTRIES = ['Sweden', 'Norway', 'Switzerland', 'Denmark', 'Finland'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-query-'));
  dbPath = join(dir, 'q.db');
  store = new SqliteStore({ path: dbPath });
  store.insert('workspaces', { id: 'ws', name: 'ws', createdAt: 1, pluginUrls: [] });
  const t = store.insert('tables', {
    id: 't1',
    workspaceId: 'ws',
    name: 'People',
    columns: [
      { field: 'name', label: 'Name', type: 'text' },
      { field: 'country', label: 'Country', type: 'text' },
      { field: 'age', label: 'Age', type: 'number' },
      // Computed: no SQL form, so filtering or sorting on it cannot happen here.
      { field: 'badge', label: 'Badge', type: 'text', script: 'return row.name.toUpperCase()' },
    ],
    view: 'table',
    updatedAt: 1,
  }) as { id: string };
  tableId = t.id;

  store.bulkInsert(
    'rows',
    Array.from({ length: 500 }, (_, i) => ({
      id: `r${String(i).padStart(4, '0')}`,
      tableId,
      data: { name: `Person ${i}`, country: COUNTRIES[i % COUNTRIES.length], age: 20 + (i % 50) },
      updatedAt: 1,
    })),
  );
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('queryRows', () => {
  it('returns a slice, with the MATCHING total rather than the returned count', () => {
    const page = store.queryRows(tableId, { limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(500);
    expect(page.partial).toBeUndefined();
  });

  it('pages without repeating or skipping a row', () => {
    const first = store.queryRows(tableId, { limit: 20, offset: 0 });
    const second = store.queryRows(tableId, { limit: 20, offset: 20 });
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(40); // no overlap
  });

  it('filters in SQL, agreeing with the in-memory matcher', () => {
    for (const filter of ['Sweden', 'Sweden,Norway', '!Sweden', '^S', '=Norway', '!NULL AND Swe']) {
      const page = store.queryRows(tableId, { filters: { country: filter } });
      const expected = (store.find('rows', { tableId }) as Row[]).filter((r) => matchesColumnFilter(r.data.country, filter));
      expect(page.total, `total for ${filter}`).toBe(expected.length);
      expect(page.rows.map((r) => r.id).sort(), `rows for ${filter}`).toEqual(expected.map((r) => r.id).sort());
    }
  });

  it('searches across columns', () => {
    const page = store.queryRows(tableId, { search: 'Norway' });
    expect(page.total).toBe(100);
    expect(page.rows.every((r) => r.data.country === 'Norway')).toBe(true);
  });

  it('sorts in SQL', () => {
    const desc = store.queryRows(tableId, { sort: [{ field: 'age', asc: false }], limit: 5 });
    const ages = desc.rows.map((r) => Number(r.data.age));
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
    expect(Math.max(...ages)).toBe(69);
  });

  it('returns only the fields asked for', () => {
    const page = store.queryRows(tableId, { fields: ['name'], limit: 1 });
    expect(Object.keys(page.rows[0]!.data)).toEqual(['name']);
  });

  it('admits it is partial when a filter names a computed column', () => {
    // `badge` only exists once its script runs, so SQL cannot narrow on it. The
    // rows are a superset and the caller must filter again — saying so is the
    // difference between that and silently returning excluded rows.
    const page = store.queryRows(tableId, { filters: { badge: 'PERSON 1' } });
    expect(page.partial).toBe(true);
    expect(page.total).toBe(500);
  });

  it('admits it is partial when a sort names a computed column', () => {
    const page = store.queryRows(tableId, { sort: [{ field: 'badge', asc: true }], limit: 5 });
    expect(page.partial).toBe(true);
  });

  it('combines a filter with a sort and a slice consistently', () => {
    const page = store.queryRows(tableId, {
      filters: { country: 'Sweden' },
      sort: [{ field: 'age', asc: true }],
      limit: 3,
    });
    expect(page.total).toBe(100);
    expect(page.rows).toHaveLength(3);
    expect(page.rows.every((r) => r.data.country === 'Sweden')).toBe(true);
    const ages = page.rows.map((r) => Number(r.data.age));
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });

  it('is unknown-table safe rather than throwing', () => {
    expect(store.queryRows('nope', { limit: 5 })).toEqual({ rows: [], total: 0 });
  });

  /**
   * An `array` cell holds several values in one column and is matched per MEMBER
   * (`a,b` or `["a","b"]`). SQL sees one string, so `=b` and `NULL` would answer
   * differently — NARROWER than the matcher, which is the one failure `partial`
   * cannot excuse. So the predicate is not applied at all and the page says so.
   */
  it('will not narrow on an array column, and admits it', () => {
    const arr = 'arr';
    store.insert('tables', {
      id: arr,
      workspaceId: 'ws',
      name: 'Tagged',
      columns: [
        { field: 'name', label: 'Name', type: 'text' },
        { field: 'tags', label: 'Tags', type: 'array' },
      ],
      view: 'table',
      updatedAt: 1,
    });
    store.bulkInsert('rows', [
      { id: 'x1', tableId: arr, data: { name: 'one', tags: 'alpha,beta' }, updatedAt: 1 },
      { id: 'x2', tableId: arr, data: { name: 'two', tags: 'gamma' }, updatedAt: 1 },
    ]);

    const page = store.queryRows(arr, { filters: { tags: '=beta' } });
    expect(page.partial).toBe(true);
    // Every row comes back — a superset the caller re-filters with the member
    // rules. Two rows here, NOT the one a raw LIKE would have let through.
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
  });

  it('will not sort by an array column either', () => {
    // The grid orders array cells by their members as they READ (`a, b`), which
    // is not the stored text — so ORDER BY on the raw column is a different order.
    const arr2 = 'arr2';
    store.insert('tables', {
      id: arr2,
      workspaceId: 'ws',
      name: 'Tagged2',
      columns: [{ field: 'tags', label: 'Tags', type: 'array' }],
      view: 'table',
      updatedAt: 1,
    });
    store.bulkInsert('rows', [{ id: 'y1', tableId: arr2, data: { tags: 'b,a' }, updatedAt: 1 }]);
    expect(store.queryRows(arr2, { sort: [{ field: 'tags', asc: true }] }).partial).toBe(true);
  });

  /**
   * The reason the contract exists: asking for a screenful must not cost what
   * asking for everything costs. Ratio rather than absolute times, so the test
   * does not become a flaky benchmark on a loaded machine.
   */
  it('costs far less than fetching the whole table', () => {
    const big = 'big';
    store.insert('tables', {
      id: big,
      workspaceId: 'ws',
      name: 'Big',
      columns: Array.from({ length: 12 }, (_, c) => ({ field: `c${c}`, label: `c${c}`, type: 'text' as const })),
      view: 'table',
      updatedAt: 1,
    });
    store.bulkInsert(
      'rows',
      Array.from({ length: 20000 }, (_, i) => ({
        id: `b${i}`,
        tableId: big,
        data: Object.fromEntries(Array.from({ length: 12 }, (_, c) => [`c${c}`, `value ${i}-${c} padding padding`])),
        updatedAt: 1,
      })),
    );

    const t0 = Date.now();
    const all = store.find('rows', { tableId: big });
    const wholeMs = Date.now() - t0;

    const t1 = Date.now();
    const page = store.queryRows(big, { limit: 30 });
    const pageMs = Date.now() - t1;

    expect(all).toHaveLength(20000);
    expect(page.rows).toHaveLength(30);
    expect(page.total).toBe(20000);
    // A screenful is a tiny fraction of the work, even counting the COUNT(*).
    expect(pageMs * 5).toBeLessThan(wholeMs);
  });
});
