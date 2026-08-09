import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row } from '@easydb/shared';
import { hasStoredData, isComputedOnly, searchableColumns } from '../../../packages/renderer/src/search/searchable-columns.js';

/**
 * A scripted column's value is computed at render time and never written back, so
 * `row.data[field]` is empty for every row — searching it matches nothing while
 * the grid plainly shows the value being searched for. These tests pin when the
 * app is allowed to work that out for itself.
 */
const col = (field: string, over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field, type: 'string', ...over });
const row = (data: Record<string, unknown>): Row => ({ id: `r${Math.abs(hash(JSON.stringify(data)))}`, tableId: 't', data, updatedAt: 0 });
const hash = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0);

const SCRIPT = 'function render(row) { return row.a + 1; }';

describe('searchable-columns', () => {
  it('hasStoredData ignores null and empty string but keeps 0 and false', () => {
    expect(hasStoredData([row({ a: null }), row({ a: '' })], 'a')).toBe(false);
    expect(hasStoredData([row({ a: 0 })], 'a')).toBe(true);
    expect(hasStoredData([row({ a: false })], 'a')).toBe(true);
    expect(hasStoredData([], 'a')).toBe(false);
    expect(hasStoredData([row({ b: 'x' })], 'a')).toBe(false);
  });

  it('a scripted column with no stored value is computed-only', () => {
    const rows = [row({ a: 1 }), row({ a: 2 })];
    expect(isComputedOnly(col('calc', { script: SCRIPT }), rows)).toBe(true);
  });

  it('a scripted column that DOES store data is left searchable', () => {
    // The column carried values before a script was added, or an import filled
    // it. Freezing `filterable: false` onto the model would have been wrong here.
    const rows = [row({ calc: 'kept' })];
    expect(isComputedOnly(col('calc', { script: SCRIPT }), rows)).toBe(false);
  });

  it('an unscripted empty column stays searchable — empty is not the same as computed', () => {
    expect(isComputedOnly(col('notes'), [row({ notes: '' })])).toBe(false);
  });

  it('no rows means no evidence, so nothing is dropped', () => {
    // An empty table, or a read that has not landed. Dropping a column from
    // search on no evidence is the worse mistake.
    expect(isComputedOnly(col('calc', { script: SCRIPT }), [])).toBe(false);
    expect(searchableColumns([col('calc', { script: SCRIPT })], []).map((c) => c.field)).toEqual(['calc']);
  });

  it('searchableColumns drops the computed-only ones and honours the explicit flag', () => {
    const columns = [col('a'), col('calc', { script: SCRIPT }), col('hidden', { filterable: false }), col('stored', { script: SCRIPT })];
    const rows = [row({ a: 1, stored: 'x' })];
    expect(searchableColumns(columns, rows).map((c) => c.field)).toEqual(['a', 'stored']);
  });

  it('an explicit filterable: false still wins on a column that has data', () => {
    expect(searchableColumns([col('a', { filterable: false })], [row({ a: 'x' })])).toEqual([]);
  });
});
