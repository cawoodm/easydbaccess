import { describe, expect, it } from 'vitest';
import { scanTable } from '../../../packages/renderer/src/table/validate-scan.js';
import type { ColumnSpec, DataCollection, Row, RowQuery } from '../../../packages/shared/src/index.js';

/**
 * Reading a whole table past the validator.
 *
 * What matters here is not that it finds issues — `validate-rules.test.ts` covers
 * the rules — but HOW it reads: a page at a time, reporting progress, stopping when
 * asked, and never reading at all when no column carries a rule. That last one is
 * what makes the button honest on a 600,000-row imported table.
 */

const col = (over: Partial<ColumnSpec> & { field: string }): ColumnSpec => ({ label: over.field, type: 'string', ...over });

function rows(n: number, make: (i: number) => Record<string, unknown>): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tableId: 't', data: make(i), updatedAt: 0 }));
}

/** A collection that pages, and records how it was read. */
function fakeColl(all: Row[], opts: { supportsQuery?: boolean; supportsCount?: boolean } = {}) {
  const seen: { queries: RowQuery[]; finds: number; counts: number } = { queries: [], finds: 0, counts: 0 };
  const coll: Partial<DataCollection<Row>> = {
    find: async () => {
      seen.finds++;
      return all;
    },
  };
  if (opts.supportsCount !== false) {
    coll.count = async () => {
      seen.counts++;
      return all.length;
    };
  }
  if (opts.supportsQuery !== false) {
    coll.query = async (q: RowQuery) => {
      seen.queries.push(q);
      const from = q.offset ?? 0;
      const to = q.limit != null ? from + q.limit : all.length;
      return { rows: all.slice(from, to), total: q.countTotal === false ? -1 : all.length };
    };
  }
  return { coll: coll as DataCollection<Row>, seen };
}

describe('scanTable', () => {
  it('reads nothing when no column carries a rule', async () => {
    const { coll, seen } = fakeColl(rows(10, () => ({ a: '' })));
    const out = await scanTable(coll, [col({ field: 'a' })]);
    expect(out).toMatchObject({ noRules: true, scanned: 0, cancelled: false });
    expect(seen.queries).toEqual([]);
    expect(seen.finds).toBe(0);
    expect(seen.counts).toBe(0);
  });

  it('pages through the table and finds the issues in every page', async () => {
    const all = rows(250, (i) => ({ a: i % 50 === 0 ? '' : 'x' }));
    const { coll, seen } = fakeColl(all);
    const out = await scanTable(coll, [col({ field: 'a', notnull: true })], { pageRows: 100 });
    expect(out.scanned).toBe(250);
    expect(out.issues.map((i) => i.row)).toEqual([1, 51, 101, 151, 201]);
    expect(seen.queries.map((q) => q.offset)).toEqual([0, 100, 200]);
  });

  it('asks each page not to count the table, since the count was taken once', async () => {
    const { coll, seen } = fakeColl(rows(30, () => ({ a: 'x' })));
    await scanTable(coll, [col({ field: 'a', notnull: true })], { pageRows: 10 });
    expect(seen.counts).toBe(1);
    expect(seen.queries.every((q) => q.countTotal === false)).toBe(true);
  });

  it('sees a duplicate that straddles a page boundary', async () => {
    // The unique rule only works if the scan is one continuous pass. A per-page
    // validator would call these two rows unique.
    const all = rows(4, (i) => ({ sku: i === 0 || i === 3 ? 'A' : String(i) }));
    const { coll } = fakeColl(all);
    const out = await scanTable(coll, [col({ field: 'sku', unique: true })], { pageRows: 2 });
    expect(out.issues.map((i) => i.row)).toEqual([4]);
  });

  it('reports progress that ends at the total', async () => {
    const { coll } = fakeColl(rows(30, () => ({ a: 'x' })));
    const seenProgress: Array<[number, number]> = [];
    await scanTable(coll, [col({ field: 'a', notnull: true })], { pageRows: 10, onProgress: (s, t) => seenProgress.push([s, t]) });
    expect(seenProgress).toEqual([
      [0, 30],
      [10, 30],
      [20, 30],
      [30, 30],
    ]);
  });

  it('stops when cancelled, and says what it managed', async () => {
    const { coll } = fakeColl(rows(100, () => ({ a: '' })));
    let pages = 0;
    const out = await scanTable(coll, [col({ field: 'a', notnull: true })], {
      pageRows: 10,
      cancelled: () => ++pages >= 2,
    });
    expect(out.cancelled).toBe(true);
    expect(out.scanned).toBe(20);
    expect(out.issues).toHaveLength(20);
  });

  it('works on a collection with no windowed read, chunking in memory', async () => {
    const { coll, seen } = fakeColl(
      rows(25, (i) => ({ a: i === 24 ? '' : 'x' })),
      { supportsQuery: false },
    );
    const out = await scanTable(coll, [col({ field: 'a', notnull: true })], { pageRows: 10 });
    expect(seen.finds).toBe(1);
    expect(out.scanned).toBe(25);
    expect(out.issues.map((i) => i.row)).toEqual([25]);
  });

  it('can be cancelled on the no-query path too', async () => {
    const { coll } = fakeColl(
      rows(50, () => ({ a: '' })),
      { supportsQuery: false },
    );
    const out = await scanTable(coll, [col({ field: 'a', notnull: true })], { pageRows: 10, cancelled: () => true });
    expect(out.cancelled).toBe(true);
    expect(out.scanned).toBe(10);
  });

  it('runs without a count, leaving the progress total at zero', async () => {
    // `count` is optional on the contract. A caller with no total shows an
    // indeterminate bar rather than a fraction of an unknown.
    const { coll } = fakeColl(
      rows(5, () => ({ a: '' })),
      { supportsCount: false },
    );
    const seenProgress: Array<[number, number]> = [];
    const out = await scanTable(coll, [col({ field: 'a', notnull: true })], { onProgress: (s, t) => seenProgress.push([s, t]) });
    expect(out.scanned).toBe(5);
    expect(seenProgress.every(([, t]) => t === 0)).toBe(true);
  });

  it('carries the cap through, so one bad column cannot return a million rows', async () => {
    const { coll } = fakeColl(rows(100, () => ({ a: '' })));
    const out = await scanTable(coll, [col({ field: 'a', label: 'A', notnull: true })], { pageRows: 25, capPerColumn: 10 });
    expect(out.issues).toHaveLength(10);
    expect(out.capped.get('A')).toBe(90);
    expect(out.scanned).toBe(100);
  });
});
