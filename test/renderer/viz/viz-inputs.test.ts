import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '../../../packages/shared/src/types.js';
import { vizColumnsKey } from '../../../packages/renderer/src/viz/viz-inputs.js';

const col = (over: Partial<ColumnSpec> = {}): ColumnSpec => ({ field: 'amount', label: 'Amount', type: 'number', ...over });

/**
 * The reported bug: resizing a grid column persists a `width` on every
 * ColumnSpec, `viz-panel`'s `tables` subscription took that write, and the panel
 * re-rendered — re-laying-out a word cloud and re-fitting a map away from
 * wherever the user had panned.
 */
describe('vizColumnsKey', () => {
  it('ignores a width change — the resize case', () => {
    expect(vizColumnsKey([col({ width: 120 })])).toBe(vizColumnsKey([col({ width: 480 })]));
    // Including a width appearing for the first time, which is what the drag's
    // freeze-then-persist step writes for every visible column at once.
    expect(vizColumnsKey([col()])).toBe(vizColumnsKey([col({ width: 200 })]));
  });

  it('ignores the other grid-only fields', () => {
    for (const optics of [{ hidden: true }, { sortable: false }, { filterable: false }, { readonly: true }, { description: 'note' }, { units: 'CHF' }, { renderer: 'cell-color' }] as Array<
      Partial<ColumnSpec>
    >) {
      expect(vizColumnsKey([col(optics)])).toBe(vizColumnsKey([col()]));
    }
  });

  it('notices a rename', () => {
    // A channel is mapped BY FIELD NAME, so a rename decides whether the chart has
    // any data at all.
    expect(vizColumnsKey([col({ field: 'total' })])).not.toBe(vizColumnsKey([col()]));
  });

  it('notices a label change', () => {
    // The label is what an axis and a legend are captioned with.
    expect(vizColumnsKey([col({ label: 'Total' })])).not.toBe(vizColumnsKey([col()]));
  });

  it('notices a type change', () => {
    // The type decides whether a cell is read as a number or as text, which is the
    // difference between a bar and a skipped value.
    expect(vizColumnsKey([col({ type: 'text' })])).not.toBe(vizColumnsKey([col()]));
  });

  it('notices a script being added, edited or removed', () => {
    // A scripted column stores nothing — the chart aggregates what the script
    // returns, so editing it changes every number drawn.
    const plain = vizColumnsKey([col()]);
    const scripted = vizColumnsKey([col({ script: 'function render(row){return 1}' })]);
    expect(scripted).not.toBe(plain);
    expect(vizColumnsKey([col({ script: 'function render(row){return 2}' })])).not.toBe(scripted);
    expect(vizColumnsKey([col({ script: '' })])).toBe(plain);
  });

  it('notices a column added, removed or reordered', () => {
    const one = col();
    const two = col({ field: 'country', label: 'Country', type: 'text' });
    expect(vizColumnsKey([one, two])).not.toBe(vizColumnsKey([one]));
    // Order is the order channels are offered in and the order a row-per-mark
    // visualization walks, so it is not sorted away.
    expect(vizColumnsKey([one, two])).not.toBe(vizColumnsKey([two, one]));
  });

  it('cannot be confused by a field name that looks like the separator', () => {
    // Two columns whose keys concatenate must not collide with one differently
    // split pair — the reason each column is JSON-encoded rather than joined raw.
    const tricky = [col({ field: 'a', label: '","b' }), col({ field: 'c' })];
    const other = [col({ field: 'a', label: '' }), col({ field: 'b' }), col({ field: 'c' })];
    expect(vizColumnsKey(tricky)).not.toBe(vizColumnsKey(other));
  });

  it('treats no columns and undefined the same', () => {
    expect(vizColumnsKey(undefined)).toBe(vizColumnsKey([]));
  });
});
