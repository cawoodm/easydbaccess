import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_WORDS, defaultStopWordsText, parseWordList, resolveStopWords, tokenize, wordFrequencies } from '../../../packages/renderer/src/viz/word-frequency.js';

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

describe('keepWords — the exception list', () => {
  it('keeps a word shorter than minLength', () => {
    // The reason it exists: acronyms are often the most interesting terms in a
    // column and the first thing a length limit throws away.
    const out = wordFrequencies(['AI and UI and SQL'], { minLength: 4, keepWords: new Set(['ai', 'ui']) });
    const terms = out.map((t) => t.term);
    expect(terms).toContain('AI');
    expect(terms).toContain('UI');
    // Still respected for everything NOT on the list.
    expect(terms).not.toContain('and');
  });

  it('overrides the stop list too, not just the length', () => {
    // "always keep this word" that a second rule could still eat would be a
    // setting that lies.
    const out = wordFrequencies(['the cat'], { minLength: 1, keepWords: new Set(['the']) });
    expect(out.map((t) => t.term)).toContain('the');
  });

  it('overrides the numbers rule', () => {
    const out = wordFrequencies(['sales 2026'], { minLength: 1, keepWords: new Set(['2026']) });
    expect(out.map((t) => t.term)).toContain('2026');
  });

  it('matches case-insensitively, like every other rule here', () => {
    const out = wordFrequencies(['ai AI Ai'], { minLength: 4, keepWords: new Set(['ai']) });
    expect(out[0]?.count).toBe(3);
  });

  it('changes nothing when empty or absent', () => {
    const withEmpty = wordFrequencies(['the cat sat'], { minLength: 3, keepWords: new Set() }).map((t) => t.term);
    const without = wordFrequencies(['the cat sat'], { minLength: 3 }).map((t) => t.term);
    expect(withEmpty).toEqual(without);
  });
});

describe('parseWordList', () => {
  it('accepts commas, spaces, semicolons and new lines interchangeably', () => {
    // It is a free-text field; a user typing any of these means the same thing.
    expect([...parseWordList('the, and of;  but\nyet')]).toEqual(['the', 'and', 'of', 'but', 'yet']);
  });

  it('folds to lower case, because that is how the counter compares', () => {
    expect([...parseWordList('The AND')]).toEqual(['the', 'and']);
  });

  it('drops empties and de-duplicates', () => {
    expect([...parseWordList(' , the ,, the , ')]).toEqual(['the']);
  });

  it('returns an empty set for empty, null or a non-string', () => {
    expect(parseWordList('').size).toBe(0);
    expect(parseWordList(null).size).toBe(0);
    expect(parseWordList(undefined).size).toBe(0);
  });
});

describe('resolveStopWords', () => {
  it('uses the built-in list when never configured', () => {
    expect(resolveStopWords(undefined)).toBe(DEFAULT_STOP_WORDS);
    expect(resolveStopWords(null)).toBe(DEFAULT_STOP_WORDS);
  });

  it('treats a deliberately emptied field as "drop nothing"', () => {
    // The distinction that matters: absent means "I never said", empty means
    // "I said none".
    expect(resolveStopWords('').size).toBe(0);
    expect(resolveStopWords('   ').size).toBe(0);
  });

  it('parses a list', () => {
    expect([...resolveStopWords('foo, bar')]).toEqual(['foo', 'bar']);
  });

  it('still understands the boolean this option used to be', () => {
    // Templates saved before the option became editable text are still valid.
    expect(resolveStopWords(true)).toBe(DEFAULT_STOP_WORDS);
    expect(resolveStopWords(false).size).toBe(0);
  });

  it('round-trips the built-in list through its text form', () => {
    const text = defaultStopWordsText();
    expect(resolveStopWords(text).size).toBe(DEFAULT_STOP_WORDS.size);
    for (const w of ['the', 'and', 'of']) expect(resolveStopWords(text).has(w)).toBe(true);
  });
});
