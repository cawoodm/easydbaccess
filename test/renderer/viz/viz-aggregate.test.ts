import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row, VizAggregate } from '../../../packages/shared/src/types.js';
import { aggregateRows, binDate, binNumber, EMPTY_LABEL, OTHER_LABEL } from '../../../packages/renderer/src/viz/viz-aggregate.js';

const col = (field: string, type: ColumnSpec['type'] = 'string', label = field): ColumnSpec => ({ field, label, type });

let n = 0;
const row = (data: Record<string, unknown>): Row => ({ id: `r${++n}`, tableId: 't', data, updatedAt: 0 });

/** Group by CATEGORY, count rows — the simplest useful spec. */
const countBy = (channel = 'CATEGORY'): VizAggregate => ({ groupBy: [channel], measures: [{ channel: 'VALUE', fn: 'count' }] });

describe('aggregateRows — grouping', () => {
  const columns = [col('country'), col('amount', 'number')];
  const mapping = { CATEGORY: 'country', VALUE: 'amount' };
  const rows = [
    row({ country: 'CH', amount: 10 }),
    row({ country: 'DE', amount: 5 }),
    row({ country: 'CH', amount: 7 }),
  ];

  it('groups by one channel and counts', () => {
    const f = aggregateRows(rows, columns, mapping, countBy());
    expect(f.categories.map((c) => c.label)).toEqual(['CH', 'DE']);
    expect(f.series).toHaveLength(1);
    expect(f.series[0]?.points).toEqual([2, 1]);
    expect(f.rowCount).toBe(3);
  });

  it('carries the raw group values for a future cross-filter', () => {
    const f = aggregateRows(rows, columns, mapping, countBy());
    expect(f.categories[0]?.values).toEqual(['CH']);
  });

  it('groups by two channels, producing only combinations present', () => {
    const cols = [col('country'), col('city'), col('amount', 'number')];
    const rs = [
      row({ country: 'CH', city: 'Bern', amount: 1 }),
      row({ country: 'CH', city: 'Zug', amount: 2 }),
      row({ country: 'DE', city: 'Bonn', amount: 3 }),
      row({ country: 'CH', city: 'Bern', amount: 4 }),
    ];
    const f = aggregateRows(rs, cols, { CATEGORY: 'country', SERIES: 'city', VALUE: 'amount' }, {
      groupBy: ['CATEGORY', 'SERIES'],
      measures: [{ channel: 'VALUE', fn: 'count' }],
    });
    // 3 combinations, not 2x3 = 6.
    expect(f.categories).toHaveLength(3);
    expect(f.series[0]?.points.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(4);
  });

  it('groups an empty value as its own labelled category rather than dropping it', () => {
    const rs = [row({ country: 'CH', amount: 1 }), row({ country: '', amount: 2 }), row({ amount: 3 })];
    const f = aggregateRows(rs, columns, mapping, countBy());
    const empty = f.categories.find((c) => c.label === EMPTY_LABEL);
    expect(empty).toBeDefined();
    // Both the '' and the absent key land in the same bucket, and nothing is lost.
    expect(f.series[0]?.points.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(3);
  });

  it('sorts empties last in category order', () => {
    const rs = [row({ country: '', amount: 1 }), row({ country: 'AT', amount: 2 })];
    const f = aggregateRows(rs, columns, mapping, countBy());
    expect(f.categories.map((c) => c.label)).toEqual(['AT', EMPTY_LABEL]);
  });

  it('groupBy [] yields exactly one category — the single-number case', () => {
    const f = aggregateRows(rows, columns, mapping, { groupBy: [], measures: [{ channel: 'VALUE', fn: 'sum' }] });
    expect(f.categories).toHaveLength(1);
    expect(f.series[0]?.points).toEqual([22]);
  });

  it('counts an array column per member, like the grid filter matches per member', () => {
    const cols = [col('tags', 'array'), col('amount', 'number')];
    const rs = [row({ tags: ['red', 'blue'], amount: 1 }), row({ tags: 'red', amount: 2 })];
    const f = aggregateRows(rs, cols, { CATEGORY: 'tags', VALUE: 'amount' }, countBy());
    const labels = f.categories.map((c) => c.label);
    expect(labels).toContain('red');
    expect(labels).toContain('blue');
    expect(f.series[0]?.points[labels.indexOf('red')]).toBe(2);
  });

  it('treats an empty array as an empty category, not as absent', () => {
    const cols = [col('tags', 'array'), col('amount', 'number')];
    const f = aggregateRows([row({ tags: [], amount: 1 })], cols, { CATEGORY: 'tags', VALUE: 'amount' }, countBy());
    expect(f.categories.map((c) => c.label)).toEqual([EMPTY_LABEL]);
  });
});

describe('aggregateRows — measures', () => {
  const columns = [col('k'), col('v', 'number')];
  const mapping = { CATEGORY: 'k', VALUE: 'v' };
  const rows = [row({ k: 'a', v: 1 }), row({ k: 'a', v: 3 }), row({ k: 'a', v: 8 })];

  const one = (fn: VizAggregate['measures'][number]['fn']): number | null =>
    aggregateRows(rows, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn }] }).series[0]?.points[0] ?? null;

  it('computes each aggregate function', () => {
    expect(one('count')).toBe(3);
    expect(one('sum')).toBe(12);
    expect(one('avg')).toBe(4);
    expect(one('min')).toBe(1);
    expect(one('max')).toBe(8);
  });

  it('countDistinct counts distinct values, not rows', () => {
    const rs = [row({ k: 'a', v: 1 }), row({ k: 'a', v: 1 }), row({ k: 'a', v: 2 })];
    const f = aggregateRows(rs, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'countDistinct' }] });
    expect(f.series[0]?.points[0]).toBe(2);
  });

  it('emits one series per measure', () => {
    const f = aggregateRows(rows, columns, mapping, {
      groupBy: ['CATEGORY'],
      measures: [
        { channel: 'VALUE', fn: 'count' },
        { channel: 'VALUE', fn: 'sum' },
      ],
    });
    expect(f.series).toHaveLength(2);
    expect(f.series[1]?.points).toEqual([12]);
  });

  it('skips a non-numeric value and reports it rather than coercing to 0', () => {
    const rs = [row({ k: 'a', v: 5 }), row({ k: 'a', v: 'n/a' })];
    const f = aggregateRows(rs, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }] });
    expect(f.series[0]?.points[0]).toBe(5);
    expect(f.skipped).toBe(1);
  });

  it('does not count a blank as unreadable — it simply does not contribute', () => {
    const rs = [row({ k: 'a', v: 5 }), row({ k: 'a', v: '' }), row({ k: 'a' })];
    const f = aggregateRows(rs, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }] });
    expect(f.series[0]?.points[0]).toBe(5);
    expect(f.skipped).toBe(0);
  });

  it('yields null, not 0, for a group with no usable value', () => {
    const f = aggregateRows([row({ k: 'a', v: '' })], columns, mapping, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'sum' }],
    });
    expect(f.series[0]?.points[0]).toBeNull();
  });

  it('reads a numeric string as a number', () => {
    const f = aggregateRows([row({ k: 'a', v: '2.5' })], columns, mapping, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'sum' }],
    });
    expect(f.series[0]?.points[0]).toBe(2.5);
  });

  it('count needs no mapped column, since it counts rows', () => {
    const f = aggregateRows([row({ k: 'a' })], [col('k')], { CATEGORY: 'k' }, countBy());
    expect(f.error).toBeUndefined();
    expect(f.series[0]?.points).toEqual([1]);
  });
});

