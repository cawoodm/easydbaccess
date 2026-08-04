import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { allColumnsFlagged, buildColumnSpec, columnFlag, toggleColumnFlag, type ColumnRow } from '../../../packages/renderer/src/dialogs/column-row.js';

const orig = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  field: 'qty',
  label: 'Quantity',
  type: 'number',
  ...extra,
});

const row = (extra: Partial<ColumnRow> = {}): ColumnRow => ({
  field: 'qty',
  label: 'Quantity',
  type: 'number',
  ...extra,
});

describe('buildColumnSpec', () => {
  it('carries width/description/units/default through unchanged', () => {
    const base = orig({
      width: 120,
      description: 'How many',
      units: 'kg',
      default: 0,
    });
    const spec = buildColumnSpec(row({ orig: base }));
    expect(spec.width).toBe(120);
    expect(spec.description).toBe('How many');
    expect(spec.units).toBe('kg');
    expect(spec.default).toBe(0);
  });

  it('always overwrites field/label/type from the draft, even with an orig base', () => {
    const base = orig({ field: 'qty', label: 'Quantity', type: 'number', width: 80 });
    const spec = buildColumnSpec(row({ field: 'amount', label: 'Amount', type: 'string', orig: base }));
    expect(spec.field).toBe('amount');
    expect(spec.label).toBe('Amount');
    expect(spec.type).toBe('string');
    expect(spec.width).toBe(80); // untouched field survives despite the rename
  });

  it('sets renderer/script/max/unique/notnull/hidden when present', () => {
    const spec = buildColumnSpec(
      row({
        renderer: 'boolean',
        script: undefined,
        max: 10,
        unique: true,
        notnull: true,
        hidden: true,
      }),
    );
    expect(spec.renderer).toBe('boolean');
    expect(spec.max).toBe(10);
    expect(spec.unique).toBe(true);
    expect(spec.notnull).toBe(true);
    expect(spec.hidden).toBe(true);
  });

  it('removes renderer when cleared, even though orig had one', () => {
    const base = orig({ renderer: 'date' });
    const spec = buildColumnSpec(row({ orig: base, renderer: undefined }));
    expect(spec.renderer).toBeUndefined();
    expect('renderer' in spec).toBe(false);
  });

  it('removes hidden/notnull/unique/max when cleared, even though orig had them', () => {
    const base = orig({ hidden: true, notnull: true, unique: true, max: 50 });
    const spec = buildColumnSpec(row({ orig: base, hidden: false, notnull: false, unique: false, max: undefined }));
    expect('hidden' in spec).toBe(false);
    expect('notnull' in spec).toBe(false);
    expect('unique' in spec).toBe(false);
    expect('max' in spec).toBe(false);
  });

  it('a max of 0 or less is treated as cleared', () => {
    const base = orig({ max: 50 });
    const spec = buildColumnSpec(row({ orig: base, max: 0 }));
    expect('max' in spec).toBe(false);
  });

  it('persists sortable: false and filterable: false from the draft', () => {
    const spec = buildColumnSpec(row({ sortable: false, filterable: false }));
    expect(spec.sortable).toBe(false);
    expect(spec.filterable).toBe(false);
  });

  it('re-enabling sortable/filterable (draft undefined) deletes the keys, even when orig had them false', () => {
    const base = orig({ sortable: false, filterable: false });
    const spec = buildColumnSpec(row({ orig: base, sortable: undefined, filterable: undefined }));
    expect('sortable' in spec).toBe(false);
    expect('filterable' in spec).toBe(false);
  });

  it('a column with neither flag set produces a spec with neither key present', () => {
    const spec = buildColumnSpec(row());
    expect('sortable' in spec).toBe(false);
    expect('filterable' in spec).toBe(false);
  });

  it('new-table mode (no orig) produces a minimal spec with no leftover fields', () => {
    const spec = buildColumnSpec(row());
    expect(spec).toEqual({ field: 'qty', label: 'Quantity', type: 'number' });
  });

  it('trims field/label and falls back to field when label is blank', () => {
    const spec = buildColumnSpec(row({ field: '  amount  ', label: '   ' }));
    expect(spec.field).toBe('amount');
    expect(spec.label).toBe('amount');
  });
});

