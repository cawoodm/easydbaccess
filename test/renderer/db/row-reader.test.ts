import { describe, expect, it } from 'vitest';
import { applyRowRequest, isPushableSearch, readRows, type RowRequest } from '../../../packages/renderer/src/db/row-reader.js';
import type { ColumnSpec, DataCollection, Row, RowPage, RowQuery } from '../../../packages/shared/src/index.js';

/**
 * `readRows` is the decision about how much of a read the backend does, so what
 * matters is not that it returns rows — it is WHICH predicates it hands over.
 * A predicate pushed that the backend reads differently returns a wrong answer
 * that looks right, so these tests inspect the `RowQuery` that travelled.
 */

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'country', label: 'Country', type: 'string' },
  { field: 'age', label: 'Age', type: 'number' },
  { field: 'secret', label: 'Secret', type: 'string', filterable: false },
  // An `array` cell holds SEVERAL values and is matched per MEMBER.
  { field: 'tags', label: 'Tags', type: 'array' },
];

const ROWS: Row[] = [
  { id: 'r1', tableId: 't', data: { name: 'Ada', country: 'Sweden', age: 36, secret: 'zebra' }, updatedAt: 1 },
  { id: 'r2', tableId: 't', data: { name: 'Bo', country: 'Norway', age: 22, secret: 'zebra' }, updatedAt: 1 },
  { id: 'r3', tableId: 't', data: { name: 'Cy', country: 'Sweden', age: 51, secret: 'yak' }, updatedAt: 1 },
  { id: 'r4', tableId: 't', data: { name: 'Di', country: 'Denmark', age: 44, secret: 'yak' }, updatedAt: 1 },
];

/** A collection that records what it was asked, so the decision is observable. */
function fakeColl(opts: { rows?: Row[]; supportsQuery?: boolean; partial?: boolean } = {}) {
  const rows = opts.rows ?? ROWS;
  const seen: { finds: number; queries: RowQuery[] } = { finds: 0, queries: [] };
  const coll: Partial<DataCollection<Row>> = {
    find: async () => {
      seen.finds++;
      return rows;
    },
  };
  if (opts.supportsQuery !== false) {
    coll.query = async (q: RowQuery): Promise<RowPage> => {
      seen.queries.push(q);
      // Stands in for a backend: applies only the filters, honestly reporting
      // anything else as unapplied.
      let out = rows;
      for (const [field, expr] of Object.entries(q.filters ?? {})) {
        out = out.filter((r) => String(r.data[field]).toLowerCase().includes(expr.toLowerCase()));
      }
      const total = out.length;
      const from = q.offset ?? 0;
      if (q.limit != null) out = out.slice(from, from + q.limit);
      else if (from > 0) out = out.slice(from);
      return { rows: out, total, ...(opts.partial ? { partial: true } : {}) };
    };
  }
  return { coll: coll as DataCollection<Row>, seen };
}

const req = (over: Partial<RowRequest> = {}): RowRequest => ({ columns: COLUMNS, ...over });

describe('isPushableSearch', () => {
  const fields = COLUMNS.map((c) => ({ field: c.field, label: c.label }));

  it('pushes an empty or single-word query', () => {
    expect(isPushableSearch('', fields)).toBe(true);
    expect(isPushableSearch('sweden', fields)).toBe(true);
  });

  it('keeps a multi-word query in memory, because of the phrase-then-AND-then-OR fallback', () => {
    // Whether the AND attempt runs at all depends on whether the phrase matched
    // anything — not something a WHERE clause can decide.
    expect(isPushableSearch('ada sweden', fields)).toBe(false);
  });

  it('keeps AND / OR in memory', () => {
    expect(isPushableSearch('ada AND sweden', fields)).toBe(false);
    expect(isPushableSearch('ada OR bo', fields)).toBe(false);
  });

  it('keeps a field:value term in memory, but not a bare colon in ordinary text', () => {
    expect(isPushableSearch('country:sweden', fields)).toBe(false);
    expect(isPushableSearch('http://x', fields)).toBe(true); // not a known field
  });
});

