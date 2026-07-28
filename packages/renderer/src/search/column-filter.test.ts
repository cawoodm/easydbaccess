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

  it('^ anchors the match to the start of the cell', () => {
    expect(matchesColumnFilter('Sweden', '^S')).toBe(true);
    expect(matchesColumnFilter('Sweden', '^s')).toBe(true); // case-insensitive
    expect(matchesColumnFilter('Denmark', '^S')).toBe(false);
    // "S" is IN "Austria"? no — but the point is the anchor rejects mid-string.
    expect(matchesColumnFilter('Austria', '^t')).toBe(false);
    expect(matchesColumnFilter('Austria', 't')).toBe(true);
    expect(matchesColumnFilter(null, '^S')).toBe(false);
  });

  it('!^ excludes the rows that start with the term', () => {
    expect(matchesColumnFilter('Sweden', '!^S')).toBe(false);
    expect(matchesColumnFilter('Denmark', '!^S')).toBe(true);
    // A blank cell does not start with "S", so it survives the exclusion.
    expect(matchesColumnFilter(null, '!^S')).toBe(true);
  });

  it('^ combines with other tokens', () => {
    expect(matchesColumnFilter('Sweden', '^S,Norway')).toBe(true);
    expect(matchesColumnFilter('Norway', '^S,Norway')).toBe(true);
    expect(matchesColumnFilter('Denmark', '^S,Norway')).toBe(false);
    expect(matchesColumnFilter('Spain', '^S,!Spain')).toBe(false);
  });

  it('^NULL looks for the literal text, not for blanks', () => {
    expect(matchesColumnFilter(null, '^NULL')).toBe(false);
    expect(matchesColumnFilter('null pointer', '^NULL')).toBe(true);
    expect(matchesColumnFilter(null, 'NULL')).toBe(true);
  });

  it('a quoted term keeps a leading ^ or ! as literal text', () => {
    expect(matchesColumnFilter('^caret', '"^caret"')).toBe(true);
    expect(matchesColumnFilter('caret', '"^caret"')).toBe(false);
    expect(matchesColumnFilter('!bang', '"!bang"')).toBe(true);
  });

  it('a mid-token ^ or ! is ordinary text', () => {
    expect(matchesColumnFilter('a^b', 'a^b')).toBe(true);
    expect(matchesColumnFilter('a!b', 'a!b')).toBe(true);
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

  it('parses the ^ starts-with modifier, alone and after !', () => {
    expect(parseColumnFilter('^S')).toEqual([{ term: 'S', negate: false, prefix: true }]);
    expect(parseColumnFilter('!^S')).toEqual([{ term: 'S', negate: true, prefix: true }]);
    // A second ^ is literal text, not a repeated modifier.
    expect(parseColumnFilter('^^S')).toEqual([{ term: '^S', negate: false, prefix: true }]);
    // Quoting turns it back into an ordinary character.
    expect(parseColumnFilter('"^S"')).toEqual([{ term: '^S', negate: false }]);
  });

  it('round-trips through compose', () => {
    for (const raw of [
      'Sweden,!Norway',
      '"Berlin, DE",Zurich',
      'NULL,Sweden',
      '!',
      '"a""b"',
      '" padded "',
      '^S',
      '!^S',
      '^S,Norway',
      '"^caret"',
      '"!bang"',
    ]) {
      expect(composeColumnFilter(parseColumnFilter(raw))).toBe(raw);
    }
  });
});