/**
 * Clicking a checkbox column's header sets or clears every box in it.
 *
 * The reason this is worth testing rather than obvious: three of the five boxes
 * are not stored as the box reads. `hidden` is the inverse of the "visible" box,
 * and `sortable`/`filterable` default to enabled, so a TICKED box means the
 * field is absent and only the unticked state is persisted. A toggle that set
 * `true` on those would look right in the editor and write a spec that means
 * nothing.
 */
describe('toggleColumnFlag', () => {
  const rows = (): ColumnRow[] => [row({ field: 'a' }), row({ field: 'b' }), row({ field: 'c' })];

  it('ticks every box when they are not all ticked', () => {
    const before = [row({ unique: true }), row(), row()];
    const after = toggleColumnFlag(before, 'unique');
    expect(after.map((r) => r.unique)).toEqual([true, true, true]);
  });

  it('clears every box when they are all ticked', () => {
    const after = toggleColumnFlag([row({ unique: true }), row({ unique: true })], 'unique');
    expect(after.map((r) => r.unique)).toEqual([undefined, undefined]);
  });

  it('goes all then none over two clicks from a mixed column', () => {
    // Mixed ticks first: the click means "select all", so the two reachable
    // states are all and none, in that order.
    const once = toggleColumnFlag([row({ notnull: true }), row()], 'notnull');
    expect(allColumnsFlagged(once, 'notnull')).toBe(true);
    const twice = toggleColumnFlag(once, 'notnull');
    expect(twice.map((r) => r.notnull)).toEqual([undefined, undefined]);
  });

  it('writes `visible` as the inverse of the stored `hidden`', () => {
    const hiddenAll = toggleColumnFlag(
      rows().map((r) => ({ ...r, hidden: true })),
      'visible',
    );
    expect(hiddenAll.every((r) => r.hidden === undefined)).toBe(true);
    const nowHidden = toggleColumnFlag(hiddenAll, 'visible');
    expect(nowHidden.every((r) => r.hidden === true)).toBe(true);
  });

  it('clears `sortable`/`filterable` when ticked, since absent means enabled', () => {
    // All three start enabled-by-absence, so the first click UNticks them.
    const off = toggleColumnFlag(rows(), 'sortable');
    expect(off.map((r) => r.sortable)).toEqual([false, false, false]);
    const on = toggleColumnFlag(off, 'sortable');
    expect(on.map((r) => r.sortable)).toEqual([undefined, undefined, undefined]);
    // And the cleared state is what buildColumnSpec omits entirely.
    expect('sortable' in buildColumnSpec(on[0]!)).toBe(false);
    expect(buildColumnSpec(off[0]!).sortable).toBe(false);
  });

  it('touches only the flag asked for', () => {
    const before = [row({ unique: true, notnull: true, hidden: true, max: 5 })];
    const after = toggleColumnFlag(before, 'visible');
    expect(after[0]).toMatchObject({ unique: true, notnull: true, max: 5, hidden: undefined });
  });

  it('reads an empty editor as fully flagged, so the first click clears', () => {
    // Vacuous truth, and the honest answer: there is no box left unticked.
    expect(allColumnsFlagged([], 'visible')).toBe(true);
    expect(toggleColumnFlag([], 'visible')).toEqual([]);
  });

  it('reads each of the five boxes from its own storage rule', () => {
    // The two opt-IN flags are ticked only when set; the three others are ticked
    // by default, which is where a single uniform reading would go wrong.
    const bare = row();
    expect(columnFlag(bare, 'unique')).toBe(false);
    expect(columnFlag(bare, 'notnull')).toBe(false);
    expect(columnFlag(bare, 'visible')).toBe(true);
    expect(columnFlag(bare, 'sortable')).toBe(true);
    expect(columnFlag(bare, 'filterable')).toBe(true);

    const set = row({ unique: true, notnull: true, hidden: true, sortable: false, filterable: false });
    expect(columnFlag(set, 'unique')).toBe(true);
    expect(columnFlag(set, 'notnull')).toBe(true);
    expect(columnFlag(set, 'visible')).toBe(false);
    expect(columnFlag(set, 'sortable')).toBe(false);
    expect(columnFlag(set, 'filterable')).toBe(false);
  });
});
