import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCurrentRow,
  clearCurrentRow,
  currentRowWanted,
  provideCurrentRow,
  rememberedCurrentRow,
  requestCurrentRow,
  setCurrentRow,
  watchCurrentRow,
} from '../../../packages/renderer/src/table/current-row.js';

/**
 * The selection seam a record pane follows — the twin of `visible-rows.ts`.
 *
 * Three rules carry weight and each has a test below:
 *
 * 1. **Push for updates, PULL for the first value.** A pane mounts after the
 *    grid, so a selection it was not there to hear must still be readable.
 * 2. **The grid gets a veto.** It is the only thing that knows whether the
 *    remembered row is still on screen; when it says no, the answer is null and
 *    the pane falls back to the first visible row.
 * 3. **`currentRowWanted` is the handover.** `viz-record` acts on a row
 *    double-click only when something is following; `edit-record` stands down
 *    only when something is. Exactly one of them acts, and neither imports the
 *    other.
 */

afterEach(() => __resetCurrentRow());

describe('watch and set', () => {
  it('tells a watcher what was selected', () => {
    const seen: (string | null)[] = [];
    watchCurrentRow('t1', (id) => seen.push(id));
    setCurrentRow('t1', 'r-7');
    setCurrentRow('t1', null);
    expect(seen).toEqual(['r-7', null]);
  });

  it('says nothing when the selection did not change', () => {
    const fn = vi.fn();
    watchCurrentRow('t1', fn);
    setCurrentRow('t1', 'r-7');
    setCurrentRow('t1', 'r-7');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps each key's selection to itself", () => {
    const one = vi.fn();
    const two = vi.fn();
    watchCurrentRow('t1', one);
    watchCurrentRow('t2', two);
    setCurrentRow('t1', 'r-1');
    expect(one).toHaveBeenCalledWith('r-1');
    expect(two).not.toHaveBeenCalled();
  });

  it('releases a watcher', () => {
    const fn = vi.fn();
    const off = watchCurrentRow('t1', fn);
    off();
    setCurrentRow('t1', 'r-7');
    expect(fn).not.toHaveBeenCalled();
  });

  it('survives a watcher that throws', () => {
    const after = vi.fn();
    watchCurrentRow('t1', () => {
      throw new Error('boom');
    });
    watchCurrentRow('t1', after);
    // A broken pane is a broken picture, not a broken grid.
    expect(() => setCurrentRow('t1', 'r-1')).not.toThrow();
    expect(after).toHaveBeenCalledWith('r-1');
  });

  it('ignores an empty key', () => {
    const fn = vi.fn();
    watchCurrentRow('', fn);
    setCurrentRow('', 'r-1');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('remembering, so a late pane can pull', () => {
  it('remembers a selection made before anyone was listening', () => {
    // The grid selects, THEN a pane mounts. Without this the pane sees nothing
    // until the next double-click.
    setCurrentRow('t1', 'r-7');
    expect(requestCurrentRow('t1')).toBe('r-7');
  });

  it('answers null for a key nothing has ever selected in', () => {
    expect(requestCurrentRow('nope')).toBeNull();
  });

  it('forgets on demand, so a reopened window starts clean', () => {
    setCurrentRow('t1', 'r-7');
    clearCurrentRow('t1');
    expect(requestCurrentRow('t1')).toBeNull();
  });
});

describe("the grid's veto", () => {
  it('lets the grid confirm the remembered row', () => {
    setCurrentRow('t1', 'r-7');
    provideCurrentRow('t1', () => 'r-7');
    expect(requestCurrentRow('t1')).toBe('r-7');
  });

  it('answers null when the grid says the row is gone', () => {
    // Deleted, or filtered off screen. The pane then falls back to the first
    // visible row rather than drawing a record the grid is not showing.
    setCurrentRow('t1', 'r-7');
    provideCurrentRow('t1', () => null);
    expect(requestCurrentRow('t1')).toBeNull();
  });

  it('falls back to what was set when the grid throws', () => {
    setCurrentRow('t1', 'r-7');
    provideCurrentRow('t1', () => {
      throw new Error('boom');
    });
    expect(requestCurrentRow('t1')).toBe('r-7');
  });

  it('releases the provider', () => {
    setCurrentRow('t1', 'r-7');
    const off = provideCurrentRow('t1', () => null);
    expect(requestCurrentRow('t1')).toBeNull();
    off();
    // With no grid to ask, the remembered value is the answer again.
    expect(requestCurrentRow('t1')).toBe('r-7');
  });

  it('gives the grid the raw remembered id, without calling itself', () => {
    // `rememberedCurrentRow` exists precisely so the provider can ask "which row
    // was I asked about" — going through `requestCurrentRow` would re-enter it.
    setCurrentRow('t1', 'r-7');
    provideCurrentRow('t1', () => (rememberedCurrentRow('t1') === 'r-7' ? 'r-7' : null));
    expect(requestCurrentRow('t1')).toBe('r-7');
  });
});

describe('currentRowWanted', () => {
  it('is false with nothing listening', () => {
    expect(currentRowWanted('t1')).toBe(false);
  });

  it('is true while a pane follows, and false again once it goes', () => {
    const off = watchCurrentRow('t1', () => {});
    expect(currentRowWanted('t1')).toBe(true);
    off();
    expect(currentRowWanted('t1')).toBe(false);
  });

  it('is not made true by a selection alone', () => {
    // Setting a row is not the same as something caring about it. If this were
    // true, one stray double-click would silence `edit-record` for good.
    setCurrentRow('t1', 'r-7');
    expect(currentRowWanted('t1')).toBe(false);
  });
});
