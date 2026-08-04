// packages/renderer/src/table/refresh-merge.test.ts

import { describe, it, expect } from 'vitest';
import { mergeRefreshedRows } from '../../../packages/renderer/src/table/refresh-merge';

describe('mergeRefreshedRows', () => {
  it('preserves a user-added column value on the correct row after a remote refresh', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Old Title', read: true } }, { data: { id: 2, title: 'Other', read: false } }],
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

  it('cannot recognise a keyless row whose remote content changed, and says so', () => {
    // No pk, and `title` went Old -> New, so there is nothing left tying the
    // fresh row to the old one. The user's `read` value is genuinely lost —
    // what matters is that the result reports it rather than hiding it.
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Old', read: true, secret: 'x' } }],
      freshRows: [{ id: 1, title: 'New', secret: 'y' }],
      pks: [],
      userAddedFields: ['read'],
      deletedRemoteFields: ['secret'],
    });
    expect(result.strategy).toBe('content');
    expect(result.data).toEqual([{ id: 1, title: 'New' }]);
    expect(result.droppedUserRows).toBe(1);
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
      oldRows: [{ data: { a: 1, b: 'x', title: 'One', read: true } }, { data: { a: 1, b: 'y', title: 'Two', read: false } }],
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

describe('keyless sources still keep the user’s own columns', () => {
  // The reported bug: import a CSV/JSON snapshot (or a Datasette VIEW, which
  // has no primary key), add a column, type into it, hit Refresh — and the
  // typing was gone. Without pks the merge replaced every row wholesale.
  //
  // A row's REMOTE fields are its own natural key: if the source still has a
  // row with those values, it is that row. This is weaker than a real pk (a
  // row whose remote value CHANGED cannot be recognised) but it is never wrong
  // in the way positional matching would be.
  it('carries user columns across when the remote values are unchanged', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { city: 'Bern', pop: 100, note: 'visited' } }, { data: { city: 'Zug', pop: 30, note: 'todo' } }],
      freshRows: [
        { city: 'Bern', pop: 100 },
        { city: 'Zug', pop: 31 },
      ],
      pks: [],
      userAddedFields: ['note'],
    });
    expect(result.merged).toBe(true);
    expect(result.strategy).toBe('content');
    expect(result.data).toEqual([
      { city: 'Bern', pop: 100, note: 'visited' },
      // Zug's population changed, so there is no way to know it is the same
      // row — its note is lost, and the result says so rather than hiding it.
      { city: 'Zug', pop: 31 },
    ]);
    expect(result.droppedUserRows).toBe(1);
  });

  it('matches on content regardless of row ORDER', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { city: 'Bern', note: 'a' } }, { data: { city: 'Zug', note: 'b' } }],
      freshRows: [{ city: 'Zug' }, { city: 'Bern' }],
      pks: [],
      userAddedFields: ['note'],
    });
    expect(result.data).toEqual([
      { city: 'Zug', note: 'b' },
      { city: 'Bern', note: 'a' },
    ]);
    expect(result.droppedUserRows).toBe(0);
  });

  it('still uses the primary key when there is one', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, title: 'Old', note: 'keep' } }],
      freshRows: [{ id: 1, title: 'New' }],
      pks: ['id'],
      userAddedFields: ['note'],
    });
    // A pk matches even though the remote content changed — which is exactly
    // why a real key beats content matching.
    expect(result.strategy).toBe('pk');
    expect(result.data).toEqual([{ id: 1, title: 'New', note: 'keep' }]);
  });

  it('falls back to content when only SOME fresh rows carry a pk value', () => {
    // One missing pk used to abandon the merge for the whole table.
    const result = mergeRefreshedRows({
      oldRows: [{ data: { id: 1, city: 'Bern', note: 'a' } }, { data: { id: null, city: 'Zug', note: 'b' } }],
      freshRows: [
        { id: 1, city: 'Bern' },
        { id: null, city: 'Zug' },
      ],
      pks: ['id'],
      userAddedFields: ['note'],
    });
    expect(result.strategy).toBe('content');
    expect(result.data).toEqual([
      { id: 1, city: 'Bern', note: 'a' },
      { id: null, city: 'Zug', note: 'b' },
    ]);
  });

  it('does not carry anything when the rows have no remote fields to key on', () => {
    // Every row would hash identically, so the first old row's values would be
    // smeared onto all of them. Better to carry nothing.
    const result = mergeRefreshedRows({
      oldRows: [{ data: { note: 'a' } }, { data: { note: 'b' } }],
      freshRows: [{}, {}],
      pks: [],
      userAddedFields: ['note'],
    });
    expect(result.strategy).toBe('none');
    expect(result.data).toEqual([{}, {}]);
  });

  it('gives a duplicated remote row the first matching old row, once', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { city: 'Bern', note: 'first' } }, { data: { city: 'Bern', note: 'second' } }],
      freshRows: [{ city: 'Bern' }, { city: 'Bern' }],
      pks: [],
      userAddedFields: ['note'],
    });
    // Indistinguishable rows: first-wins, the same rule the pk path uses.
    expect(result.data).toEqual([
      { city: 'Bern', note: 'first' },
      { city: 'Bern', note: 'first' },
    ]);
  });
});

describe('content matching survives a source that changed shape', () => {
  it('still matches when the source GREW a column', () => {
    // Keying on every fresh field would break here: `canton` is on no old row,
    // so every key would differ and every user value would be dropped — in the
    // very case a refresh exists for.
    const result = mergeRefreshedRows({
      oldRows: [{ data: { city: 'Bern', pop: 133000, note: 'seen' } }],
      freshRows: [{ city: 'Bern', pop: 133000, canton: 'BE' }],
      pks: [],
      userAddedFields: ['note'],
    });
    expect(result.data).toEqual([{ city: 'Bern', pop: 133000, canton: 'BE', note: 'seen' }]);
    expect(result.droppedUserRows).toBe(0);
  });

  it('still matches when the source DROPPED a column', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { city: 'Bern', pop: 133000, note: 'seen' } }],
      freshRows: [{ city: 'Bern' }],
      pks: [],
      userAddedFields: ['note'],
    });
    expect(result.data).toEqual([{ city: 'Bern', note: 'seen' }]);
  });

  it('ignores a remote column the user deleted when keying', () => {
    const result = mergeRefreshedRows({
      oldRows: [{ data: { city: 'Bern', pop: 1, note: 'seen' } }],
      // `pop` changed, but the user deleted it, so it must not break the match.
      freshRows: [{ city: 'Bern', pop: 2 }],
      pks: [],
      userAddedFields: ['note'],
      deletedRemoteFields: ['pop'],
    });
    expect(result.data).toEqual([{ city: 'Bern', note: 'seen' }]);
  });

  it('carries nothing on a first refresh of an empty table, without claiming a loss', () => {
    const result = mergeRefreshedRows({
      oldRows: [],
      freshRows: [{ city: 'Bern' }],
      pks: [],
      userAddedFields: ['note'],
    });
    expect(result.data).toEqual([{ city: 'Bern' }]);
    expect(result.droppedUserRows).toBe(0);
  });
});
