import { describe, expect, it } from 'vitest';
import { blankRecord, coerceInput, defaultFor, hasMoreFields, inputValue, isDerived, recordFields } from '../../../packages/renderer/src/table/new-record.js';
import type { ColumnSpec } from '../../../packages/shared/src/types.js';

/**
 * What the new-record form asks for, and what it starts with.
 *
 * The two rules that matter: a derived column can never be filled in (there is
 * nowhere to write it), and a hidden one is only asked for when the user says
 * "show all fields" — while still getting its default written either way.
 */

const col = (field: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ field, label: field, type: 'string', ...extra });

describe('defaultFor', () => {
  it('prefers the column default over the type default', () => {
    expect(defaultFor(col('a', { default: 'x' }))).toBe('x');
    expect(defaultFor(col('a', { type: 'number', default: 7 }))).toBe(7);
    // Even a falsy default is the user's answer, not an absent one.
    expect(defaultFor(col('a', { type: 'boolean', default: true }))).toBe(true);
    expect(defaultFor(col('a', { type: 'number', default: 0 }))).toBe(0);
  });

  it('starts a number at null, not zero', () => {
    // A blank number field means "nobody said". 0 is an answer.
    expect(defaultFor(col('a', { type: 'number' }))).toBeNull();
  });

  it('starts a boolean false and everything else empty', () => {
    expect(defaultFor(col('a', { type: 'boolean' }))).toBe(false);
    expect(defaultFor(col('a', { type: 'string' }))).toBe('');
    expect(defaultFor(col('a', { type: 'date' }))).toBe('');
  });
});

describe('blankRecord', () => {
  it('carries every column, hidden and derived ones included', () => {
    // The row has to have the same shape whichever path made it, or the same
    // table gains different rows depending on which button was pressed.
    const columns = [col('a'), col('b', { hidden: true }), col('c', { script: 'function render(row){return 1}' })];
    expect(Object.keys(blankRecord(columns))).toEqual(['a', 'b', 'c']);
  });

  it('is empty for a table with no columns', () => {
    expect(blankRecord([])).toEqual({});
  });
});

describe('isDerived', () => {
  it('is true only for a column with a real script', () => {
    expect(isDerived(col('a'))).toBe(false);
    expect(isDerived(col('a', { script: '   ' }))).toBe(false);
    expect(isDerived(col('a', { script: 'function render(row){return 1}' }))).toBe(true);
  });
});

describe('recordFields', () => {
  const columns = [col('name'), col('secret', { hidden: true }), col('total', { script: 'function render(row){return 1}' }), col('note')];

  it('asks for the visible, writable fields in column order', () => {
    expect(recordFields(columns, false).map((c) => c.field)).toEqual(['name', 'note']);
  });

  it('reveals hidden fields when asked, still leaving derived ones out', () => {
    // A scripted column has nowhere to put an answer, so "all fields" does not
    // mean it either.
    expect(recordFields(columns, true).map((c) => c.field)).toEqual(['name', 'secret', 'note']);
  });

  it('is empty for a table whose every column is derived', () => {
    expect(recordFields([col('a', { script: 'function render(row){return 1}' })], true)).toEqual([]);
  });
});

describe('hasMoreFields', () => {
  it('is true only when the toggle would actually reveal something', () => {
    expect(hasMoreFields([col('a'), col('b', { hidden: true })])).toBe(true);
    expect(hasMoreFields([col('a'), col('b')])).toBe(false);
    // A hidden DERIVED column is not revealable, so it is not "more fields".
    expect(hasMoreFields([col('a'), col('b', { hidden: true, script: 'function render(row){return 1}' })])).toBe(false);
  });
});

describe('coerceInput', () => {
  it('reads an empty box as no value, not as zero or blank', () => {
    expect(coerceInput('number', '')).toBeNull();
    expect(coerceInput('number', '   ')).toBeNull();
    expect(coerceInput('date', '')).toBeNull();
    expect(coerceInput('datetime', '')).toBeNull();
    // Text is the exception: an empty text cell IS the empty string.
    expect(coerceInput('string', '')).toBe('');
  });

  it('parses a number, and keeps what the user typed when it will not parse', () => {
    expect(coerceInput('number', '42')).toBe(42);
    expect(coerceInput('number', ' -3.5 ')).toBe(-3.5);
    // Dropping it would lose their work mid-form. Validation says it is wrong.
    expect(coerceInput('number', '12abc')).toBe('12abc');
  });

  it('reads a checkbox value as a real boolean', () => {
    expect(coerceInput('boolean', 'true')).toBe(true);
    expect(coerceInput('boolean', 'false')).toBe(false);
    expect(coerceInput('boolean', '')).toBe(false);
  });

  it('splits an array on commas and trims the parts', () => {
    expect(coerceInput('array', 'a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(coerceInput('array', '')).toEqual([]);
  });

  it('leaves a date string alone — the input already gives ISO', () => {
    expect(coerceInput('date', '2026-08-26')).toBe('2026-08-26');
    expect(coerceInput('datetime', '2026-08-26T09:30')).toBe('2026-08-26T09:30');
  });
});

describe('inputValue', () => {
  it('shows nothing for nothing', () => {
    expect(inputValue(null)).toBe('');
    expect(inputValue(undefined)).toBe('');
  });

  it('joins an array the way coerceInput reads one back', () => {
    // Round trip: what the box shows has to parse back to the same list.
    expect(coerceInput('array', inputValue(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('shows a number and a boolean as text', () => {
    expect(inputValue(0)).toBe('0');
    expect(inputValue(false)).toBe('false');
  });
});