describe('aggregateRows — topN', () => {
  const columns = [col('k'), col('v', 'number')];
  const mapping = { CATEGORY: 'k', VALUE: 'v' };
  const rows = Array.from({ length: 10 }, (_, i) => row({ k: `k${i}`, v: i + 1 }));

  it('keeps the top N by the first measure and folds the tail into Other', () => {
    const f = aggregateRows(rows, columns, mapping, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'sum' }],
      topN: 3,
    });
    expect(f.categories).toHaveLength(4);
    const other = f.categories.findIndex((c) => c.label === OTHER_LABEL);
    expect(other).toBeGreaterThanOrEqual(0);
    // 1..10 sums to 55; the kept three are 8, 9, 10 → Other is 55 - 27 = 28.
    expect(f.series[0]?.points[other]).toBe(28);
  });

  it('does not add an Other bar when nothing was folded', () => {
    const f = aggregateRows(rows.slice(0, 2), columns, mapping, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'sum' }],
      topN: 5,
    });
    expect(f.categories.map((c) => c.label)).not.toContain(OTHER_LABEL);
  });

  it('folds a max measure as a max, not as a sum', () => {
    const f = aggregateRows(rows, columns, mapping, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'max' }],
      topN: 3,
    });
    const other = f.categories.findIndex((c) => c.label === OTHER_LABEL);
    // Folded groups are 1..7; their max is 7, not their sum.
    expect(f.series[0]?.points[other]).toBe(7);
  });
});