describe('applyRowRequest', () => {
  it('filters, sorts and slices, reporting the total before the slice', () => {
    const page = applyRowRequest(ROWS, req({ filters: { country: 'Sweden' }, sort: [{ field: 'age', asc: true }], limit: 1 }));
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.id)).toEqual(['r1']);
  });

  it('ignores a stored filter on a column that is no longer filterable', () => {
    // The flag can be set after a filter was saved; it must stop narrowing.
    const page = applyRowRequest(ROWS, req({ filters: { secret: 'zebra' } }));
    expect(page.total).toBe(4);
  });

  it('ignores a filter on a field no column has', () => {
    // Such a filter is unreachable — no funnel exists to clear it — and matches
    // nothing, so honouring it empties the grid with no visible cause. A
    // commandlet naming a column that does not exist is how one arrives.
    const page = applyRowRequest(ROWS, req({ filters: { Nonesuch: 'anything' } }));
    expect(page.total).toBe(4);
  });

  it('returns only the fields asked for', () => {
    const page = applyRowRequest(ROWS, req({ fields: ['name'], limit: 1 }));
    expect(Object.keys(page.rows[0]!.data)).toEqual(['name']);
  });

  it('applies the offset after sorting, not before', () => {
    const page = applyRowRequest(ROWS, req({ sort: [{ field: 'age', asc: false }], offset: 1, limit: 1 }));
    expect(page.rows.map((r) => r.data.age)).toEqual([44]);
  });
});

/**
 * An `array` column is matched per MEMBER, and the column TYPE is what says so.
 * Read as one string instead, `=b` fails on `a,b` and `NULL` calls `[]` non-empty
 * — narrower than the grid, so rows the user did not exclude go missing.
 */
