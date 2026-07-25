import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { reconcileColumns } from './column-merge.js';

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
