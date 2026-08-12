import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../packages/electron/src/sqlite-store.js';

/**
 * `distinctValues` is the funnel's value list, answered with `GROUP BY` so the
 * whole column can be offered at any table size without a row crossing IPC.
 *
 * What has to be true: the values are faceted by the OTHER filters, an empty cell
 * is counted as a blank rather than as a value, and a column SQL cannot group is
 * admitted rather than answered narrowly — a scripted one has no stored value at
 * all, and an `array` cell holds several values that a `GROUP BY` cannot see into.
 */

let dir: string;
let store: SqliteStore;
let tableId: string;

const COUNTRIES = ['Sweden', 'Sweden', 'Sweden', 'Norway', 'Norway', 'Denmark'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-distinct-'));
  store = new SqliteStore({ path: join(dir, 'd.db') });
  store.insert('workspaces', { id: 'ws', name: 'ws', createdAt: 1, pluginUrls: [] });
  const t = store.insert('tables', {
    id: 't1',
    workspaceId: 'ws',
    name: 'People',
    columns: [
      { field: 'name', label: 'Name', type: 'text' },
      { field: 'country', label: 'Country', type: 'text' },
      { field: 'tags', label: 'Tags', type: 'array' },
      { field: 'badge', label: 'Badge', type: 'text', script: 'return row.name.toUpperCase()' },
    ],
    view: 'table',
    updatedAt: 1,
  }) as { id: string };
  tableId = t.id;
  store.bulkInsert(
    'rows',
    COUNTRIES.map((country, i) => ({
      id: `r${i}`,
      tableId,
      data: { name: `Person ${i}`, country, tags: i % 2 === 0 ? 'red,blue' : 'blue' },
      updatedAt: 1,
    })),
  );
  // One row with nothing in `country` — a blank, not a value.
  store.insert('rows', { id: 'rx', tableId, data: { name: 'Nobody', country: '', tags: '' }, updatedAt: 1 });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('distinctValues', () => {
  it('counts each value, commonest first, and blanks separately', () => {
    const page = store.distinctValues(tableId, { field: 'country' });
    expect(page.values).toEqual([
      { value: 'Sweden', count: 3 },
      { value: 'Norway', count: 2 },
      { value: 'Denmark', count: 1 },
    ]);
    expect(page.blanks).toBe(1);
    expect(page.partial).toBeUndefined();
    expect(page.truncated).toBeUndefined();
  });

  it('facets by the other filters', () => {
    // Only the rows a `name` filter keeps are counted. The caller leaves this
    // column's OWN filter out, which is what keeps a picked value from narrowing
    // its own list to itself.
    const page = store.distinctValues(tableId, { field: 'country', where: { filters: { name: 'Person 0' } } });
    expect(page.values).toEqual([{ value: 'Sweden', count: 1 }]);
    expect(page.blanks).toBe(0);
  });

  it('says truncated rather than passing a cut list off as the column', () => {
    const page = store.distinctValues(tableId, { field: 'country', limit: 2 });
    expect(page.values).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it('hands an array column its CELLS, flagged, because SQL cannot see members', () => {
    const page = store.distinctValues(tableId, { field: 'tags' });
    expect(page.cells).toBe(true);
    // The cells, not the members: `red,blue` is one group here.
    expect(page.values.map((v) => v.value)).toEqual(['blue', 'red,blue']);
    expect(page.blanks).toBe(1);
    // `cells` is not `partial`: nothing was dropped from the WHERE.
    expect(page.partial).toBeUndefined();
  });

  it('refuses a scripted column instead of answering with empties', () => {
    // The stored cell behind a script holds nothing, so grouping it would offer
    // one blank where the grid plainly shows a value.
    const page = store.distinctValues(tableId, { field: 'badge' });
    expect(page.values).toEqual([]);
    expect(page.partial).toBe(true);
  });

  it('reports partial when a filter had no SQL form', () => {
    // A filter on the scripted column cannot become a WHERE clause, so the counts
    // cover more rows than the caller asked about — which is what `partial` says.
    const page = store.distinctValues(tableId, { field: 'country', where: { filters: { badge: 'PERSON 0' } } });
    expect(page.partial).toBe(true);
    expect(page.values.length).toBeGreaterThan(1);
  });

  it('answers an unknown table with nothing, not a throw', () => {
    expect(store.distinctValues('nope', { field: 'country' })).toEqual({ values: [] });
  });
});
