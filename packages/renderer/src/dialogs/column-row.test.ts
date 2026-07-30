import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { buildColumnSpec, type ColumnRow } from './column-row.js';

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
    const spec = buildColumnSpec(
      row({ field: 'amount', label: 'Amount', type: 'string', orig: base }),
    );
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
    const spec = buildColumnSpec(
      row({ orig: base, hidden: false, notnull: false, unique: false, max: undefined }),
    );
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
    const spec = buildColumnSpec(
      row({ orig: base, sortable: undefined, filterable: undefined }),
    );
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
