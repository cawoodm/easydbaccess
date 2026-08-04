import { describe, expect, it } from 'vitest';
import type { SelectableTable, ViewMode } from '../../../packages/renderer/src/dialogs/table-select-dialog.js';

/**
 * The picker's SECTION arithmetic, without the DOM.
 *
 * The dialog is a Lit component and there is no jsdom in this repo, so what is
 * tested here is the logic the component delegates to: which indices belong to a
 * section, what an all/none confined to one section does to the other, and which
 * choices come back. Those are the parts a mistake would silently corrupt — a
 * "None" on Views that also cleared Tables, or a mode attached to a table.
 *
 * The functions mirror the component's private helpers exactly; keeping them in
 * step is the point of the test.
 */

/** Mirrors `TableSelectDialog.indicesOf`. */
function indicesOf(items: SelectableTable[], kind: 'table' | 'view'): number[] {
  return items.map((t, i) => ((t.kind ?? 'table') === kind ? i : -1)).filter((i) => i >= 0);
}

/** Mirrors `TableSelectDialog.setAll(value, kind)`. */
function setAll(items: SelectableTable[], selected: boolean[], value: boolean, kind?: 'table' | 'view'): boolean[] {
  return items.map((t, i) => (kind && (t.kind ?? 'table') !== kind ? (selected[i] ?? false) : value));
}

/** Mirrors the component's `submit`. */
function submit(items: SelectableTable[], selected: boolean[], modes: ViewMode[], offerViewModes: boolean): Array<{ index: number; mode?: ViewMode }> {
  const out: Array<{ index: number; mode?: ViewMode }> = [];
  selected.forEach((on, i) => {
    if (!on) return;
    const isView = (items[i]?.kind ?? 'table') === 'view';
    out.push(isView && offerViewModes ? { index: i, mode: modes[i] ?? 'projection' } : { index: i });
  });
  return out;
}

const items: SelectableTable[] = [
  { name: 'orders', size: 100, kind: 'table' },
  { name: 'customers', size: 20, kind: 'table' },
  { name: 'order_totals', size: null, kind: 'view' },
  { name: 'top_customers', size: null, kind: 'view' },
];

describe('the table/view picker sections', () => {
  it('groups by kind, treating an unkinded row as a table', () => {
    expect(indicesOf(items, 'table')).toEqual([0, 1]);
    expect(indicesOf(items, 'view')).toEqual([2, 3]);
    expect(indicesOf([{ name: 'x', size: 1 }], 'table')).toEqual([0]);
  });

  it('"None" on the Views section leaves the Tables section alone', () => {
    const selected = [true, true, true, true];
    const next = setAll(items, selected, false, 'view');
    expect(next).toEqual([true, true, false, false]);
  });

  it('"All" on Tables does not touch views the user already unchecked', () => {
    const selected = [false, false, false, true];
    const next = setAll(items, selected, true, 'table');
    expect(next).toEqual([true, true, false, true]);
  });

  it('with no kind given, all/none still covers everything', () => {
    expect(setAll(items, [true, false, true, false], false)).toEqual([false, false, false, false]);
    expect(setAll(items, [false, false, false, false], true)).toEqual([true, true, true, true]);
  });

  it('returns a mode for views only, never for tables', () => {
    const modes: ViewMode[] = ['projection', 'projection', 'data', 'projection'];
    const chosen = submit(items, [true, false, true, true], modes, true);
    expect(chosen).toEqual([{ index: 0 }, { index: 2, mode: 'data' }, { index: 3, mode: 'projection' }]);
  });

  it('omits modes entirely when they were not offered', () => {
    const chosen = submit(items, [true, true, true, true], ['projection', 'projection', 'data', 'data'], false);
    expect(chosen).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
  });
});
