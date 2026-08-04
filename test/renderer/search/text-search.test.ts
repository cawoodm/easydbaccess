import { describe, expect, it } from 'vitest';
import { parseSearchQuery, searchRows, searchRowsByField } from '../../../packages/renderer/src/search/text-search.js';

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

describe('searchRowsByField (field:value with column-filter operators)', () => {
  interface R {
    data: Record<string, unknown>;
  }
  const rows: R[] = [{ data: { city: 'Paris', read: true, title: 'Alpha' } }, { data: { city: 'London', read: false, title: 'Beta' } }, { data: { city: 'Paris', read: false, title: 'Gamma' } }];
  const fields = [{ field: 'city' }, { field: 'read' }, { field: 'title', label: 'Name' }];
  const run = (q: string) => searchRowsByField(rows, q, fields).map((r) => r.data.title);

  it('field:value restricts the match to that column', () => {
    expect(run('city:Paris')).toEqual(['Alpha', 'Gamma']);
  });

  it('tolerates a space after the field colon', () => {
    expect(run('city: London')).toEqual(['Beta']);
  });

  it('supports ! negation inside a field term (and surfaces falsy rows)', () => {
    expect(run('read:!true')).toEqual(['Beta', 'Gamma']);
  });

  it('supports ^ starts-with inside a field term', () => {
    expect(run('city:^Lon')).toEqual(['Beta']);
  });

  it('combines field terms with AND / OR', () => {
    expect(run('city:Paris AND read:true')).toEqual(['Alpha']);
    expect(run('city:London OR read:true')).toEqual(['Alpha', 'Beta']);
  });

  it('implicitly ANDs adjacent field terms (via the phrase→AND fallback)', () => {
    expect(run('city:Paris read:false')).toEqual(['Gamma']);
  });

  it('resolves a field by its label too', () => {
    expect(run('name:Beta')).toEqual(['Beta']);
  });

  it('an unknown field prefix falls back to a plain across-all-fields substring', () => {
    // `zzz` is not a column → the whole token is a plain substring (matches nothing here).
    expect(run('zzz:Paris')).toEqual([]);
    // A plain word still searches every field.
    expect(run('Paris')).toEqual(['Alpha', 'Gamma']);
  });
});
