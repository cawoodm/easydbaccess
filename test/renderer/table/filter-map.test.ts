import { describe, expect, it } from 'vitest';
import { remapFilterFields, sameFilterMap } from '../../../packages/renderer/src/table/filter-map.js';

/**
 * `Table.filters` is keyed by field, so the columns editor has to move the keys
 * when it moves the columns. A filter left on a field no column has is dropped
 * by the row reader on purpose, which means it stops working with nobody told.
 */
describe('remapFilterFields', () => {
  it('carries a filter to the renamed field', () => {
    expect(remapFilterFields({ old: '=x' }, [{ from: 'old', to: 'new' }], new Set(['new']))).toEqual({ new: '=x' });
  });

  it('drops the filter of a column that is gone', () => {
    expect(remapFilterFields({ a: '=x', b: '=y' }, [], new Set(['a']))).toEqual({ a: '=x' });
  });

  it('drops a blank expression, which narrows nothing anyway', () => {
    expect(remapFilterFields({ a: '', b: '   ', c: '=y' }, [], new Set(['a', 'b', 'c']))).toEqual({ c: '=y' });
  });

  it('leaves untouched fields alone', () => {
    const out = remapFilterFields({ a: '=x', b: '=y' }, [{ from: 'b', to: 'z' }], new Set(['a', 'z']));
    expect(out).toEqual({ a: '=x', z: '=y' });
  });

  it('renaming a field the target of which is not kept drops the filter', () => {
    // Renamed and then removed in the same save: the rename wins the key, and
    // the key is not among the saved fields, so nothing is stored.
    expect(remapFilterFields({ a: '=x' }, [{ from: 'a', to: 'b' }], new Set(['c']))).toEqual({});
  });
});

describe('sameFilterMap', () => {
  it('is true for the same entries', () => {
    expect(sameFilterMap({ a: '=x' }, { a: '=x' })).toBe(true);
  });

  it('treats a blank entry as no entry', () => {
    expect(sameFilterMap({ a: '' }, {})).toBe(true);
  });

  it('is false when a value differs', () => {
    expect(sameFilterMap({ a: '=x' }, { a: '=y' })).toBe(false);
  });

  it('is false when one side has an extra field', () => {
    expect(sameFilterMap({ a: '=x' }, { a: '=x', b: '=y' })).toBe(false);
  });
});
