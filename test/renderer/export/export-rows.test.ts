import { describe, expect, it } from 'vitest';
import type { DataCollection, ExportOptions } from '../../../packages/shared/src/plugin-api.js';
import type { ColumnSpec, Row, Table } from '../../../packages/shared/src/types.js';
import type { RowQuery } from '../../../packages/shared/src/row-query.js';
import { DEFAULT_EXPORT_OPTIONS, prepareExport } from '../../../packages/renderer/src/export/export-rows.js';

/**
 * The export dialog's general options, turned into the rows and columns to write.
 *
 * The order of operations is the point of most of these: filtering and sorting have
 * to happen before a limit cuts the result, or "the first 3, sorted" quietly becomes
 * "sort of the first 3" — a smaller and differently-populated file than asked for,
 * which looks correct.
 */

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'qty', label: 'Qty', type: 'number' },
  { field: 'note', label: 'Note', type: 'string', hidden: true },
];

function table(over: Partial<Table> = {}): Table {
  return { id: 't1', workspaceId: 'w1', name: 'Stock', code: 'stock', columns: COLUMNS, createdAt: 1, updatedAt: 1, ...over } as Table;
}

function rows(data: Array<Record<string, unknown>>): Row[] {
  return data.map((d, i) => ({ id: `r${i}`, tableId: 't1', data: d, updatedAt: 1 }));
}

const STOCK = rows([
  { name: 'Pear', qty: 3, note: 'hidden pear' },
  { name: 'Apple', qty: 10, note: 'hidden apple' },
  { name: 'Fig', qty: 7, note: 'hidden fig' },
]);

/**
 * A collection that answers `query` the way the Dexie store does for a plain slice:
 * `offset`/`limit` only, no filtering or sorting. Records what it was asked, so a
 * test can tell a page read from a whole-table read.
 */
function coll(all: Row[], opts: { cap?: number } = {}): DataCollection<Row> & { asked: RowQuery[] } {
  const asked: RowQuery[] = [];
  const cap = opts.cap ?? Infinity;
  return {
    asked,
    async find() {
      return all;
    },
    async findOne() {
      return undefined;
    },
    async count() {
      return all.length;
    },
    async query(q: RowQuery) {
      asked.push(q);
      const from = q.offset ?? 0;
      const to = q.limit != null ? from + q.limit : all.length;
      const slice = all.slice(from, to);
      const truncated = slice.length > cap;
      return { rows: truncated ? slice.slice(0, cap) : slice, total: q.countTotal === false ? -1 : all.length, ...(truncated ? { truncated: true } : {}) };
    },
    async insert() {
      throw new Error('not used');
    },
    async bulkInsert() {
      throw new Error('not used');
    },
    async patch() {
      throw new Error('not used');
    },
    async remove() {
      throw new Error('not used');
    },
    async bulkRemove() {
      throw new Error('not used');
    },
    subscribe() {
      return () => {};
    },
  } as unknown as DataCollection<Row> & { asked: RowQuery[] };
}

const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...over });

describe('prepareExport — columns', () => {
  it('drops hidden columns for "visible", keeping the order of the rest', async () => {
    const out = await prepareExport(coll(STOCK), table(), opts({ columns: 'visible' }));
    expect(out.table.columns.map((c) => c.field)).toEqual(['name', 'qty']);
  });

  it('keeps every column for "all"', async () => {
    const out = await prepareExport(coll(STOCK), table(), opts({ columns: 'all' }));
    expect(out.table.columns.map((c) => c.field)).toEqual(['name', 'qty', 'note']);
  });

  it('leaves the rows alone — a hidden column is dropped by the serializer, not here', async () => {
    // The serializers project onto `table.columns`, so narrowing the columns is
    // enough. Stripping the row data too would only cost a copy of every row.
    const out = await prepareExport(coll(STOCK), table(), opts({ columns: 'visible' }));
    expect(out.rows[0]?.data.note).toBe('hidden pear');
  });
});

describe('prepareExport — rows and order', () => {
  it('applies the saved filters for "filtered"', async () => {
    const t = table({ filters: { name: 'p' } });
    const out = await prepareExport(coll(STOCK), t, opts({ rows: 'filtered', order: 'unsorted' }));
    expect(out.rows.map((r) => r.data.name)).toEqual(['Pear', 'Apple']);
  });

  it('ignores them for "unfiltered"', async () => {
    const t = table({ filters: { name: 'p' } });
    const out = await prepareExport(coll(STOCK), t, opts({ rows: 'unfiltered', order: 'unsorted' }));
    expect(out.rows).toHaveLength(3);
  });

  it('applies the saved sort for "sorted"', async () => {
    const t = table({ sortBy: [{ field: 'qty', asc: true }] });
    const out = await prepareExport(coll(STOCK), t, opts({ order: 'sorted' }));
    expect(out.rows.map((r) => r.data.qty)).toEqual([3, 7, 10]);
  });

  it('honors a multi-column sort, not just the first column', async () => {
    // `scopedRows` only ever read `sortColumn`/`sortAsc`, so a table sorted by two
    // columns exported in the order of one of them.
    const t = table({ sortBy: [{ field: 'qty', asc: false }] });
    const out = await prepareExport(coll(STOCK), t, opts({ order: 'sorted' }));
    expect(out.rows.map((r) => r.data.qty)).toEqual([10, 7, 3]);
  });

  it('keeps store order for "unsorted"', async () => {
    const t = table({ sortBy: [{ field: 'qty', asc: true }] });
    const out = await prepareExport(coll(STOCK), t, opts({ order: 'unsorted' }));
    expect(out.rows.map((r) => r.data.name)).toEqual(['Pear', 'Apple', 'Fig']);
  });
});

