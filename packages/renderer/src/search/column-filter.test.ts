import { describe, expect, it } from 'vitest';
import { matchesColumnFilter } from './column-filter.js';

describe('matchesColumnFilter', () => {
  it('empty query matches everything', () => {
    expect(matchesColumnFilter('anything', '')).toBe(true);
    expect(matchesColumnFilter(null, '   ')).toBe(true);
  });

  it('plain text is a case-insensitive substring match', () => {
    expect(matchesColumnFilter('Sweden', 'swe')).toBe(true);
    expect(matchesColumnFilter('Sweden', 'xyz')).toBe(false);
    expect(matchesColumnFilter(null, 'swe')).toBe(false);
  });

  it('! negates the substring match', () => {
    expect(matchesColumnFilter('Sweden', '!swe')).toBe(false);
    expect(matchesColumnFilter('Norway', '!swe')).toBe(true);
  });

  it('!true surfaces false and empty/null boolean cells', () => {
    expect(matchesColumnFilter(true, '!true')).toBe(false);
    expect(matchesColumnFilter(false, '!true')).toBe(true);
    expect(matchesColumnFilter(null, '!true')).toBe(true);
    expect(matchesColumnFilter('', '!true')).toBe(true);
  });

  it('NULL matches null/undefined/blank cells only', () => {
    expect(matchesColumnFilter(null, 'NULL')).toBe(true);
    expect(matchesColumnFilter(undefined, 'null')).toBe(true);
    expect(matchesColumnFilter('   ', 'NULL')).toBe(true);
    expect(matchesColumnFilter('value', 'NULL')).toBe(false);
    expect(matchesColumnFilter(false, 'NULL')).toBe(false);
    expect(matchesColumnFilter(0, 'NULL')).toBe(false);
  });

  it('!NULL and lone ! match cells with any value', () => {
    expect(matchesColumnFilter('value', '!NULL')).toBe(true);
    expect(matchesColumnFilter(null, '!NULL')).toBe(false);
    expect(matchesColumnFilter('value', '!')).toBe(true);
    expect(matchesColumnFilter('', '!')).toBe(false);
  });
});
