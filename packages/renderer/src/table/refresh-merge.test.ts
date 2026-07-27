// packages/renderer/src/table/refresh-merge.test.ts

import { describe, it, expect } from 'vitest';
import { mergeRefreshedRows } from './refresh-merge';

describe('mergeRefreshedRows', () => {
  it('preserves a user-added column value on the correct row after a remote refresh', () => {
    const result = mergeRefreshedRows({
      oldRows: [
        { data: { id: 1, title: 'Old Title', read: true } },
        { data: { id: 2, title: 'Other', read: false } },
      ],
      freshRows: [
        { id: 1, title: 'Old Title' },
        { id: 2, title: 'Other' },
      ],
      pks: ['id'],
      userAddedFields: ['read'],
    });
    expect(result.merged).toBe(true);
    expect(result.data).toEqual([
      { id: 1, title: 'Old Title', read: true },
      { id: 2, title: 'Other', read: false },
    ]);
  });

  it('overwrites (clobbers) a remote column value with the fresh value', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Stale Title', read: true } }],
      freshRows: [{ id: 1, title: 'Fresh Title' }],
      pks: ['id'],
      userAddedFields: ['read'],
    });
    expect(result.data).toEqual([{ id: 1, title: 'Fresh Title', read: true }]);
  });

  it('restores a row present in fresh but absent from old (a previously locally-deleted row)', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Kept', read: true } }],
      freshRows: [
        { id: 1, title: 'Kept' },
        { id: 2, title: 'Restored' },
      ],
      pks: ['id'],
      userAddedFields: ['read'],
    });
    expect(result.merged).toBe(true);
    expect(result.data).toEqual([
      { id: 1, title: 'Kept', read: true },
      { id: 2, title: 'Restored' },
    ]);
  });

  it('falls back to fresh-only output when pks is empty (keyless fallback)', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Old', read: true, secret: 'x' } }],
      freshRows: [{ id: 1, title: 'New', secret: 'y' }],
      pks: [],
      userAddedFields: ['read'],
      deletedRemoteFields: ['secret'],
    });
    expect(result.merged).toBe(false);
    expect(result.data).toEqual([{ id: 1, title: 'New' }]);
  });

  it('never includes a field listed in deletedRemoteFields in any output row', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Old', legacy: 'gone', read: true } }],
      freshRows: [{ id: 1, title: 'New', legacy: 'still-there' }],
      pks: ['id'],
      userAddedFields: ['read'],
      deletedRemoteFields: ['legacy'],
    });
    expect(result.data).toEqual([{ id: 1, title: 'New', read: true }]);
    for (const row of result.data) {
      expect(Object.prototype.hasOwnProperty.call(row, 'legacy')).toBe(false);
    }
  });

  it('supports composite/multi-pk matching', () => {
    const result = mergeRefreshedRows({
      oldRows: [
        { data: { a: 1, b: 'x', title: 'One', read: true } },
        { data: { a: 1, b: 'y', title: 'Two', read: false } },
      ],
      freshRows: [
        { a: 1, b: 'y', title: 'Two Fresh' },
        { a: 1, b: 'x', title: 'One Fresh' },
      ],
      pks: ['a', 'b'],
      userAddedFields: ['read'],
    });
    expect(result.merged).toBe(true);
    expect(result.data).toEqual([
      { a: 1, b: 'y', title: 'Two Fresh', read: false },
      { a: 1, b: 'x', title: 'One Fresh', read: true },
    ]);
  });
});
