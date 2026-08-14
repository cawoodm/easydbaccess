import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row } from '@easydb/shared';
import { MAX_PILLS, aggregate, distinctValues, substituteVizTokens, vizFilterFields } from '../../../packages/renderer/src/viz/viz-tokens.js';

function rows(...data: Array<Record<string, unknown>>): Row[] {
  return data.map((d, i) => ({ id: `r${i}`, tableId: 't', data: d, updatedAt: 0 }));
}

const cols = (...specs: Array<Partial<ColumnSpec> & { field: string }>): ColumnSpec[] => specs.map((s) => ({ label: s.field, type: 'string', ...s }) as ColumnSpec);

const SALES = rows({ country: 'CH', amount: 10 }, { country: 'DE', amount: 5 }, { country: 'CH', amount: 20 });

describe('substituteVizTokens — the vocabulary', () => {
  it('$COUNT is the size of the set the pane was given', () => {
    expect(substituteVizTokens('<b>$COUNT</b> rows', SALES)).toBe('<b>3</b> rows');
  });

  it('$COUNT.field counts only the rows carrying a value', () => {
    const r = rows({ note: 'x' }, { note: '' }, {}, { note: 'y' });
    expect(substituteVizTokens('$COUNT.note', r)).toBe('2');
  });

  it('sums, averages and finds extremes over the column', () => {
    expect(substituteVizTokens('$SUM.amount', SALES)).toBe('35');
    expect(substituteVizTokens('$AVG.amount', rows({ amount: 1 }, { amount: 2 }))).toBe('1.5');
    expect(substituteVizTokens('$MIN.amount|$MAX.amount', SALES)).toBe('5|20');
  });

  it('counts distinct values, not rows', () => {
    expect(substituteVizTokens('$DISTINCT.country', SALES)).toBe('2');
  });

  it('leaves anything outside the vocabulary exactly as written', () => {
    // The user writes the whole document, so `$` is ordinary text in CSS and JS
    // — and a typo that vanished would be harder to spot than one left on screen.
    expect(substituteVizTokens('$COUTN and $margin-top and $filter', SALES)).toBe('$COUTN and $margin-top and $filter');
  });

  it('marks a token naming a column that is not there', () => {
    const out = substituteVizTokens('$SUM.revenu', SALES, cols({ field: 'amount', type: 'number' }));
    expect(out).toContain('eda-token-error');
    expect(out).toContain('no column revenu');
  });
});

describe('substituteVizTokens — resolving the column', () => {
  it('matches a field case-insensitively so $filter.COUNTRY finds country', () => {
    expect(substituteVizTokens('$DISTINCT.COUNTRY', SALES, cols({ field: 'country' }))).toBe('2');
  });

  it('reads a column the table never declared', () => {
    // An import that has not been through the columns editor still holds the
    // data; refusing it for want of a ColumnSpec is a distinction nobody can see.
    expect(substituteVizTokens('$SUM.amount', SALES, [])).toBe('35');
  });
});

describe('aggregate — what counts as a value', () => {
  it('is blank when nothing numeric is there, rather than claiming a total of 0', () => {
    const r = rows({ size: 'large' }, { size: 'small' });
    expect(aggregate('SUM', r, 'size')).toBe('');
    expect(aggregate('AVG', r, 'size')).toBe('');
  });

  it('still answers 0 for a count over an empty set — zero is a true count', () => {
    expect(aggregate('COUNT', [], 'anything')).toBe('0');
    expect(aggregate('DISTINCT', [], 'anything')).toBe('0');
  });

  it('reads numeric strings as numbers, and skips the rest', () => {
    expect(aggregate('SUM', rows({ n: '10' }, { n: '5' }, { n: 'n/a' }), 'n')).toBe('15');
  });

  it('compares MIN/MAX as text when the column is not all numbers', () => {
    const r = rows({ v: 'beta' }, { v: 'alpha' }, { v: 'gamma' });
    expect(aggregate('MIN', r, 'v')).toBe('alpha');
    expect(aggregate('MAX', r, 'v')).toBe('gamma');
  });

  it('formats a long average for a human rather than to full precision', () => {
    expect(aggregate('AVG', rows({ n: 1 }, { n: 1 }, { n: 2 }), 'n')).toBe((4 / 3).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  });
});

describe('distinctValues', () => {
  it('drops blanks and sorts, so a pill row does not reorder when the grid does', () => {
    const r = rows({ c: 'DE' }, { c: '' }, { c: 'CH' }, { c: null }, { c: 'DE' });
    expect(distinctValues(r, 'c')).toEqual(['CH', 'DE']);
  });

  it('takes a list cell apart per member', () => {
    // A pill for the whole cell would filter on `=red,blue` and match nothing.
    const r = rows({ tags: ['red', 'blue'] }, { tags: ['red'] });
    expect(distinctValues(r, 'tags', { field: 'tags', label: 'Tags', type: 'array' } as ColumnSpec)).toEqual(['blue', 'red']);
  });
});

describe('$filter.FIELD pills', () => {
  it('emits one pill per distinct value, carrying the field and the value', () => {
    const out = substituteVizTokens('$filter.country', SALES, cols({ field: 'country' }));
    expect(out.match(/eda-filter-pill/g)).toHaveLength(2);
    expect(out).toContain('data-eda-filter-field="country"');
    expect(out).toContain('data-eda-filter-value="CH"');
  });

  it('caps the row and says how many it left out', () => {
    const many = rows(...Array.from({ length: MAX_PILLS + 7 }, (_, i) => ({ c: `v${String(i).padStart(3, '0')}` })));
    const out = substituteVizTokens('$filter.c', many);
    expect(out.match(/eda-filter-pill/g)).toHaveLength(MAX_PILLS);
    expect(out).toContain('+7');
  });

  it('escapes a value so a cell cannot break out of the button', () => {
    const out = substituteVizTokens('$filter.c', rows({ c: '<img src=x onerror=alert(1)>' }));
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('vizFilterFields', () => {
  it('names the fields a template offers a pill for, once each, in order', () => {
    expect(vizFilterFields('<div>$filter.country $COUNT $filter.city $filter.country</div>')).toEqual(['country', 'city']);
  });

  it('is empty for a template with no pills', () => {
    expect(vizFilterFields('<b>$COUNT</b>')).toEqual([]);
  });
});
