import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { reconcileColumns, rowRekeyer } from './column-merge.js';

const col = (field: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  field,
  label: field,
  type: 'string',
  ...extra,
});

describe('reconcileColumns', () => {
  it('recreates all columns when the table had none (failed first import)', () => {
    const incoming = [col('a'), col('b'), col('c')];
    const { columns, newFields } = reconcileColumns([], incoming);
    expect(columns.map((c) => c.field)).toEqual(['a', 'b', 'c']);
    expect(newFields).toEqual(['a', 'b', 'c']);
  });

  it("keeps the user's arrangement (order, hidden, width) and never overwrites it", () => {
    const existing = [
      col('b', { hidden: true, width: 120, label: 'Bee' }),
      col('a', { type: 'number' }),
    ];
    // Incoming lists the same fields in a different order with different props.
    const incoming = [col('a'), col('b')];
    const { columns, newFields } = reconcileColumns(existing, incoming);
    expect(newFields).toEqual([]);
    // Order and per-column props are exactly the user's, unchanged.
    expect(columns).toEqual(existing);
  });

  it('appends genuinely-new columns after the existing ones and reports them', () => {
    const existing = [col('a'), col('b')];
    const incoming = [col('a'), col('b'), col('c'), col('d')];
    const { columns, newFields } = reconcileColumns(existing, incoming);
    expect(columns.map((c) => c.field)).toEqual(['a', 'b', 'c', 'd']);
    expect(newFields).toEqual(['c', 'd']);
  });

  it('never re-adds a column the user deleted', () => {
    const existing = [col('a')];
    const incoming = [col('a'), col('b'), col('c')];
    const { columns, newFields } = reconcileColumns(existing, incoming, ['b']);
    // b is suppressed; only the unknown c is added.
    expect(columns.map((c) => c.field)).toEqual(['a', 'c']);
    expect(newFields).toEqual(['c']);
  });

  it('deduplicates repeated incoming fields', () => {
    const { columns, newFields } = reconcileColumns([], [col('a'), col('a'), col('b')]);
    expect(columns.map((c) => c.field)).toEqual(['a', 'b']);
    expect(newFields).toEqual(['a', 'b']);
  });
});

describe('rowRekeyer', () => {
  const cols = (...fields: string[]): ColumnSpec[] =>
    fields.map((field) => ({ field, label: field, type: 'string' }));

  it('returns null when nothing was renamed', () => {
    expect(rowRekeyer(cols('a', 'b'), cols('a', 'b'))).toBeNull();
  });

  it('moves a value to the renamed field', () => {
    // The regression this guards: the editor renamed `tm_2` to `tmin`, the
    // rows kept the old key, and the new column came out empty.
    const rekey = rowRekeyer(cols('t', 'tm', 'tm_2'), cols('t', 'tm', 'tmin'))!;
    expect(rekey({ t: 'x', tm: 7, tm_2: 6.6 })).toEqual({ t: 'x', tm: 7, tmin: 6.6 });
  });

  it('maps by position, not by name', () => {
    // A swap is still position-wise: index 0 goes to index 0.
    const rekey = rowRekeyer(cols('a', 'b'), cols('b', 'a'))!;
    expect(rekey({ a: 1, b: 2 })).toEqual({ b: 1, a: 2 });
  });

  it('keeps a missing value as undefined rather than dropping the key', () => {
    const rekey = rowRekeyer(cols('a', 'b'), cols('a', 'c'))!;
    expect(rekey({ a: 1 })).toEqual({ a: 1, c: undefined });
  });
});