describe('aggregateRows — sorting', () => {
  const columns = [col('k'), col('v', 'number')];
  const mapping = { CATEGORY: 'k', VALUE: 'v' };
  const rows = [row({ k: 'b', v: 5 }), row({ k: 'a', v: 9 }), row({ k: 'c', v: 1 })];

  it('sorts by category by default', () => {
    const f = aggregateRows(rows, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }] });
    expect(f.categories.map((c) => c.label)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by value ascending and descending', () => {
    const asc = aggregateRows(rows, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }], sort: 'value' });
    expect(asc.categories.map((c) => c.label)).toEqual(['c', 'b', 'a']);
    const desc = aggregateRows(rows, columns, mapping, { groupBy: ['CATEGORY'], measures: [{ channel: 'VALUE', fn: 'sum' }], sort: 'valueDesc' });
    expect(desc.categories.map((c) => c.label)).toEqual(['a', 'b', 'c']);
  });

  it('sorts a numeric category numerically, not as text', () => {
    const cols = [col('n', 'number'), col('v', 'number')];
    const rs = [row({ n: 10, v: 1 }), row({ n: 9, v: 1 }), row({ n: 100, v: 1 })];
    const f = aggregateRows(rs, cols, { CATEGORY: 'n', VALUE: 'v' }, countBy());
    expect(f.categories.map((c) => c.label)).toEqual(['9', '10', '100']);
  });
});

describe('aggregateRows — binning', () => {
  it('bins a numeric group key by width', () => {
    const cols = [col('age', 'number'), col('v', 'number')];
    const rs = [row({ age: 3, v: 1 }), row({ age: 7, v: 1 }), row({ age: 12, v: 1 })];
    const f = aggregateRows(rs, cols, { CATEGORY: 'age', VALUE: 'v' }, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'count' }],
      bin: { channel: 'CATEGORY', width: 10 },
    });
    expect(f.categories.map((c) => c.label)).toEqual(['0–10', '10–20']);
    expect(f.series[0]?.points).toEqual([2, 1]);
  });

  it('bins a date group key by each unit', () => {
    const cols = [col('d', 'date'), col('v', 'number')];
    const rs = [row({ d: '2026-01-15', v: 1 }), row({ d: '2026-02-20', v: 1 }), row({ d: '2026-02-25', v: 1 })];
    const spec = (unit: 'day' | 'month' | 'year'): VizAggregate => ({
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'count' }],
      bin: { channel: 'CATEGORY', unit },
    });
    expect(aggregateRows(rs, cols, { CATEGORY: 'd', VALUE: 'v' }, spec('month')).categories.map((c) => c.label)).toEqual(['2026-01', '2026-02']);
    expect(aggregateRows(rs, cols, { CATEGORY: 'd', VALUE: 'v' }, spec('year')).categories.map((c) => c.label)).toEqual(['2026']);
    expect(aggregateRows(rs, cols, { CATEGORY: 'd', VALUE: 'v' }, spec('day')).categories).toHaveLength(3);
  });

  it('buckets an unparseable date as empty rather than inventing one', () => {
    const cols = [col('d', 'date'), col('v', 'number')];
    const f = aggregateRows([row({ d: 'not a date', v: 1 })], cols, { CATEGORY: 'd', VALUE: 'v' }, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'count' }],
      bin: { channel: 'CATEGORY', unit: 'month' },
    });
    expect(f.categories.map((c) => c.label)).toEqual([EMPTY_LABEL]);
  });
});

