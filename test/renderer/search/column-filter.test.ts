import { describe, expect, it } from 'vitest';
import { composeColumnFilter, isListExpression, matchesColumnFilter, parseColumnFilter, plainTextOf } from '../../../packages/shared/src/column-filter.js';

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
    // A quoted entry of a list is an EXACT value, so these carry `exact`. The
    // quotes still protect the comma; they now also say which match is wanted.
    expect(parseColumnFilter('"Berlin, DE"')).toEqual([{ term: 'Berlin, DE', negate: false, exact: true }]);
    expect(parseColumnFilter('!"a,b"')).toEqual([{ term: 'a,b', negate: true, exact: true }]);
    // A doubled quote is a literal only INSIDE a quoted run.
    expect(parseColumnFilter('"a""b"')).toEqual([{ term: 'a"b', negate: false, exact: true }]);
    expect(parseColumnFilter('')).toEqual([]);
    expect(parseColumnFilter('!')).toEqual([{ term: '', negate: true }]);
  });

  it('parses the ^ starts-with modifier, alone and after !', () => {
    expect(parseColumnFilter('^S')).toEqual([{ term: 'S', negate: false, prefix: true }]);
    expect(parseColumnFilter('!^S')).toEqual([{ term: 'S', negate: true, prefix: true }]);
    // A second ^ is literal text, not a repeated modifier.
    expect(parseColumnFilter('^^S')).toEqual([{ term: '^S', negate: false, prefix: true }]);
    // Quoting turns it back into an ordinary character — and, being a quoted
    // list entry, asks for an exact match on it.
    expect(parseColumnFilter('"^S"')).toEqual([{ term: '^S', negate: false, exact: true }]);
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
    // The `=` is text; the quotes are what ask for an exact match on it.
    expect(parseColumnFilter('"=x"')).toEqual([{ term: '=x', negate: false, exact: true }]);
    expect(matchesColumnFilter('=x', '"=x"')).toBe(true);
    expect(matchesColumnFilter('x', '"=x"')).toBe(false);
    // Exact, so a cell merely CONTAINING the text no longer matches.
    expect(matchesColumnFilter('a=xb', '"=x"')).toBe(false);
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

/**
 * An `array` column matches PER MEMBER. The funnel dropdown is why: its tokens
 * are exact (`=Foo`), and a cell holding several values is never exactly one of
 * them — so without this, picking a value from the dropdown of a list column
 * selected nothing at all.
 */
describe('matchesColumnFilter on an array column', () => {
  const arr = { type: 'array' };

  it('matches a member exactly, in every spelling of a list', () => {
    expect(matchesColumnFilter('foo,bar', '=foo', arr)).toBe(true);
    expect(matchesColumnFilter('["Foo","Bar"]', '=foo', arr)).toBe(true);
    expect(matchesColumnFilter(['foo', 'bar'], '=foo', arr)).toBe(true);
  });

  it('does not match a value that is only PART of a member', () => {
    expect(matchesColumnFilter('foobar,baz', '=foo', arr)).toBe(false);
  });

  it('still substring-matches without an anchor', () => {
    expect(matchesColumnFilter('foo,bar', 'oo', arr)).toBe(true);
    expect(matchesColumnFilter('foo,bar', 'zzz', arr)).toBe(false);
  });

  it('anchors ^ to the start of a MEMBER, not of the cell', () => {
    // The whole cell starts with "foo", so a cell-wide ^bar would fail.
    expect(matchesColumnFilter('foo,bar', '^bar', arr)).toBe(true);
    expect(matchesColumnFilter('foo,bar', '^ba', arr)).toBe(true);
    expect(matchesColumnFilter('foo,bar', '^zz', arr)).toBe(false);
  });

  it('reads a negation as "no member matches"', () => {
    expect(matchesColumnFilter('foo,bar', '!=foo', arr)).toBe(false);
    expect(matchesColumnFilter('foo,bar', '!=baz', arr)).toBe(true);
  });

  it('ORs several members, so two picked values keep either row', () => {
    expect(matchesColumnFilter('foo,bar', '=foo,=baz', arr)).toBe(true);
    expect(matchesColumnFilter('qux', '=foo,=baz', arr)).toBe(false);
  });

  it('ANDs two tokens against the SAME cell, over different members', () => {
    // The point of AND on a list: both values must be present, in any order.
    expect(matchesColumnFilter('foo,bar', '=foo AND =bar', arr)).toBe(true);
    expect(matchesColumnFilter('foo,baz', '=foo AND =bar', arr)).toBe(false);
  });

  it('reads NULL as "no members at all"', () => {
    expect(matchesColumnFilter('[]', 'NULL', arr)).toBe(true);
    expect(matchesColumnFilter([], 'NULL', arr)).toBe(true);
    expect(matchesColumnFilter('', 'NULL', arr)).toBe(true);
    expect(matchesColumnFilter(null, 'NULL', arr)).toBe(true);
    expect(matchesColumnFilter('foo,bar', 'NULL', arr)).toBe(false);
    expect(matchesColumnFilter('foo,bar', '!NULL', arr)).toBe(true);
  });

  it('leaves a column of any other type reading the whole cell', () => {
    expect(matchesColumnFilter('foo,bar', '=foo')).toBe(false);
    expect(matchesColumnFilter('foo,bar', '=foo,bar')).toBe(true);
  });
});

describe('wildcards', () => {
  it('reads the three star forms', () => {
    expect(parseColumnFilter('*foo*')).toEqual([{ term: 'foo', negate: false, contains: true }]);
    expect(parseColumnFilter('foo*')).toEqual([{ term: 'foo', negate: false, prefix: true }]);
    expect(parseColumnFilter('*foo')).toEqual([{ term: 'foo', negate: false, suffix: true }]);
  });

  it('matches contains, starts-with and the ends-with that had no spelling before', () => {
    expect(matchesColumnFilter('Holiday', '*lida*')).toBe(true);
    expect(matchesColumnFilter('Holiday', 'Hol*')).toBe(true);
    expect(matchesColumnFilter('Holiday', '*day')).toBe(true);
    expect(matchesColumnFilter('Holiday', '*Hol')).toBe(false);
    expect(matchesColumnFilter('Holiday', 'day*')).toBe(false);
  });

  it('negates a wildcard', () => {
    expect(matchesColumnFilter('Holiday', '!*lida*')).toBe(false);
    expect(matchesColumnFilter('Flat', '!*lida*')).toBe(true);
  });

  it('is a literal inside quotes, which is how a value holding one is matched', () => {
    expect(parseColumnFilter('"a*b"')).toEqual([{ term: 'a*b', negate: false, exact: true }]);
    expect(matchesColumnFilter('a*b', '"a*b"')).toBe(true);
  });

  it('leaves a token of nothing but stars as literal text', () => {
    // Otherwise the term would be empty, which already means "is this cell blank".
    expect(matchesColumnFilter('*', '*')).toBe(true);
    expect(matchesColumnFilter('x', '*')).toBe(false);
  });

  it('beats the NULL test, like the other anchors', () => {
    expect(matchesColumnFilter('null', '*NULL*')).toBe(true);
    expect(matchesColumnFilter(null, '*NULL*')).toBe(false);
  });

  it('round-trips through compose', () => {
    for (const raw of ['*foo*', '^foo', '*foo', '!*foo*', '!*foo', '*a b*']) {
      expect(composeColumnFilter(parseColumnFilter(raw))).toBe(raw);
    }
  });
});

describe('defaultSubstring', () => {
  it('a bare value is a substring by default', () => {
    expect(matchesColumnFilter('Holiday', 'lida')).toBe(true);
    expect(matchesColumnFilter('Holiday', 'Holiday')).toBe(true);
  });

  it('a bare value is the whole cell when the setting is off', () => {
    const exact = { defaultSubstring: false };
    expect(matchesColumnFilter('Holiday', 'lida', exact)).toBe(false);
    expect(matchesColumnFilter('Holiday', 'Holiday', exact)).toBe(true);
    expect(matchesColumnFilter('Holiday', 'CC,Holiday', exact)).toBe(true);
    expect(matchesColumnFilter('Holiday Inn', 'CC,Holiday', exact)).toBe(false);
  });

  it('an explicit form ignores the setting, both ways', () => {
    for (const opts of [{ defaultSubstring: true }, { defaultSubstring: false }]) {
      expect(matchesColumnFilter('Holiday', '*lida*', opts)).toBe(true);
      expect(matchesColumnFilter('Holiday', '"Holiday"', opts)).toBe(true);
      expect(matchesColumnFilter('Holiday Inn', '"Holiday"', opts)).toBe(false);
    }
  });

  it('does not change what a negation means, only how it matches', () => {
    expect(matchesColumnFilter('Holiday', '!CC,Holiday', { defaultSubstring: false })).toBe(true);
    expect(matchesColumnFilter('CC', '!CC,Holiday', { defaultSubstring: false })).toBe(false);
  });
});

describe('isListExpression', () => {
  it('is false for ordinary text, so a phrase needs no syntax', () => {
    expect(isListExpression('Berlin')).toBe(false);
    expect(isListExpression('Holiday Inn')).toBe(false);
    expect(isListExpression('')).toBe(false);
  });

  it('is true for anything carrying a mark of the language', () => {
    for (const q of ['a,b', '!a', '^a', '=a', '*a*', 'a AND b', 'a OR b']) {
      expect(isListExpression(q), q).toBe(true);
    }
  });

  it('is false when the whole input is quoted — the override', () => {
    expect(isListExpression('"Berlin, DE"')).toBe(false);
    expect(plainTextOf('"Berlin, DE"')).toBe('Berlin, DE');
  });

  it('is still a list when quotes are used INSIDE it', () => {
    expect(isListExpression('"Foo Bar","Baz"')).toBe(true);
    expect(plainTextOf('a,b')).toBe('a,b');
  });
});

describe('comparison tokens', () => {
  it('parses each operator off the front of the term', () => {
    expect(parseColumnFilter('>=100')).toEqual([{ term: '100', negate: false, cmp: '>=' }]);
    expect(parseColumnFilter('<=100')).toEqual([{ term: '100', negate: false, cmp: '<=' }]);
    expect(parseColumnFilter('>100')).toEqual([{ term: '100', negate: false, cmp: '>' }]);
    expect(parseColumnFilter('<100')).toEqual([{ term: '100', negate: false, cmp: '<' }]);
  });

  it('parses a negated comparison', () => {
    expect(parseColumnFilter('!>=100')).toEqual([{ term: '100', negate: true, cmp: '>=' }]);
  });

  it('round-trips through compose', () => {
    for (const q of ['>=100', '<=100', '>100', '<100', '!>=100', '>=a AND <=b', '>=2026-01-01,<=2020-01-01']) {
      expect(composeColumnFilter(parseColumnFilter(q))).toBe(q);
    }
  });

  it('a value that merely starts with > stays literal text', () => {
    // Quoted on the way in, and the quotes must come back — otherwise the
    // round trip turns the value into an operator.
    const tokens = parseColumnFilter('">=not an operator"');
    expect(tokens).toEqual([{ term: '>=not an operator', negate: false, exact: true }]);
    expect(composeColumnFilter(tokens)).toBe('">=not an operator"');
  });

  it('a comparison is an expression, not plain text', () => {
    expect(isListExpression('>=100')).toBe(true);
    expect(isListExpression('<2026-01-01')).toBe(true);
  });

  it('a star inside a comparison term is literal, not a wildcard', () => {
    expect(parseColumnFilter('>=a*')).toEqual([{ term: 'a*', negate: false, cmp: '>=' }]);
  });

  it('compares as text when no type is given', () => {
    expect(matchesColumnFilter('b', '>=b')).toBe(true);
    expect(matchesColumnFilter('c', '>=b')).toBe(true);
    expect(matchesColumnFilter('a', '>=b')).toBe(false);
    expect(matchesColumnFilter('b', '>b')).toBe(false);
    expect(matchesColumnFilter('a', '<=b')).toBe(true);
    expect(matchesColumnFilter('c', '<b')).toBe(false);
  });

  it('comparison is case-insensitive, like every other token', () => {
    expect(matchesColumnFilter('B', '>=b')).toBe(true);
    expect(matchesColumnFilter('b', '>=B')).toBe(true);
  });

  it('an empty cell never satisfies a comparison', () => {
    expect(matchesColumnFilter(null, '>=a')).toBe(false);
    expect(matchesColumnFilter('', '>=a')).toBe(false);
    expect(matchesColumnFilter('   ', '<=z')).toBe(false);
  });

  it('a negated comparison passes for an empty cell', () => {
    // Same rule as every other negated text test: a null cell fails the
    // positive test and therefore passes its negation.
    expect(matchesColumnFilter(null, '!>=a')).toBe(true);
    expect(matchesColumnFilter('z', '!>=a')).toBe(false);
  });

  it('NULL after a comparison is the literal text, not the blank test', () => {
    expect(matchesColumnFilter(null, '>=NULL')).toBe(false);
    expect(matchesColumnFilter('zzz', '>=NULL')).toBe(true);
  });

  it('two comparisons joined by AND make a closed range', () => {
    expect(matchesColumnFilter('m', '>=a AND <=z')).toBe(true);
    expect(matchesColumnFilter('m', '>=n AND <=z')).toBe(false);
  });
});

describe('type-aware comparison', () => {
  it('a number column compares numerically, not as text', () => {
    expect(matchesColumnFilter('10', '>=9', { type: 'number' })).toBe(true);
    expect(matchesColumnFilter('10', '>=9')).toBe(false); // text order, no type
    expect(matchesColumnFilter(9.5, '>9', { type: 'number' })).toBe(true);
    expect(matchesColumnFilter(-5, '<0', { type: 'number' })).toBe(true);
  });

  it('a number cell that is not a number never matches', () => {
    expect(matchesColumnFilter('n/a', '>=0', { type: 'number' })).toBe(false);
    expect(matchesColumnFilter('n/a', '<=999', { type: 'number' })).toBe(false);
  });

  it('a date column compares by calendar date', () => {
    expect(matchesColumnFilter('2026-06-23', '>=2026-06-23', { type: 'date' })).toBe(true);
    expect(matchesColumnFilter('2026-06-22', '>=2026-06-23', { type: 'date' })).toBe(false);
    expect(matchesColumnFilter('2026-12-01', '>=2026-06-23', { type: 'date' })).toBe(true);
  });

  it('a zoned value is compared on its UTC date', () => {
    // Matches what SQLite's date() returns, so the matcher and the pushdown
    // cannot drift. 23:30Z on the 17th is the 17th, not the 18th.
    expect(matchesColumnFilter('2026-06-17T23:30:00Z', '>=2026-06-17', { type: 'date' })).toBe(true);
    expect(matchesColumnFilter('2026-06-17T23:30:00Z', '>2026-06-17', { type: 'date' })).toBe(false);
    expect(matchesColumnFilter('2026-06-18T00:30:00+02:00', '<=2026-06-17', { type: 'date' })).toBe(true);
  });

  it('a naive datetime keeps its own wall clock', () => {
    expect(matchesColumnFilter('2026-06-17 23:30', '>=2026-06-17', { type: 'date' })).toBe(true);
    expect(matchesColumnFilter('2026-06-17 23:30', '<=2026-06-17', { type: 'date' })).toBe(true);
  });

  it('a date-only bound on a datetime column covers the whole day', () => {
    expect(matchesColumnFilter('2026-08-01T23:59:00', '<=2026-08-01', { type: 'datetime' })).toBe(true);
    expect(matchesColumnFilter('2026-08-01T00:00:00', '>=2026-08-01', { type: 'datetime' })).toBe(true);
    expect(matchesColumnFilter('2026-08-02T00:00:00', '<=2026-08-01', { type: 'datetime' })).toBe(false);
  });

  it('a bound carrying a time compares at full precision', () => {
    expect(matchesColumnFilter('2026-08-01T14:00:00', '>=2026-08-01T13:00', { type: 'datetime' })).toBe(true);
    expect(matchesColumnFilter('2026-08-01T12:00:00', '>=2026-08-01T13:00', { type: 'datetime' })).toBe(false);
  });

  it('an unparseable date never matches', () => {
    expect(matchesColumnFilter('not a date', '>=2026-01-01', { type: 'date' })).toBe(false);
    expect(matchesColumnFilter('not a date', '<=2026-01-01', { type: 'date' })).toBe(false);
  });

  it('a range on a date column selects the rows inside it', () => {
    const q = '>=2026-02-14 AND <=2026-08-01';
    expect(matchesColumnFilter('2026-02-14', q, { type: 'date' })).toBe(true);
    expect(matchesColumnFilter('2026-05-01', q, { type: 'date' })).toBe(true);
    expect(matchesColumnFilter('2026-08-01', q, { type: 'date' })).toBe(true);
    expect(matchesColumnFilter('2026-02-13', q, { type: 'date' })).toBe(false);
    expect(matchesColumnFilter('2026-08-02', q, { type: 'date' })).toBe(false);
  });
});

describe('relative date terms', () => {
  const now = new Date(2026, 8, 23); // 23 Sep 2026

  it('>=-3m selects the last three months', () => {
    expect(matchesColumnFilter('2026-07-01', '>=-3m', { type: 'date', now })).toBe(true);
    expect(matchesColumnFilter('2026-06-23', '>=-3m', { type: 'date', now })).toBe(true);
    expect(matchesColumnFilter('2026-06-22', '>=-3m', { type: 'date', now })).toBe(false);
  });

  it('>=ytd selects this calendar year', () => {
    expect(matchesColumnFilter('2026-01-01', '>=ytd', { type: 'date', now })).toBe(true);
    expect(matchesColumnFilter('2025-12-31', '>=ytd', { type: 'date', now })).toBe(false);
  });

  it('follows the clock — the same filter means something else later', () => {
    const later = new Date(2026, 11, 1); // 1 Dec 2026
    expect(matchesColumnFilter('2026-07-01', '>=-3m', { type: 'date', now })).toBe(true);
    expect(matchesColumnFilter('2026-07-01', '>=-3m', { type: 'date', now: later })).toBe(false);
  });

  it('a relative term only resolves on a date-ish column', () => {
    // On a string column `-3m` is a literal value, not an offset.
    expect(matchesColumnFilter('-3m', '>=-3m')).toBe(true);
  });

  it('a relative term survives compose', () => {
    expect(composeColumnFilter(parseColumnFilter('>=-3m'))).toBe('>=-3m');
    expect(composeColumnFilter(parseColumnFilter('>=ytd'))).toBe('>=ytd');
  });
});
