import { describe, expect, it } from 'vitest';
import { DELETE_CHUNK, deleteAllRows, deleteVisibleRows, removeRowIds } from '../../../packages/renderer/src/table/delete-rows.js';
import type { RowRequest } from '../../../packages/renderer/src/db/row-reader.js';
import type { ColumnSpec, DataCollection, Row, RowPage, RowQuery } from '../../../packages/shared/src/index.js';

/**
 * The two data deletes behind the footer's trash button.
 *
 * Three things here are the point, and each of them was a way to get this wrong:
 *
 * 1. "Visible" is every row that MATCHES, not the page on screen. A windowed grid
 *    holds 500 rows of a filtered table, and deleting those would leave the rest.
 * 2. The read that finds them is uncapped. `ROW_FETCH_CAP` stops a GRID drawing too
 *    much, but a delete that stopped at 20,000 would report success and leave rows.
 * 3. The sort is dropped. It cannot change which rows match, and sorting a big
 *    table in IndexedDB costs seconds.
 */

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'country', label: 'Country', type: 'string' },
];

/** `n` rows, half of them Swedish. */
function manyRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    tableId: 't',
    data: { name: `n${i}`, country: i % 2 === 0 ? 'Sweden' : 'Norway' },
    updatedAt: 1,
  }));
}

/**
 * A collection that really removes what it is told to, and records every call —
 * both what came back out and what was asked of the backend.
 */
function fakeColl(opts: { rows?: Row[]; supportsQuery?: boolean } = {}) {
  let rows = opts.rows ?? manyRows(4);
  const seen: { finds: number; queries: RowQuery[]; removals: string[][] } = { finds: 0, queries: [], removals: [] };
  const coll: Partial<DataCollection<Row>> = {
    find: async () => {
      seen.finds++;
      return rows;
    },
    bulkRemove: async (ids: string[]) => {
      seen.removals.push(ids);
      const gone = new Set(ids);
      rows = rows.filter((r) => !gone.has(r.id));
    },
  };
  if (opts.supportsQuery === true) {
    coll.query = async (q: RowQuery): Promise<RowPage> => {
      seen.queries.push(q);
      let out = rows;
      for (const [field, expr] of Object.entries(q.filters ?? {})) {
        out = out.filter((r) => String(r.data[field]).toLowerCase().includes(expr.toLowerCase()));
      }
      const total = out.length;
      const from = q.offset ?? 0;
      if (q.limit != null) out = out.slice(from, from + q.limit);
      else if (from > 0) out = out.slice(from);
      return { rows: out, total };
    };
  }
  return { coll: coll as DataCollection<Row>, seen, left: () => rows };
}

const req = (over: Partial<RowRequest> = {}): RowRequest => ({ columns: COLUMNS, ...over });

describe('removeRowIds', () => {
  it('removes nothing, and calls nothing, for an empty list', async () => {
    const { coll, seen } = fakeColl();
    expect(await removeRowIds(coll, [])).toBe(0);
    expect(seen.removals).toEqual([]);
  });

  it('takes one call for a small list', async () => {
    const { coll, seen, left } = fakeColl();
    expect(await removeRowIds(coll, ['r0', 'r2'])).toBe(2);
    expect(seen.removals).toEqual([['r0', 'r2']]);
    expect(left().map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('chunks a big list, so the tab is not blocked in one transaction', async () => {
    const rows = manyRows(DELETE_CHUNK * 2 + 3);
    const { coll, seen } = fakeColl({ rows });
    const gone = await removeRowIds(
      coll,
      rows.map((r) => r.id),
    );
    expect(gone).toBe(rows.length);
    expect(seen.removals.map((c) => c.length)).toEqual([DELETE_CHUNK, DELETE_CHUNK, 3]);
  });

  it('reports progress that climbs to the total and never overshoots it', async () => {
    const rows = manyRows(DELETE_CHUNK + 1);
    const { coll } = fakeColl({ rows });
    const seenProgress: Array<[number, number]> = [];
    await removeRowIds(
      coll,
      rows.map((r) => r.id),
      (done, of) => seenProgress.push([done, of]),
    );
    expect(seenProgress).toEqual([
      [DELETE_CHUNK, DELETE_CHUNK + 1],
      [DELETE_CHUNK + 1, DELETE_CHUNK + 1],
    ]);
  });
});

describe('deleteAllRows', () => {
  it('empties the table and says how many went', async () => {
    const { coll, left } = fakeColl({ rows: manyRows(7) });
    expect(await deleteAllRows(coll)).toBe(7);
    expect(left()).toEqual([]);
  });

  it('is a no-op on an empty table', async () => {
    const { coll, seen } = fakeColl({ rows: [] });
    expect(await deleteAllRows(coll)).toBe(0);
    expect(seen.removals).toEqual([]);
  });
});

describe('deleteVisibleRows', () => {
  it('takes the rows a filter matches and leaves the rest', async () => {
    const { coll, left } = fakeColl({ rows: manyRows(6) });
    const gone = await deleteVisibleRows(coll, req({ filters: { country: 'Sweden' } }));
    expect(gone).toBe(3);
    expect(left().map((r) => r.data.country)).toEqual(['Norway', 'Norway', 'Norway']);
  });

  it('takes the rows a search matches', async () => {
    const rows: Row[] = [
      { id: 'a', tableId: 't', data: { name: 'Ada', country: 'Sweden' }, updatedAt: 1 },
      { id: 'b', tableId: 't', data: { name: 'Bo', country: 'Norway' }, updatedAt: 1 },
    ];
    const { coll, left } = fakeColl({ rows });
    expect(await deleteVisibleRows(coll, req({ search: 'ada' }))).toBe(1);
    expect(left().map((r) => r.id)).toEqual(['b']);
  });

  it('deletes every match, not the page the grid was showing', async () => {
    // The request carries the window the grid was reading. A delete that honored
    // it would take 500 of the 1,000 matching rows and report success.
    const { coll, left } = fakeColl({ rows: manyRows(2_000) });
    const gone = await deleteVisibleRows(coll, req({ filters: { country: 'Sweden' }, offset: 500, limit: 500 }));
    expect(gone).toBe(1_000);
    expect(left().length).toBe(1_000);
    expect(left().every((r) => r.data.country === 'Norway')).toBe(true);
  });

  it('with nothing narrowing, matches everything — the caller decides whether to offer that', async () => {
    const { coll, left } = fakeColl({ rows: manyRows(5) });
    expect(await deleteVisibleRows(coll, req())).toBe(5);
    expect(left()).toEqual([]);
  });

  it('sends the backend no sort and no slice', async () => {
    const { coll, seen } = fakeColl({ rows: manyRows(4), supportsQuery: true });
    await deleteVisibleRows(coll, req({ filters: { country: 'Sweden' }, sort: [{ field: 'name', asc: true }], offset: 500, limit: 500 }));
    expect(seen.queries).toHaveLength(1);
    const q = seen.queries[0]!;
    expect(q.filters).toEqual({ country: 'Sweden' });
    expect(q.sort).toBeUndefined();
    expect(q.offset).toBeUndefined();
    expect(q.limit).toBeUndefined();
  });

  it('does not cap the read, so a table past the grid cap still empties', async () => {
    // 20,001 rows: one more than ROW_FETCH_CAP, all matching.
    const { coll, left } = fakeColl({ rows: manyRows(20_001), supportsQuery: true });
    const gone = await deleteVisibleRows(coll, req({ search: 'n' }));
    expect(gone).toBe(20_001);
    expect(left()).toEqual([]);
  });
});
