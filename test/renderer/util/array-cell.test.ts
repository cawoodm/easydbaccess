import { describe, expect, it } from 'vitest';
import {
  arrayCellText,
  arrayMembers,
  jsonArray,
  looksLikeArray,
  looksLikeJsonArray,
} from '../../../packages/renderer/src/util/array-cell.js';

/**
 * An `array` column has to read three spellings of the same thing: a comma list
 * from a CSV, a JSON array as text from an API, and a real JS array from a JSON
 * import. Every reader (filter, funnel, renderer) goes through `arrayMembers`,
 * so these cases are the contract.
 */

describe('arrayMembers', () => {
  it('splits a comma list', () => {
    expect(arrayMembers('foo,bar,baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('trims the members of a comma list', () => {
    expect(arrayMembers('foo , bar')).toEqual(['foo', 'bar']);
  });

  it('reads a JSON array given as text', () => {
    expect(arrayMembers('["Foo", "Bar"]')).toEqual(['Foo', 'Bar']);
  });

  it('reads a real JS array', () => {
    expect(arrayMembers(['Foo', 'Bar'])).toEqual(['Foo', 'Bar']);
  });

  it('stringifies non-string members', () => {
    expect(arrayMembers([1, true, null, 2.5])).toEqual(['1', 'true', '2.5']);
    expect(arrayMembers('[1,2]')).toEqual(['1', '2']);
  });

  it('has no members for an empty cell, whichever spelling', () => {
    expect(arrayMembers(null)).toEqual([]);
    expect(arrayMembers(undefined)).toEqual([]);
    expect(arrayMembers('')).toEqual([]);
    expect(arrayMembers('   ')).toEqual([]);
    expect(arrayMembers('[]')).toEqual([]);
    expect(arrayMembers([])).toEqual([]);
  });

  it('drops empty members, so a,,b is two values', () => {
    expect(arrayMembers('a,,b')).toEqual(['a', 'b']);
    expect(arrayMembers('["a","","b"]')).toEqual(['a', 'b']);
  });

  it('keeps a comma inside a quoted member', () => {
    expect(arrayMembers('"Berlin, DE",Zurich')).toEqual(['Berlin, DE', 'Zurich']);
  });

  it('keeps a doubled quote as one literal quote', () => {
    expect(arrayMembers('"say ""hi""",b')).toEqual(['say "hi"', 'b']);
  });

  it('falls back to the comma split for text that only looks like JSON', () => {
    // `[a, b]` is not valid JSON. Reading it as one unparseable blob would lose
    // both values; the comma split still finds them (brackets and all).
    expect(arrayMembers('[a, b]')).toEqual(['[a', 'b]']);
  });

  it('reads a lone scalar as a single member', () => {
    expect(arrayMembers('foo')).toEqual(['foo']);
    expect(arrayMembers(42)).toEqual(['42']);
    expect(arrayMembers(false)).toEqual(['false']);
  });

  it('serialises an object member rather than printing [object Object]', () => {
    expect(arrayMembers([{ a: 1 }])).toEqual(['{"a":1}']);
  });
});

describe('arrayCellText', () => {
  it('reads the members as one line', () => {
    expect(arrayCellText('foo,bar')).toBe('foo, bar');
    expect(arrayCellText('["Foo","Bar"]')).toBe('Foo, Bar');
    expect(arrayCellText(null)).toBe('');
  });
});

describe('jsonArray / looksLikeJsonArray', () => {
  it('parses a JSON array text', () => {
    expect(jsonArray('[1,2]')).toEqual([1, 2]);
    expect(jsonArray('  ["a"] ')).toEqual(['a']);
    expect(jsonArray('[]')).toEqual([]);
  });

  it('answers null for JSON that is not an array, and for non-JSON', () => {
    expect(jsonArray('{"a":1}')).toBeNull();
    expect(jsonArray('"a"')).toBeNull();
    expect(jsonArray('[a, b]')).toBeNull();
    expect(jsonArray('foo,bar')).toBeNull();
  });

  it('shape-tests before parsing', () => {
    expect(looksLikeJsonArray('[1]')).toBe(true);
    expect(looksLikeJsonArray('[')).toBe(false);
    expect(looksLikeJsonArray('foo')).toBe(false);
  });
});

describe('looksLikeArray', () => {
  it('accepts a real array and a JSON-array text', () => {
    expect(looksLikeArray(['a'])).toBe(true);
    expect(looksLikeArray([])).toBe(true);
    expect(looksLikeArray('["a","b"]')).toBe(true);
  });

  it('refuses a comma list — prose is full of commas', () => {
    // Type inference must not retype every sentence in a CSV as a list. A comma
    // list becomes an array column only when someone says so.
    expect(looksLikeArray('foo,bar')).toBe(false);
    expect(looksLikeArray('Hello, world')).toBe(false);
    expect(looksLikeArray('plain')).toBe(false);
    expect(looksLikeArray(3)).toBe(false);
  });
});
