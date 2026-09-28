import { describe, it, expect } from 'vitest';
import type { Row } from '../../../packages/shared/src/types.js';
import { ROW_META_KEY, metaValue, rowMeta, withRowMeta } from '../../../packages/renderer/src/views/row-meta.js';

/**
 * `_` — the record's own identity, where user code can reach it.
 *
 * Three things here are the whole contract and none of them can be read off the
 * type: that the id arrives under `rowId` rather than `id`, that a real column
 * is never shadowed, and that the object is STABLE per row — a fresh one per
 * call would redraw every cell renderer in the grid on every render.
 */

const at = 1_750_000_000_000;

function row(data: Record<string, unknown>, over: Partial<Row> = {}): Row {
  return { id: 'r-1', tableId: 't-1', data, updatedAt: at, ...over };
}

describe('rowMeta', () => {
  it('names the id `rowId`, not `id`', () => {
    // `row._.id` would read like a column called `id`, which plenty of tables
    // have. The whole point is to be unmistakable.
    expect(rowMeta(row({})).rowId).toBe('r-1');
    expect(rowMeta(row({})).tableId).toBe('t-1');
  });

  it('gives the same instant twice: a number and an ISO string', () => {
    const m = rowMeta(row({}));
    expect(m.updatedAt).toBe(at);
    // A template token cannot call a function, so the readable form has to be
    // there already.
    expect(m.updated).toBe(new Date(at).toISOString());
  });

  it('says nothing rather than lying when there is no timestamp', () => {
    const m = rowMeta(row({}, { updatedAt: 0 }));
    expect(m.updatedAt).toBe(0);
    // Not `1970-01-01…`, which is a date a reader would take at face value.
    expect(m.updated).toBe('');
  });
});

describe('metaValue', () => {
  it('reads one field by name', () => {
    expect(metaValue(row({}), 'rowId')).toBe('r-1');
  });

  it('is undefined for a name that is not metadata', () => {
    // Renders as nothing in a template — the same as an unmapped token, which is
    // the behaviour a `$_.` typo should have.
    expect(metaValue(row({ title: 'Bern' }), 'title')).toBeUndefined();
    expect(metaValue(row({}), 'nope')).toBeUndefined();
  });
});

describe('withRowMeta', () => {
  it('adds `_` beside the data', () => {
    const out = withRowMeta(row({ title: 'Bern' }));
    expect(out['title']).toBe('Bern');
    expect((out[ROW_META_KEY] as { rowId: string }).rowId).toBe('r-1');
  });

  it('never shadows a real column called `_`', () => {
    // Data wins, deliberately. A table that really has this column keeps it and
    // simply has no metadata in scripts; shadowing would break a script that was
    // working, with nothing on screen to say why.
    const out = withRowMeta(row({ _: 'mine' }));
    expect(out['_']).toBe('mine');
  });

  it('returns the SAME object for the same row', () => {
    // Load-bearing, not an optimisation: a cell renderer takes `.row` as a Lit
    // property and redraws when the reference changes, so a fresh object per
    // call would redraw every renderer in the grid on every render.
    const r = row({ title: 'Bern' });
    expect(withRowMeta(r)).toBe(withRowMeta(r));
  });

  it('gives a different object to a different row', () => {
    const a = row({ title: 'Bern' });
    const b = row({ title: 'Basel' }, { id: 'r-2' });
    expect(withRowMeta(a)).not.toBe(withRowMeta(b));
    expect((withRowMeta(b)[ROW_META_KEY] as { rowId: string }).rowId).toBe('r-2');
  });

  it('does not write into the stored row', () => {
    // The copy is shallow and one-way: a write goes through `patchFor` /
    // `commitCell`, which build their patch from the stored `Row`. If `_` ever
    // reached `row.data` it would be persisted as a column.
    const r = row({ title: 'Bern' });
    withRowMeta(r);
    expect(r.data['_']).toBeUndefined();
    expect(Object.keys(r.data)).toEqual(['title']);
  });
});
