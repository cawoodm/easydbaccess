import { describe, expect, it } from 'vitest';
import { parseSearchQuery, searchRows } from './text-search.js';

// Rows are plain strings; "contains" is a lower-cased substring test.
const contains = (row: string, needle: string) => row.toLowerCase().includes(needle);
const run = (rows: string[], q: string) => searchRows(rows, q, contains);

describe('parseSearchQuery', () => {
  it('treats a plain multi-word query as a phrase + word list', () => {
    expect(parseSearchQuery('Foo Bar')).toEqual({
      kind: 'plain',
      phrase: 'foo bar',
      words: ['foo', 'bar'],
    });
  });

  it('parses OR into separate groups', () => {
    expect(parseSearchQuery('foo OR bar')).toEqual({ kind: 'boolean', groups: [['foo'], ['bar']] });
  });

  it('parses AND into one group', () => {
    expect(parseSearchQuery('foo AND bar')).toEqual({ kind: 'boolean', groups: [['foo', 'bar']] });
  });

  it('gives OR lower precedence than AND: "a AND b OR c" → (a AND b) OR c', () => {
    expect(parseSearchQuery('a AND b OR c')).toEqual({
      kind: 'boolean',
      groups: [['a', 'b'], ['c']],
    });
  });

  it('ignores lowercase and/or (they are ordinary words)', () => {
    expect(parseSearchQuery('foo and bar')).toEqual({
      kind: 'plain',
      phrase: 'foo and bar',
      words: ['foo', 'and', 'bar'],
    });
  });
});

describe('searchRows — explicit boolean operators', () => {
  const rows = ['foo only', 'bar only', 'foo and bar', 'neither'];

  it('OR returns rows matching either term', () => {
    expect(run(rows, 'foo OR bar')).toEqual(['foo only', 'bar only', 'foo and bar']);
  });

  it('AND returns only rows matching both terms', () => {
    expect(run(rows, 'foo AND bar')).toEqual(['foo and bar']);
  });

  it('(apple AND banana) OR cherry evaluates with AND binding tighter', () => {
    const r = ['apple banana', 'apple', 'cherry', 'banana', 'nope'];
    expect(run(r, 'apple AND banana OR cherry')).toEqual(['apple banana', 'cherry']);
  });
});

describe('searchRows — plain multi-word fallback (phrase → AND → OR)', () => {
  it('prefers exact-phrase matches when any exist', () => {
    const rows = ['foo bar baz', 'foo then bar', 'only foo'];
    // "foo bar" appears as a phrase only in the first row.
    expect(run(rows, 'foo bar')).toEqual(['foo bar baz']);
  });

  it('falls back to AND when no row contains the phrase', () => {
    const rows = ['foo ... bar', 'foo alone', 'bar alone', 'zzz'];
    // No "foo bar" phrase → rows containing BOTH words.
    expect(run(rows, 'foo bar')).toEqual(['foo ... bar']);
  });

  it('falls back to OR when neither phrase nor AND match', () => {
    const rows = ['foo alone', 'bar alone', 'zzz'];
    // No phrase, no row with both → rows containing EITHER word.
    expect(run(rows, 'foo bar')).toEqual(['foo alone', 'bar alone']);
  });

  it('single word is a plain substring match', () => {
    expect(run(['foo', 'foobar', 'bar'], 'foo')).toEqual(['foo', 'foobar']);
  });

  it('empty query returns everything', () => {
    const rows = ['a', 'b'];
    expect(run(rows, '   ')).toEqual(rows);
  });

  it('is case-insensitive', () => {
    expect(run(['Foo Bar', 'baz'], 'FOO OR BAZ')).toEqual(['Foo Bar', 'baz']);
  });
});
