import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '../../../packages/shared/src/types.js';
import { __resetVisibleRowsWatchers, emitVisibleRows, visibleRowsWanted, watchVisibleRows, type VisibleRowsDetail } from '../../../packages/renderer/src/table/visible-rows.js';

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
