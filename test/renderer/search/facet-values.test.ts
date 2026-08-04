import { describe, expect, it } from 'vitest';
import {
  facetable,
  facetCounts,
  facetValues,
  FACET_MAX_LEN,
} from '../../../packages/renderer/src/search/facet-values.js';

const rows = (...vals: unknown[]) => vals.map((v) => ({ data: { tag: v, other: 'x' } }));

describe('facetable', () => {
  it('accepts a column of short values', () => {
    expect(facetable(rows('a', 'b', null), 'tag')).toBe(true);
  });

  it('rejects a column with one long value — prose is not a value list', () => {
    expect(facetable(rows('a', 'x'.repeat(FACET_MAX_LEN)), 'tag')).toBe(false);
    // Exactly at the limit is already too long (the rule is "fewer than").
    expect(facetable(rows('x'.repeat(FACET_MAX_LEN - 1)), 'tag')).toBe(true);
  });

  it('judges only the first 100 rows, so a big table stays cheap', () => {
    const short = rows(...Array.from({ length: 100 }, () => 'a'));
    const late = rows('x'.repeat(200));
    expect(facetable([...short, ...late], 'tag')).toBe(true);
  });

  it('rejects an empty row set — there is nothing to offer', () => {
    expect(facetable([], 'tag')).toBe(false);
  });

  it('measures what a non-string value prints as, not its type', () => {
    expect(facetable(rows(12345), 'tag')).toBe(true);
  });
});

describe('facetValues', () => {
  it('returns distinct values, sorted', () => {
    expect(facetValues(rows('b', 'a', 'b', 'c'), 'tag')).toEqual(['a', 'b', 'c']);
  });

  it('drops null, undefined and empty string', () => {
    expect(facetValues(rows('a', null, undefined, ''), 'tag')).toEqual(['a']);
  });

  it('is case-sensitive — two casings are two values', () => {
    // The pill layer compares case-insensitively when matching, but the list
    // shows what the data actually says rather than folding rows together.
    expect(facetValues(rows('Ada', 'ada'), 'tag')).toEqual(['Ada', 'ada']);
  });

  it('skips values at or over the length limit', () => {
    expect(facetValues(rows('a', 'x'.repeat(FACET_MAX_LEN)), 'tag')).toEqual(['a']);
  });

  it('stringifies numbers and booleans', () => {
    expect(facetValues(rows(2, 10, true), 'tag')).toEqual(['10', '2', 'true']);
  });

  it('caps the list, and takes the cap from the options given', () => {
    const many = rows(...Array.from({ length: 20 }, (_v, i) => `v${i}`));
    expect(facetValues(many, 'tag', { maxOptions: 5 })).toHaveLength(5);
  });

  it('returns nothing for a field no row carries', () => {
    expect(facetValues(rows('a'), 'missing')).toEqual([]);
  });
});

describe('facetCounts', () => {
  it('counts each value and orders commonest first, ties alphabetical', () => {
    const r = rows('b', 'a', 'b', 'c', 'a', 'b');
    expect(facetCounts(r, 'tag').values).toEqual([
      { value: 'b', count: 3 },
      { value: 'a', count: 2 },
      { value: 'c', count: 1 },
    ]);
  });

  it('collects blanks separately — null, empty and whitespace all count', () => {
    const r = rows('a', null, '', '   ', undefined);
    const { values, blanks } = facetCounts(r, 'tag');
    expect(values).toEqual([{ value: 'a', count: 1 }]);
    expect(blanks).toBe(4);
  });

  it('always lists both sides of a boolean, in true/false order', () => {
    // A column of all-true rows would otherwise leave no way to filter for false.
    const { values } = facetCounts(rows(true, true), 'tag', { type: 'boolean' });
    expect(values).toEqual([
      { value: 'true', count: 2 },
      { value: 'false', count: 0 },
    ]);
  });

  it('keeps another spelling of a boolean as its own entry, below the domain', () => {
    const { values } = facetCounts(rows(true, 'yes'), 'tag', { type: 'boolean' });
    expect(values.map((v) => v.value)).toEqual(['true', 'false', 'yes']);
  });
});

/**
 * A list column's dropdown must offer the MEMBERS. Offering whole cells is
 * useless: every row is its own "value", and picking one of them matches nothing
 * once the exact token reaches the matcher.
 */
describe('an array column', () => {
  const arr = { type: 'array' };

  it('counts each member, so the counts exceed the row count', () => {
    const r = rows('foo,bar', '["bar","baz"]', ['baz']);
    const { values, blanks } = facetCounts(r, 'tag', arr);
    expect(values).toEqual([
      { value: 'bar', count: 2 },
      { value: 'baz', count: 2 },
      { value: 'foo', count: 1 },
    ]);
    expect(blanks).toBe(0);
  });

  it('counts a cell with no members as blank', () => {
    const { values, blanks } = facetCounts(rows('a', '[]', '', null), 'tag', arr);
    expect(values).toEqual([{ value: 'a', count: 1 }]);
    expect(blanks).toBe(3);
  });

  it('suggests the members, distinct and sorted', () => {
    expect(facetValues(rows('foo,bar', '["bar"]'), 'tag', arr)).toEqual(['bar', 'foo']);
  });

  it('stays facetable when the LIST is long but its members are short', () => {
    // As one string this cell is past the limit; as a list of tags it is exactly
    // the column that needs a dropdown.
    const long = Array.from({ length: 20 }, (_, i) => `tag${i}`).join(',');
    expect(long.length).toBeGreaterThan(FACET_MAX_LEN);
    expect(facetable(rows(long), 'tag', arr)).toBe(true);
    expect(facetable(rows(long), 'tag')).toBe(false);
  });

  it('is still rejected when one MEMBER is prose', () => {
    expect(facetable(rows(`a,${'x'.repeat(FACET_MAX_LEN)}`), 'tag', arr)).toBe(false);
  });
});
