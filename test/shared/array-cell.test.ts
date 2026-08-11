import { describe, expect, it } from 'vitest';
import { ARRAY_RUN, arrayCellText, arrayMembers, jsonArray, looksLikeArray, looksLikeArrayColumn, looksLikeJsonArray, singleQuotedArray } from '../../packages/shared/src/array-cell.js';

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

  /**
   * `['a', 'b']` is what Python's repr writes, so it arrives in exported CSVs
   * constantly. JSON.parse refuses it, and before this it fell through to the
   * comma split — which cut it into `['a` and `'b']`, brackets and quotes and all.
   */
  describe('single-quoted lists', () => {
    it('reads the members, brackets and quotes gone', () => {
      expect(singleQuotedArray("['a', 'b']")).toEqual(['a', 'b']);
      expect(arrayMembers("['a', 'b']")).toEqual(['a', 'b']);
      expect(looksLikeArray("['a', 'b']")).toBe(true);
    });

    it('keeps a comma or an apostrophe inside a member', () => {
      expect(arrayMembers("['Berlin, DE', 'Zurich']")).toEqual(['Berlin, DE', 'Zurich']);
      // Escaped, as an exporter writes it. An UNescaped apostrophe is genuinely
      // ambiguous (`['it's']` could be two broken members), so that one falls
      // back to the comma split rather than guessing.
      expect(arrayMembers(String.raw`['it\'s', 'b']`)).toEqual(["it's", 'b']);
      expect(singleQuotedArray("['it's', 'b']")).toBeNull();
    });

    it('one member and odd spacing are still a list', () => {
      expect(arrayMembers("['solo']")).toEqual(['solo']);
      expect(arrayMembers("[  'a' ,  'b'  ]")).toEqual(['a', 'b']);
    });

    // Anything not exactly this shape must fall through to the comma split, or
    // ordinary prose in brackets would start being reinterpreted.
    it('refuses a half-quoted or unquoted list', () => {
      expect(singleQuotedArray('[unquoted, words]')).toBeNull();
      expect(singleQuotedArray(`["a", 'b']`)).toBeNull();
      expect(singleQuotedArray("['unterminated]")).toBeNull();
      expect(singleQuotedArray('[]')).toBeNull();
      expect(singleQuotedArray('not a list')).toBeNull();
    });

    it('leaves the JSON spelling to JSON', () => {
      expect(arrayMembers('["a", "b"]')).toEqual(['a', 'b']);
      expect(arrayMembers('[]')).toEqual([]);
    });
  });

  /**
   * A column is a list column on the evidence of a RUN, not of every cell: one
   * `n/a` in ten thousand lists used to leave the column typed `string`.
   */
  describe('looksLikeArrayColumn', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `["a${i}"]`);

    it('needs a run of five, and one stray cell no longer spoils it', () => {
      expect(looksLikeArrayColumn([...list(ARRAY_RUN), 'n/a'])).toBe(true);
      expect(looksLikeArrayColumn(['n/a', ...list(ARRAY_RUN)])).toBe(true);
      expect(looksLikeArrayColumn([...list(3), 'n/a', ...list(ARRAY_RUN)])).toBe(true);
    });

    it('a broken run is not a run', () => {
      expect(looksLikeArrayColumn([...list(3), 'n/a', ...list(3)])).toBe(false);
    });

    it('a short column still has to be all lists — the old rule', () => {
      expect(looksLikeArrayColumn(list(2))).toBe(true);
      expect(looksLikeArrayColumn([...list(2), 'n/a'])).toBe(false);
      expect(looksLikeArrayColumn([])).toBe(false);
    });

    it('mixes the spellings, since all three read the same', () => {
      expect(looksLikeArrayColumn(['["a"]', "['b']", ['c'], '["d"]', "['e']"])).toBe(true);
    });

    it('a column of prose is not a list column', () => {
      expect(looksLikeArrayColumn(['Hello, world', 'a,b', 'plain', 'x', 'y', 'z'])).toBe(false);
    });
  });
});