describe('prepareExport — the limit', () => {
  it('cuts the result to the limit', async () => {
    const out = await prepareExport(coll(STOCK), table(), opts({ limitRows: 2, order: 'unsorted' }));
    expect(out.rows).toHaveLength(2);
  });

  it('reads only a page when nothing narrows the rows', async () => {
    // The whole reason a limit is worth having on a big table: 300 ms against 21.6 s
    // on the measured 609,283-row one.
    const c = coll(STOCK);
    await prepareExport(c, table(), opts({ limitRows: 2, rows: 'unfiltered', order: 'unsorted' }));
    expect(c.asked[0]?.limit).toBe(2);
  });

  it('reads the whole table when a sort has to see every row first', async () => {
    const c = coll(STOCK);
    const t = table({ sortBy: [{ field: 'qty', asc: true }] });
    await prepareExport(c, t, opts({ limitRows: 2, order: 'sorted' }));
    expect(c.asked[0]?.limit).toBeUndefined();
  });

  it('takes the limit AFTER sorting, so it is the first N of the sorted set', async () => {
    const c = coll(STOCK);
    const t = table({ sortBy: [{ field: 'qty', asc: true }] });
    const out = await prepareExport(c, t, opts({ limitRows: 2, order: 'sorted' }));
    // Sorted ascending by qty: 3, 7, 10 → the first two are Pear and Fig. Limiting
    // the READ instead would have given Pear and Apple, sorted to 3 and 10.
    expect(out.rows.map((r) => r.data.name)).toEqual(['Pear', 'Fig']);
  });

  it('takes the limit AFTER filtering, so it is the first N of the matches', async () => {
    const c = coll(STOCK);
    const t = table({ filters: { name: 'p' } });
    const out = await prepareExport(c, t, opts({ limitRows: 1, rows: 'filtered', order: 'unsorted' }));
    expect(out.rows.map((r) => r.data.name)).toEqual(['Pear']);
    expect(c.asked[0]?.limit).toBeUndefined();
  });

  it('reads everything for a limit of 0', async () => {
    const out = await prepareExport(coll(STOCK), table(), opts({ limitRows: 0, order: 'unsorted' }));
    expect(out.rows).toHaveLength(3);
  });

  it('an empty filter is not a filter, so the read stays a page', async () => {
    const c = coll(STOCK);
    const t = table({ filters: { name: '   ' } });
    await prepareExport(c, t, opts({ limitRows: 2, rows: 'filtered', order: 'unsorted' }));
    expect(c.asked[0]?.limit).toBe(2);
  });
});

describe('prepareExport — values', () => {
  it('runs a script into a column that stores nothing', async () => {
    const t = table({ columns: [...COLUMNS, { field: 'double', label: 'Double', type: 'number', script: 'return row.qty * 2' } as ColumnSpec] });
    const out = await prepareExport(coll(STOCK), t, opts({ runScripts: true, order: 'unsorted', columns: 'all' }));
    expect(out.rows.map((r) => r.data.double)).toEqual([6, 20, 14]);
  });

  it('leaves the script column empty when scripts are off', async () => {
    const t = table({ columns: [...COLUMNS, { field: 'double', label: 'Double', type: 'number', script: 'return row.qty * 2' } as ColumnSpec] });
    const out = await prepareExport(coll(STOCK), t, opts({ runScripts: false, order: 'unsorted', columns: 'all' }));
    expect(out.rows[0]?.data.double).toBeUndefined();
  });

  it('does not overwrite stored data with a script', async () => {
    // A script may decorate a column that also holds values. Replacing them would
    // lose data the user typed.
    const t = table({ columns: [{ field: 'name', label: 'Name', type: 'string', script: 'return "SCRIPTED"' } as ColumnSpec] });
    const out = await prepareExport(coll(STOCK), t, opts({ runScripts: true, order: 'unsorted' }));
    expect(out.rows.map((r) => r.data.name)).toEqual(['Pear', 'Apple', 'Fig']);
  });

  it('survives a script that throws, leaving the cell as it was', async () => {
    const t = table({ columns: [...COLUMNS, { field: 'boom', label: 'Boom', type: 'string', script: 'throw new Error("no")' } as ColumnSpec] });
    const out = await prepareExport(coll(STOCK), t, opts({ runScripts: true, order: 'unsorted', columns: 'all' }));
    expect(out.rows[0]?.data.boom).toBeUndefined();
  });

  it('writes an array as its members for "rendered"', async () => {
    const t = table({ columns: [{ field: 'tags', label: 'Tags', type: 'array' } as ColumnSpec] });
    const out = await prepareExport(coll(rows([{ tags: ['a', 'b'] }])), t, opts({ values: 'rendered', order: 'unsorted' }));
    expect(out.rows[0]?.data.tags).toBe('a, b');
  });

  it('leaves values as stored for "raw"', async () => {
    const t = table({ columns: [{ field: 'tags', label: 'Tags', type: 'array' } as ColumnSpec] });
    const out = await prepareExport(coll(rows([{ tags: ['a', 'b'] }])), t, opts({ values: 'raw', order: 'unsorted' }));
    expect(out.rows[0]?.data.tags).toEqual(['a', 'b']);
  });
});

describe('prepareExport — a capped read', () => {
  it('reports truncation instead of looking complete', async () => {
    // `find()` on the bridge stores caps at ROW_FETCH_CAP and says nothing, which is
    // how an Electron export of a big table came out short with no warning.
    const out = await prepareExport(coll(STOCK, { cap: 2 }), table(), opts({ order: 'unsorted' }));
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(2);
  });

  it('says nothing when the whole answer came back', async () => {
    const out = await prepareExport(coll(STOCK), table(), opts({ order: 'unsorted' }));
    expect(out.truncated).toBe(false);
  });
});
