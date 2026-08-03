import { describe, expect, it } from 'vitest';
import {
  facetable,
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
