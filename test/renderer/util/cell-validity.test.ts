import { describe, it, expect } from 'vitest';
import { booleanState, cellState } from '../../../packages/renderer/src/util/cell-validity.js';

describe('booleanState', () => {
  it('recognizes true values', () => {
    expect(booleanState(true)).toBe('true');
    expect(booleanState(1)).toBe('true');
    expect(booleanState('1')).toBe('true');
    expect(booleanState('true')).toBe('true');
    expect(booleanState('TRUE')).toBe('true');
    expect(booleanState('  true  ')).toBe('true');
    expect(booleanState('  1  ')).toBe('true');
  });

  it('recognizes false values', () => {
    expect(booleanState(false)).toBe('false');
    expect(booleanState(0)).toBe('false');
    expect(booleanState('0')).toBe('false');
    expect(booleanState('false')).toBe('false');
    expect(booleanState('False')).toBe('false');
    expect(booleanState('  false  ')).toBe('false');
    expect(booleanState('  0  ')).toBe('false');
  });

  it('recognizes empty values', () => {
    expect(booleanState(null)).toBe('empty');
    expect(booleanState(undefined)).toBe('empty');
    expect(booleanState('')).toBe('empty');
    expect(booleanState('   ')).toBe('empty');
  });

  it('flags everything else as invalid', () => {
    expect(booleanState('foo')).toBe('invalid');
    expect(booleanState(2)).toBe('invalid');
    expect(booleanState(-1)).toBe('invalid');
    expect(booleanState(NaN)).toBe('invalid');
    expect(booleanState({})).toBe('invalid');
    expect(booleanState([])).toBe('invalid');
  });
});

describe('cellState', () => {
  it('treats null, undefined and blank strings as empty for every type', () => {
    for (const type of ['string', 'number', 'date', 'datetime', 'boolean']) {
      expect(cellState(null, type)).toBe('empty');
      expect(cellState(undefined, type)).toBe('empty');
      expect(cellState('   ', type)).toBe('empty');
    }
  });

  it('accepts anything non-empty in a string column', () => {
    expect(cellState('foo', 'string')).toBe('ok');
    expect(cellState('12abc', 'string')).toBe('ok');
    expect(cellState(0, 'string')).toBe('ok');
  });

  it('flags a number column value that is not a finite number', () => {
    expect(cellState(12, 'number')).toBe('ok');
    expect(cellState('12', 'number')).toBe('ok');
    expect(cellState('12abc', 'number')).toBe('invalid');
    expect(cellState(Infinity, 'number')).toBe('invalid');
  });

  it('flags an unparseable date or datetime', () => {
    expect(cellState('2024-01-01', 'date')).toBe('ok');
    expect(cellState('2024-01-01T10:00', 'datetime')).toBe('ok');
    expect(cellState('not-a-date', 'date')).toBe('invalid');
  });

  it('follows booleanState for boolean columns', () => {
    expect(cellState(true, 'boolean')).toBe('ok');
    expect(cellState('FALSE', 'boolean')).toBe('ok');
    expect(cellState('maybe', 'boolean')).toBe('invalid');
  });

  it('calls an array cell with no members empty, and never invalid', () => {
    expect(cellState('foo,bar', 'array')).toBe('ok');
    expect(cellState(['foo'], 'array')).toBe('ok');
    // `[]` prints as "[]" — non-empty as text, but no values in it.
    expect(cellState('[]', 'array')).toBe('empty');
    expect(cellState([], 'array')).toBe('empty');
    expect(cellState('', 'array')).toBe('empty');
    // Text that does not parse as JSON is read as a comma list, not as broken.
    expect(cellState('[a, b]', 'array')).toBe('ok');
  });

  it('marks 0 and false as present, not empty — they are real values', () => {
    expect(cellState(0, 'number')).toBe('ok');
    expect(cellState(false, 'boolean')).toBe('ok');
  });
});
