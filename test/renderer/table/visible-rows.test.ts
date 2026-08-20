import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '../../../packages/shared/src/types.js';
import {
  __resetVisibleRowsWatchers,
  emitVisibleRows,
  provideVisibleRows,
  requestVisibleRows,
  sameVisibleRows,
  visibleRowsWanted,
  watchVisibleRows,
  type VisibleRowsDetail,
} from '../../../packages/renderer/src/table/visible-rows.js';

const rows: Row[] = [{ id: 'r1', tableId: 't1', data: { a: 1 }, updatedAt: 0 }];

const detail = (key: string, over: Partial<VisibleRowsDetail> = {}): VisibleRowsDetail => ({
  key,
  rows,
  total: 1,
  truncated: false,
  searching: false,
  ...over,
});

describe('visible-rows', () => {
  beforeEach(() => {
    __resetVisibleRowsWatchers();
  });

  it('nothing is wanted until something watches', () => {
    expect(visibleRowsWanted('t1')).toBe(false);
  });

  it('delivers the detail to a watcher of the same key', () => {
    const seen: VisibleRowsDetail[] = [];
    watchVisibleRows('t1', (d) => seen.push(d));
    emitVisibleRows(detail('t1'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(rows);
  });

  it('does not deliver across keys — a pane on one table ignores another', () => {
    const fn = vi.fn();
    watchVisibleRows('t1', fn);
    emitVisibleRows(detail('t2'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing is listening — the guard the grid relies on', () => {
    // The payload is the whole filtered row set, so publishing for nobody is the
    // cost this module exists to avoid. Must not throw either.
    expect(() => emitVisibleRows(detail('t1'))).not.toThrow();
  });

  it('stops wanting once every watcher releases', () => {
    const offA = watchVisibleRows('t1', () => {});
    const offB = watchVisibleRows('t1', () => {});
    expect(visibleRowsWanted('t1')).toBe(true);
    offA();
    // Still one pane left — releasing one must not switch publishing off for the other.
    expect(visibleRowsWanted('t1')).toBe(true);
    offB();
    expect(visibleRowsWanted('t1')).toBe(false);
  });

  it('a released watcher stops receiving', () => {
    const fn = vi.fn();
    const off = watchVisibleRows('t1', fn);
    off();
    // Another listener keeps the key live, so the emit is not swallowed by the
    // wanted-guard — this asserts the release, not the guard.
    watchVisibleRows('t1', () => {});
    emitVisibleRows(detail('t1'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes truncated and searching through, so a pane can own up to a capped read', () => {
    let got: VisibleRowsDetail | null = null;
    watchVisibleRows('t1', (d) => {
      got = d;
    });
    emitVisibleRows(detail('t1', { truncated: true, searching: true, total: 99 }));
    expect(got).toMatchObject({ truncated: true, searching: true, total: 99 });
  });

  it('survives a listener that throws — a broken chart is not a broken table', () => {
    const good = vi.fn();
    watchVisibleRows('t1', () => {
      throw new Error('boom');
    });
    watchVisibleRows('t1', good);
    expect(() => emitVisibleRows(detail('t1'))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('lets a listener release itself while being called', () => {
    const off = watchVisibleRows('t1', () => off());
    expect(() => emitVisibleRows(detail('t1'))).not.toThrow();
    expect(visibleRowsWanted('t1')).toBe(false);
  });

  it('two watchers on one key both hear it', () => {
    const a = vi.fn();
    const b = vi.fn();
    watchVisibleRows('t1', a);
    watchVisibleRows('t1', b);
    emitVisibleRows(detail('t1'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });
});

// The reason this half exists: a pane mounts AFTER the grid has rendered, and the
// grid publishes only when somebody is already listening. On an idle table the
// next publish never comes, so a push-only pane sat empty beside a full grid.
describe('visible-rows pull path', () => {
  beforeEach(() => {
    __resetVisibleRowsWatchers();
  });

  it('answers null when no grid is providing — a windowed viz, which reads for itself', () => {
    expect(requestVisibleRows('t1')).toBeNull();
  });

  it('a late listener can pull the current set without waiting for a re-render', () => {
    provideVisibleRows('t1', () => detail('t1', { total: 7 }));
    expect(requestVisibleRows('t1')).toMatchObject({ key: 't1', total: 7 });
  });

  it('does not answer across keys', () => {
    provideVisibleRows('t1', () => detail('t1'));
    expect(requestVisibleRows('t2')).toBeNull();
  });

  it('a provider may answer null — a grid that does not know its key yet', () => {
    provideVisibleRows('t1', () => null);
    expect(requestVisibleRows('t1')).toBeNull();
  });

  it('a released provider stops answering — a pull must not reach a detached grid', () => {
    const off = provideVisibleRows('t1', () => detail('t1'));
    off();
    expect(requestVisibleRows('t1')).toBeNull();
  });

  it('releasing a REPLACED provider does not unregister its successor', () => {
    // Two grids on one key overlap while a window is being rebuilt: the new one
    // registers before the old one disconnects, and the old one's release must not
    // take the live registration with it.
    const offOld = provideVisibleRows('t1', () => detail('t1', { total: 1 }));
    provideVisibleRows('t1', () => detail('t1', { total: 2 }));
    offOld();
    expect(requestVisibleRows('t1')).toMatchObject({ total: 2 });
  });

  it('the newest provider wins', () => {
    provideVisibleRows('t1', () => detail('t1', { total: 1 }));
    provideVisibleRows('t1', () => detail('t1', { total: 2 }));
    expect(requestVisibleRows('t1')).toMatchObject({ total: 2 });
  });

  it('survives a provider that throws — a broken pull is no rows, not a crash', () => {
    provideVisibleRows('t1', () => {
      throw new Error('boom');
    });
    expect(() => requestVisibleRows('t1')).not.toThrow();
    expect(requestVisibleRows('t1')).toBeNull();
  });

  it('push and pull are independent registries', () => {
    provideVisibleRows('t1', () => detail('t1'));
    // Providing rows is not the same as wanting them: the grid provides, the pane
    // watches, and the grid's publish-guard must not be tripped by its own
    // registration.
    expect(visibleRowsWanted('t1')).toBe(false);
  });

  it('the reset seam forgets providers too', () => {
    provideVisibleRows('t1', () => detail('t1'));
    __resetVisibleRowsWatchers();
    expect(requestVisibleRows('t1')).toBeNull();
  });
});

/**
 * The grid publishes from `updated()`, so it publishes on renders that changed
 * only how the table LOOKS. Resizing a column is the one that was reported: a
 * width write per pointermove, each one re-laying-out a docked word cloud and
 * re-fitting a docked map away from wherever the user had panned.
 */
describe('sameVisibleRows', () => {
  it('is false against no previous publish, so the first one always goes out', () => {
    expect(sameVisibleRows(null, detail('t1'))).toBe(false);
    expect(sameVisibleRows(undefined, detail('t1'))).toBe(false);
  });

  it('is true for a NEW ARRAY holding the same rows — the resize case', () => {
    // What a re-render produces: `filteredRows()` / `sortedRows()` build a fresh
    // array out of the same Row objects, so array identity says "changed" when
    // nothing did.
    const again = detail('t1', { rows: [...rows] });
    expect(again.rows).not.toBe(rows);
    expect(sameVisibleRows(detail('t1'), again)).toBe(true);
  });

  it('is false when a row OBJECT was replaced', () => {
    // Which is what a store write produces: a row is never mutated in place, so a
    // replaced reference is a reliable "the data changed".
    const edited: Row[] = [{ id: 'r1', tableId: 't1', data: { a: 2 }, updatedAt: 1 }];
    expect(sameVisibleRows(detail('t1'), detail('t1', { rows: edited }))).toBe(false);
  });

  it('is false when rows were added or removed', () => {
    const more: Row[] = [...rows, { id: 'r2', tableId: 't1', data: { a: 9 }, updatedAt: 0 }];
    expect(sameVisibleRows(detail('t1'), detail('t1', { rows: more, total: 2 }))).toBe(false);
    expect(sameVisibleRows(detail('t1', { rows: more, total: 2 }), detail('t1'))).toBe(false);
  });

  it('is false when the same rows are reordered', () => {
    const two: Row[] = [...rows, { id: 'r2', tableId: 't1', data: { a: 9 }, updatedAt: 0 }];
    // A sort is a change to the picture: a bar chart's categories follow row order.
    expect(sameVisibleRows(detail('t1', { rows: two }), detail('t1', { rows: [...two].reverse() }))).toBe(false);
  });

  it('is false when only the surrounding facts changed', () => {
    // `total`, `truncated` and `searching` are what the truncation note is built
    // from, so the same rows with a different total is a different thing to say.
    expect(sameVisibleRows(detail('t1'), detail('t1', { total: 500 }))).toBe(false);
    expect(sameVisibleRows(detail('t1'), detail('t1', { truncated: true }))).toBe(false);
    expect(sameVisibleRows(detail('t1'), detail('t1', { searching: true }))).toBe(false);
  });

  it('is false across keys, so a repointed grid always publishes', () => {
    expect(sameVisibleRows(detail('t1'), detail('t2'))).toBe(false);
  });

  it('treats two empty sets as the same', () => {
    expect(sameVisibleRows(detail('t1', { rows: [], total: 0 }), detail('t1', { rows: [], total: 0 }))).toBe(true);
  });
});