describe('applyRowRequest respects the column type', () => {
  const tagged = (id: string, tags: unknown): Row => ({ id, tableId: 't', data: { name: id, tags }, updatedAt: 1 });
  const rows = [tagged('r1', 'alpha,beta'), tagged('r2', '["beta","gamma"]'), tagged('r3', 'gamma'), tagged('r4', '[]')];

  it('matches an exact member, which whole-cell matching would miss', () => {
    const page = applyRowRequest(rows, req({ filters: { tags: '=beta' } }));
    expect(page.rows.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('reads an empty list as NULL, whichever spelling it uses', () => {
    const page = applyRowRequest(rows, req({ filters: { tags: 'NULL' } }));
    expect(page.rows.map((r) => r.id)).toEqual(['r4']);
  });

  it('excludes by member, so a row keeping another member survives', () => {
    const page = applyRowRequest(rows, req({ filters: { tags: '=gamma' } }));
    expect(page.rows.map((r) => r.id)).toEqual(['r2', 'r3']);
  });
});

describe('readRows', () => {
  it('reads everything and narrows here when the collection cannot query', () => {
    const { coll, seen } = fakeColl({ supportsQuery: false });
    return readRows(coll, req({ filters: { country: 'Sweden' } })).then((page) => {
      expect(seen.finds).toBe(1);
      expect(page.total).toBe(2);
    });
  });

  it('caps the fallback read and says so, because handing over a whole large table is what crashed the app', async () => {
    // Silently returning 2 of 4 rows with total:2 reads as "this table has 2
    // rows". `truncated` is what makes the count a floor.
    const { coll } = fakeColl({ supportsQuery: false });
    const page = await readRows(coll, req(), 2);
    expect(page.rows).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it('does not claim truncation when the whole table fitted under the cap', async () => {
    const { coll } = fakeColl({ supportsQuery: false });
    const page = await readRows(coll, req(), 100);
    expect(page.truncated).toBeUndefined();
    expect(page.total).toBe(4);
  });

  it('pushes the filter, the sort and the slice, and never calls find', async () => {
    const { coll, seen } = fakeColl();
    const page = await readRows(coll, req({ filters: { country: 'Sweden' }, sort: [{ field: 'age', asc: true }], limit: 1, offset: 0 }));
    expect(seen.finds).toBe(0);
    expect(seen.queries).toEqual([{ filters: { country: 'Sweden' }, sort: [{ field: 'age', asc: true }], offset: 0, limit: 1 }]);
    // The backend's own total survives — the point of asking for a page.
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(1);
  });

  it('pushes a single-word search', async () => {
    const { coll, seen } = fakeColl();
    await readRows(coll, req({ search: 'sweden' }));
    expect(seen.queries[0]?.search).toBe('sweden');
  });

  it('holds back a multi-word search AND the slice that sits on top of it', async () => {
    // Pushing the limit would have the backend count off rows from a set this
    // side is about to narrow further, returning too few.
    const { coll, seen } = fakeColl();
    const page = await readRows(coll, req({ search: 'ada sweden', limit: 2 }));
    expect(seen.queries[0]?.search).toBeUndefined();
    expect(seen.queries[0]?.limit).toBeUndefined();
    expect(seen.queries[0]?.offset).toBeUndefined();
    expect(page.rows.map((r) => r.id)).toEqual(['r1']); // phrase fails, AND matches Ada
  });

  it('drops a filter the column is not allowed to be narrowed by before pushing it', async () => {
    const { coll, seen } = fakeColl();
    await readRows(coll, req({ filters: { secret: 'zebra' } }));
    expect(seen.queries[0]?.filters).toEqual({});
  });

  it('re-narrows and keeps saying partial when the backend could not apply everything', async () => {
    // `partial` means the rows are a superset. Trusting them would show rows the
    // user filtered out; trusting `total` would overstate the count.
    const { coll } = fakeColl({ partial: true });
    const page = await readRows(coll, req({ filters: { country: 'Sweden' } }));
    expect(page.partial).toBe(true);
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  /**
   * The bug the whole contract exists to fix.
   *
   * The grid used to fetch a capped prefix of the table and filter THAT. So a
   * match sitting past the cap simply did not exist as far as the user was
   * concerned — the grid showed "no rows" over a table that had them, and a sort
   * showed the top of an arbitrary prefix rather than the top of the table.
   */
  it('finds a match that lies past the fetch cap, because the backend filters the whole table', async () => {
    const many: Row[] = Array.from({ length: 500 }, (_, i) => ({
      id: `r${i}`,
      tableId: 't',
      data: { name: `Person ${i}`, country: i === 400 ? 'Zanzibar' : 'Sweden', age: 30, secret: '' },
      updatedAt: 1,
    }));
    const { coll, seen } = fakeColl({ rows: many });
    // A cap far below where the match sits.
    const page = await readRows(coll, req({ filters: { country: 'Zanzibar' } }), 50);
    expect(seen.finds).toBe(0);
    expect(page.total).toBe(1);
    expect(page.rows.map((r) => r.id)).toEqual(['r400']);

    // And the contrast: reading a capped prefix and filtering it finds nothing.
    const blind = applyRowRequest(many.slice(0, 50), req({ filters: { country: 'Zanzibar' } }));
    expect(blind.total).toBe(0);
  });

  it('caps what it pulls even on the unsound path, and reports the cap as truncation', async () => {
    const { coll, seen } = fakeColl();
    const page = await readRows(coll, req({ search: 'ada OR bo' }), 3);
    expect(seen.queries[0]?.limit).toBe(3);
    expect(page.truncated).toBe(true);
  });
});

// A scripted column stores nothing, so a free-text search over it scans empties.
// The reader works this out from the rows it holds — see
// `search/searchable-columns.ts` for why it is derived and not stored.
describe('search skips a computed-only column', () => {
  const cols = [
    { field: 'a', label: 'a', type: 'string' as const },
    { field: 'calc', label: 'calc', type: 'string' as const, script: 'function render(row){ return row.a.toUpperCase() }' },
  ];
  const rows = [
    { id: '1', tableId: 't', data: { a: 'ada' }, updatedAt: 0 },
    { id: '2', tableId: 't', data: { a: 'bob' }, updatedAt: 0 },
  ];

  it('a field:value term on it finds nothing rather than pretending to work', () => {
    // `calc` is not offered as a search field, so `calc:ADA` falls through to a
    // plain substring search for that literal text — which matches no row.
    expect(applyRowRequest(rows, { columns: cols, search: 'calc:ADA' }).rows).toHaveLength(0);
  });

  it('a plain term still searches the columns that DO store data', () => {
    expect(applyRowRequest(rows, { columns: cols, search: 'ada' }).rows.map((r) => r.id)).toEqual(['1']);
  });

  it('the same column IS searched once it stores something', () => {
    const filled = [{ id: '1', tableId: 't', data: { a: 'ada', calc: 'ADA' }, updatedAt: 0 }];
    expect(applyRowRequest(filled, { columns: cols, search: 'calc:ADA' }).rows).toHaveLength(1);
  });
});
