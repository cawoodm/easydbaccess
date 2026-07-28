import { describe, expect, it } from 'vitest';
import { composeColumnFilter, matchesColumnFilter, parseColumnFilter } from './column-filter.js';

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

  it('several included values are ORed', () => {
    expect(matchesColumnFilter('Sweden', 'Sweden,Norway')).toBe(true);
    expect(matchesColumnFilter('Norway', 'Sweden,Norway')).toBe(true);
    expect(matchesColumnFilter('Denmark', 'Sweden,Norway')).toBe(false);
    expect(matchesColumnFilter(null, 'Sweden,Norway')).toBe(false);
  });

  it('several negated values exclude all of them', () => {
    expect(matchesColumnFilter('Closed', '!Closed,!Cancelled')).toBe(false);
    expect(matchesColumnFilter('Cancelled', '!Closed,!Cancelled')).toBe(false);
    expect(matchesColumnFilter('Open', '!Closed,!Cancelled')).toBe(true);
    // No positive term ⇒ everything that isn't excluded passes, blanks included.
    expect(matchesColumnFilter(null, '!Closed,!Cancelled')).toBe(true);
  });

  it('mixes included and negated terms', () => {
    // In the Open set, but not the urgent ones.
    expect(matchesColumnFilter('Open', 'Open,!urgent')).toBe(true);
    expect(matchesColumnFilter('Open urgent', 'Open,!urgent')).toBe(false);
    expect(matchesColumnFilter('Closed', 'Open,!urgent')).toBe(false);
  });

  it('NULL combines with a value', () => {
    expect(matchesColumnFilter(null, 'NULL,Sweden')).toBe(true);
    expect(matchesColumnFilter('Sweden', 'NULL,Sweden')).toBe(true);
    expect(matchesColumnFilter('Norway', 'NULL,Sweden')).toBe(false);
  });

  it('a quoted value keeps its comma', () => {
    expect(matchesColumnFilter('Berlin, DE', '"Berlin, DE",Zurich')).toBe(true);
    expect(matchesColumnFilter('Zurich', '"Berlin, DE",Zurich')).toBe(true);
    expect(matchesColumnFilter('Berlin', '"Berlin, DE",Zurich')).toBe(false);
  });

  it('ignores empty tokens', () => {
    expect(matchesColumnFilter('Sweden', 'Sweden,,')).toBe(true);
    expect(matchesColumnFilter('Norway', ' , ')).toBe(true);
  });
});

describe('parseColumnFilter / composeColumnFilter', () => {
  it('parses tokens, negation and quoting', () => {
    expect(parseColumnFilter('Sweden, !Norway')).toEqual([
      { term: 'Sweden', negate: false },
      { term: 'Norway', negate: true },
    ]);
    expect(parseColumnFilter('"Berlin, DE"')).toEqual([{ term: 'Berlin, DE', negate: false }]);
    expect(parseColumnFilter('!"a,b"')).toEqual([{ term: 'a,b', negate: true }]);
    // A doubled quote is a literal only INSIDE a quoted run.
    expect(parseColumnFilter('"a""b"')).toEqual([{ term: 'a"b', negate: false }]);
    expect(parseColumnFilter('')).toEqual([]);
    expect(parseColumnFilter('!')).toEqual([{ term: '', negate: true }]);
  });

  it('round-trips through compose', () => {
    for (const raw of [
      'Sweden,!Norway',
      '"Berlin, DE",Zurich',
      'NULL,Sweden',
      '!',
      '"a""b"',
      '" padded "',
    ]) {
      expect(composeColumnFilter(parseColumnFilter(raw))).toBe(raw);
    }
  });
});
