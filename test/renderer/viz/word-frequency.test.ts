import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_WORDS, scaleTermSizes, tokenize, wordFrequencies } from '../../../packages/renderer/src/viz/word-frequency.js';

describe('tokenize', () => {
  it('splits on punctuation and whitespace', () => {
    expect(tokenize('Hello, world! Again.')).toEqual(['Hello', 'world', 'Again']);
  });

  it('keeps an apostrophe inside a word', () => {
    // "don't" is one word; splitting it yields "don" and "t", neither of which
    // anybody searched for.
    expect(tokenize("don't stop")).toEqual(["don't", 'stop']);
    expect(tokenize('it’s fine')).toEqual(['it’s', 'fine']);
  });

  it('keeps a hyphen inside a word but not around it', () => {
    expect(tokenize('well-known')).toEqual(['well-known']);
    expect(tokenize('a — b')).toEqual(['a', 'b']);
  });

  it('is unicode-aware, not ASCII-only', () => {
    expect(tokenize('Zürich Genève 東京')).toEqual(['Zürich', 'Genève', '東京']);
  });

  it('yields numbers as their own tokens', () => {
    expect(tokenize('year 2026')).toEqual(['year', '2026']);
  });

  it('handles an empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('wordFrequencies', () => {
  it('counts terms and ranks them most frequent first', () => {
    const out = wordFrequencies(['apple pear apple', 'apple'], { minLength: 1 });
    expect(out[0]).toEqual({ term: 'apple', count: 3 });
    expect(out[1]).toEqual({ term: 'pear', count: 1 });
  });

  it('case-folds for counting', () => {
    const out = wordFrequencies(['Apple apple APPLE'], { minLength: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(3);
  });

  it('reports the dominant spelling, not the folded one', () => {
    // A cloud of proper nouns showing "zurich" reads as a typo.
    const out = wordFrequencies(['Zurich Zurich zurich'], { minLength: 1 });
    expect(out[0]?.term).toBe('Zurich');
  });

  it('breaks a spelling tie deterministically', () => {
    const a = wordFrequencies(['Foo foo'], { minLength: 1 })[0]?.term;
    const b = wordFrequencies(['foo Foo'], { minLength: 1 })[0]?.term;
    expect(a).toBe(b);
  });

  it('drops stop words, which are what make a cloud unreadable', () => {
    const out = wordFrequencies(['the cat and the hat'], { minLength: 1 });
    expect(out.map((t) => t.term)).not.toContain('the');
    expect(out.map((t) => t.term)).not.toContain('and');
    expect(out.map((t) => t.term)).toContain('cat');
  });

  it('keeps stop words when the list is emptied', () => {
    const out = wordFrequencies(['the cat'], { minLength: 1, stopWords: new Set() });
    expect(out.map((t) => t.term)).toContain('the');
  });

  it('drops numbers by default, keeps them on request', () => {
    expect(wordFrequencies(['sales 2026'], { minLength: 1 }).map((t) => t.term)).not.toContain('2026');
    expect(wordFrequencies(['sales 2026'], { minLength: 1, includeNumbers: true }).map((t) => t.term)).toContain('2026');
  });

  it('honours minLength', () => {
    const out = wordFrequencies(['ox cat horse'], { minLength: 4 });
    expect(out.map((t) => t.term)).toEqual(['horse']);
  });

  it('caps at maxTerms, keeping the most frequent', () => {
    // Deliberately not single letters: 'a', 'i' and 's' are stop words, so a
    // test written with them would be measuring the stop list instead.
    const out = wordFrequencies(['cat cat cat dog dog fox'], { minLength: 1, maxTerms: 2 });
    expect(out.map((t) => t.term)).toEqual(['cat', 'dog']);
  });

  it('reads numbers and array cells, and skips anything else', () => {
    // Fed straight from row cells, which hold whatever the table holds.
    const out = wordFrequencies(['cat', 42, ['dog', 'cat'], null, undefined, { a: 1 }], {
      minLength: 1,
      includeNumbers: true,
    });
    const terms = out.map((t) => t.term);
    expect(terms).toContain('cat');
    expect(terms).toContain('dog');
    expect(terms).toContain('42');
    // No `[object Object]` — that is not a word.
    expect(terms.join(' ')).not.toContain('object');
  });

  it('counts a term twice when it appears twice in one cell', () => {
    expect(wordFrequencies(['cat cat'], { minLength: 1 })[0]?.count).toBe(2);
  });

  it('is stable for equal counts, so a cloud does not reshuffle', () => {
    const once = wordFrequencies(['pear apple'], { minLength: 1 }).map((t) => t.term);
    const twice = wordFrequencies(['apple pear'], { minLength: 1 }).map((t) => t.term);
    expect(once).toEqual(twice);
    expect(once).toEqual(['apple', 'pear']);
  });

  it('returns nothing for no values', () => {
    expect(wordFrequencies([])).toEqual([]);
  });

  it('has a stop list that covers the obvious offenders', () => {
    for (const w of ['the', 'and', 'of', 'to', 'a', 'is']) expect(DEFAULT_STOP_WORDS.has(w)).toBe(true);
  });
});

describe('scaleTermSizes', () => {
  it('maps the extremes onto the range ends', () => {
    const out = scaleTermSizes(
      [
        { term: 'a', count: 100 },
        { term: 'b', count: 1 },
      ],
      10,
      50,
    );
    expect(out[0]?.size).toBe(50);
    expect(out[1]?.size).toBe(10);
  });

  it('gives every term the max size when all counts are equal', () => {
    // And crucially does not divide by zero.
    const out = scaleTermSizes(
      [
        { term: 'a', count: 5 },
        { term: 'b', count: 5 },
      ],
      10,
      50,
    );
    expect(out.map((t) => t.size)).toEqual([50, 50]);
  });

  it('scales by sqrt, which lifts the middle of a skewed range', () => {
    const out = scaleTermSizes(
      [
        { term: 'a', count: 400 },
        { term: 'b', count: 100 },
        { term: 'c', count: 4 },
      ],
      10,
      50,
    );
    // Roots are 20, 10, 2 ⇒ the middle sits at (10-2)/(20-2) = 0.44 of the range,
    // i.e. 28. A linear scale would put it at (100-4)/396 = 0.24, i.e. 20 — barely
    // above the smallest term despite being 25x its count.
    expect(out[1]?.size).toBe(28);
    expect(out[0]?.size).toBe(50);
    expect(out[2]?.size).toBe(10);
  });

  it('handles a single term and no terms', () => {
    expect(scaleTermSizes([{ term: 'a', count: 3 }], 10, 50)[0]?.size).toBe(50);
    expect(scaleTermSizes([], 10, 50)).toEqual([]);
  });
});