describe('binDate / binNumber', () => {
  it('reads a date-only string from its parts, never through a UTC parse', () => {
    // Parsed as an instant this is midnight UTC, which is the previous day west
    // of Greenwich — the bug this avoids.
    expect(binDate('2026-03-01', 'day')).toBe('2026-03-01');
    expect(binDate('2026-03-01', 'month')).toBe('2026-03');
  });

  it('labels quarters and ISO weeks', () => {
    expect(binDate('2026-08-11', 'quarter')).toBe('2026-Q3');
    expect(binDate('2026-01-01', 'quarter')).toBe('2026-Q1');
    expect(binDate('2026-08-11', 'week')).toMatch(/^2026-W\d\d$/);
  });

  it('returns null for something that is not a date', () => {
    expect(binDate('nope', 'day')).toBeNull();
    expect(binDate(null, 'day')).toBeNull();
  });

  it('trims float noise from fractional bin labels', () => {
    expect(binNumber(0.35, 0.1)?.label).toBe('0.3–0.4');
  });

  it('bins negatives downward', () => {
    expect(binNumber(-3, 10)?.label).toBe('-10–0');
  });

  it('refuses a non-positive width', () => {
    expect(binNumber(5, 0)).toBeNull();
  });
});

describe('aggregateRows — degenerate input', () => {
  const columns = [col('k'), col('v', 'number')];
  const mapping = { CATEGORY: 'k', VALUE: 'v' };

  it('returns an empty frame for no rows, without throwing', () => {
    const f = aggregateRows([], columns, mapping, countBy());
    expect(f.categories).toEqual([]);
    expect(f.series[0]?.points).toEqual([]);
    expect(f.error).toBeUndefined();
  });

  it('reports a channel mapped to a field no column carries', () => {
    // This is the renamed-column case: "no data" and "you renamed it" look
    // identical on a chart, so it must say which.
    const f = aggregateRows([row({ k: 'a' })], columns, { CATEGORY: 'gone', VALUE: 'v' }, countBy());
    expect(f.error).toMatch(/CATEGORY/);
    expect(f.categories).toEqual([]);
  });

  it('reports an unmapped channel', () => {
    const f = aggregateRows([row({ k: 'a' })], columns, {}, countBy());
    expect(f.error).toBeTruthy();
  });

  it('reports a spec with no measures', () => {
    const f = aggregateRows([row({ k: 'a' })], columns, mapping, { groupBy: ['CATEGORY'], measures: [] });
    expect(f.error).toMatch(/measure/i);
  });

  it('does not require a column for a count measure whose channel is unmapped', () => {
    const f = aggregateRows([row({ k: 'a' })], columns, { CATEGORY: 'k' }, countBy());
    expect(f.error).toBeUndefined();
  });

  it('passes truncated through so the panel can own up to a capped read', () => {
    const f = aggregateRows([row({ k: 'a' })], columns, mapping, countBy(), { truncated: true });
    expect(f.truncated).toBe(true);
    expect(aggregateRows([], columns, mapping, countBy()).truncated).toBe(false);
  });

  it('labels a series by the mapped column label and the function', () => {
    const f = aggregateRows([row({ k: 'a', v: 1 })], [col('k'), col('v', 'number', 'Amount')], mapping, {
      groupBy: ['CATEGORY'],
      measures: [{ channel: 'VALUE', fn: 'sum' }],
    });
    expect(f.series[0]?.label).toBe('Sum of Amount');
  });
});
