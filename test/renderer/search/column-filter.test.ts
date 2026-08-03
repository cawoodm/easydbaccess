import { describe, expect, it } from 'vitest';
import { composeColumnFilter, matchesColumnFilter, parseColumnFilter } from '../../../packages/renderer/src/search/column-filter.js';

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
      '=foo',
      '!=foo',
      '=foo,=bar',
      '"=x"',
      '!NULL AND Biden',
      '^B AND !Bush',
      'a AND b,c',
      'a AND b AND c',
      '"Salt AND Pepper"',
    ]) {
      expect(composeColumnFilter(parseColumnFilter(raw))).toBe(raw);
    }
  });
});

describe('AND groups', () => {
  // A comma ORs, so two substring conditions on one column had no spelling at
  // all before this: `!NULL AND Biden` parsed as ONE negated token whose term
  // was the text "NULL AND Biden", which matched nothing and excluded nothing —
  // the filter silently passed every row.
  it('requires both sides of an AND', () => {
    expect(matchesColumnFilter('Biden wins', '!NULL AND Biden')).toBe(true);
    expect(matchesColumnFilter('Trump wins', '!NULL AND Biden')).toBe(false);
    expect(matchesColumnFilter('', '!NULL AND Biden')).toBe(false);
    expect(matchesColumnFilter(null, '!NULL AND Biden')).toBe(false);
  });

  it('negates inside a group instead of vetoing the whole filter', () => {
    expect(matchesColumnFilter('Biden', '^B AND !Bush')).toBe(true);
    expect(matchesColumnFilter('Bush', '^B AND !Bush')).toBe(false);
    expect(matchesColumnFilter('Obama', '^B AND !Bush')).toBe(false);
  });

  it('binds AND tighter than a comma', () => {
    // (a AND b) OR c
    expect(matchesColumnFilter('a b', 'a AND b,c')).toBe(true);
    expect(matchesColumnFilter('a', 'a AND b,c')).toBe(false);
    expect(matchesColumnFilter('c', 'a AND b,c')).toBe(true);
  });

  it('chains three terms', () => {
    expect(matchesColumnFilter('a b c', 'a AND b AND c')).toBe(true);
    expect(matchesColumnFilter('a b', 'a AND b AND c')).toBe(false);
  });

  it('reads OR as a spelled-out comma', () => {
    expect(matchesColumnFilter('Sweden', 'Sweden OR Norway')).toBe(true);
    expect(matchesColumnFilter('Norway', 'Sweden OR Norway')).toBe(true);
    expect(matchesColumnFilter('Denmark', 'Sweden OR Norway')).toBe(false);
  });

  it('takes only an uppercase operator standing alone', () => {
    // Lowercase is a word, and so is an operator glued into one.
    expect(matchesColumnFilter('a and b', 'a and b')).toBe(true);
    expect(matchesColumnFilter('brand new', 'brand')).toBe(true);
    expect(matchesColumnFilter('Andrew', 'Andrew')).toBe(true);
    // A quoted operator is text again.
    expect(matchesColumnFilter('Salt AND Pepper', '"Salt AND Pepper"')).toBe(true);
    expect(matchesColumnFilter('Salt', '"Salt AND Pepper"')).toBe(false);
  });

  it('flags the joined token, and only the joined one', () => {
    expect(parseColumnFilter('!NULL AND Biden')).toEqual([
      { term: 'NULL', negate: true },
      { term: 'Biden', negate: false, and: true },
    ]);
    expect(parseColumnFilter('a OR b')).toEqual([
      { term: 'a', negate: false },
      { term: 'b', negate: false },
    ]);
  });

  it('survives an operator with nothing to join', () => {
    // Garbage in, no crash and no dangling operator out.
    expect(parseColumnFilter('AND b')).toEqual([{ term: 'AND b', negate: false }]);
    expect(composeColumnFilter(parseColumnFilter('a AND'))).toBe('a');
    expect(matchesColumnFilter('a', 'a AND')).toBe(true);
  });

  it('does not change what a comma-separated negative means', () => {
    // The regression this design had to avoid: `Open,!urgent` is "Open but not
    // urgent", NOT "Open OR not-urgent".
    expect(matchesColumnFilter('Open urgent', 'Open,!urgent')).toBe(false);
    expect(matchesColumnFilter('Open', 'Open,!urgent')).toBe(true);
    expect(matchesColumnFilter('Spain', '^S,!Spain')).toBe(false);
  });
});

describe('exact match (=)', () => {
  it('= matches the WHOLE cell, case-insensitively, not a substring', () => {
    expect(matchesColumnFilter('foo', '=foo')).toBe(true);
    expect(matchesColumnFilter('Foo', '=foo')).toBe(true);
    expect(matchesColumnFilter('foobar', '=foo')).toBe(false);
    expect(matchesColumnFilter('my foo', '=foo')).toBe(false);
  });

  it('!= inverts the exact match', () => {
    expect(matchesColumnFilter('foo', '!=foo')).toBe(false);
    expect(matchesColumnFilter('foobar', '!=foo')).toBe(true);
    expect(matchesColumnFilter(null, '!=foo')).toBe(true);
  });

  it('=foo,=bar is an OR of two exact values', () => {
    expect(matchesColumnFilter('foo', '=foo,=bar')).toBe(true);
    expect(matchesColumnFilter('bar', '=foo,=bar')).toBe(true);
    expect(matchesColumnFilter('baz', '=foo,=bar')).toBe(false);
  });

  it('parses = as an exact-match modifier, alone and after !', () => {
    expect(parseColumnFilter('=foo')).toEqual([{ term: 'foo', negate: false, exact: true }]);
    expect(parseColumnFilter('!=foo')).toEqual([{ term: 'foo', negate: true, exact: true }]);
  });

  it('= and ^ are mutually exclusive — the first wins, the second is literal text', () => {
    expect(parseColumnFilter('^=foo')).toEqual([{ term: '=foo', negate: false, prefix: true }]);
    expect(parseColumnFilter('=^foo')).toEqual([{ term: '^foo', negate: false, exact: true }]);
  });

  it('a quoted leading = survives as literal text (not the exact-match modifier)', () => {
    expect(parseColumnFilter('"=x"')).toEqual([{ term: '=x', negate: false }]);
    expect(matchesColumnFilter('=x', '"=x"')).toBe(true);
    expect(matchesColumnFilter('x', '"=x"')).toBe(false);
  });

  it('=NULL matches the literal text "null", not an empty cell', () => {
    expect(matchesColumnFilter('null', '=NULL')).toBe(true);
    expect(matchesColumnFilter(null, '=NULL')).toBe(false);
    expect(matchesColumnFilter('', '=NULL')).toBe(false);
    expect(matchesColumnFilter('null pointer', '=NULL')).toBe(false); // not a substring match
  });

  it('composes = in the right position, after !', () => {
    expect(composeColumnFilter([{ term: 'foo', negate: false, exact: true }])).toBe('=foo');
    expect(composeColumnFilter([{ term: 'foo', negate: true, exact: true }])).toBe('!=foo');
  });
});
