import { describe, it, expect } from 'vitest';
import { booleanState } from './cell-validity.js';

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
