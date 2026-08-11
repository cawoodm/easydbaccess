// packages/renderer/src/viz/word-frequency.ts
//
// Text in, ranked terms out. The part of a word cloud that has judgement in it,
// so the part that gets unit tests — the spiral layout is arithmetic in a
// library, but what counts as a word is a decision.
//
// Pure: no DOM, no store, no d3.
//
// The rules, and why each one is here:
//
//  - **Split on non-letters, but keep intra-word apostrophes and hyphens.**
//    "don't" and "well-known" are one word each; splitting them yields "don", "t"
//    and two halves nobody searched for.
//  - **Case-fold for counting, then report the commonest spelling.** "Apple" and
//    "apple" are the same term, but showing "apple" in a cloud of proper nouns
//    reads as a typo — so the winner is whichever casing actually dominated.
//  - **Stop words are dropped, and the list is short on purpose.** A long list
//    starts making editorial choices about the user's data. This one covers
//    English function words, which is what makes a cloud unreadable when left in
//    (`the` is always the biggest word in any English text).
//  - **Numbers are dropped by default.** A column of prose with years in it makes
//    a cloud of years, which is a histogram badly drawn.

/** English function words. Deliberately short — see the note above. */
export const DEFAULT_STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  's',
  't',
  'don',
  'isn',
  'aren',
  'wasn',
  'weren',
  'doesn',
  'didn',
  'won',
  'shouldn',
  'couldn',
  'wouldn',
]);

export interface WordFrequencyOptions {
  /** Terms shorter than this are dropped. Default 3 — "an", "of" survive stop-word removal in other languages. */
  minLength?: number | undefined;
  /** Cap on returned terms, highest count first. Default 120. */
  maxTerms?: number | undefined;
  /** Words to drop. Default `DEFAULT_STOP_WORDS`; pass an empty set to keep everything. */
  stopWords?: ReadonlySet<string> | undefined;
  /** Keep purely numeric terms. Default false. */
  includeNumbers?: boolean | undefined;
}

export interface TermCount {
  /** The dominant spelling of the term. */
  term: string;
  count: number;
}

/**
 * Split one string into candidate words.
 *
 * Unicode-aware (`\p{L}`), so this is not an English-only tokenizer even though
 * the default stop list is English. An apostrophe or hyphen is kept only BETWEEN
 * letters, so a quoted 'word' or a dash — used as punctuation — does not glue
 * itself on.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /\p{L}[\p{L}\p{N}]*(?:['’-][\p{L}\p{N}]+)*|\p{N}+/gu;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/**
 * Count terms across many values, most frequent first.
 *
 * `values` is deliberately `unknown[]`: it is fed straight from row cells, which
 * may hold numbers, nulls, or arrays. Anything that is not a string or number is
 * skipped rather than stringified — `[object Object]` is not a word.
 */
export function wordFrequencies(values: readonly unknown[], opts: WordFrequencyOptions = {}): TermCount[] {
  const minLength = opts.minLength ?? 3;
  const maxTerms = opts.maxTerms ?? 120;
  const stop = opts.stopWords ?? DEFAULT_STOP_WORDS;
  const includeNumbers = opts.includeNumbers ?? false;

  /** folded → { total, spellings } so the dominant casing can be reported. */
  const counts = new Map<string, { total: number; spellings: Map<string, number> }>();

  const feed = (text: string): void => {
    for (const raw of tokenize(text)) {
      const folded = raw.toLocaleLowerCase();
      if (folded.length < minLength) continue;
      if (stop.has(folded)) continue;
      if (!includeNumbers && /^\p{N}+$/u.test(folded)) continue;
      let e = counts.get(folded);
      if (!e) {
        e = { total: 0, spellings: new Map() };
        counts.set(folded, e);
      }
      e.total++;
      e.spellings.set(raw, (e.spellings.get(raw) ?? 0) + 1);
    }
  };

  for (const v of values) {
    if (typeof v === 'string') feed(v);
    else if (typeof v === 'number' && Number.isFinite(v)) feed(String(v));
    else if (Array.isArray(v)) {
      for (const m of v) if (typeof m === 'string' || typeof m === 'number') feed(String(m));
    }
  }

  const ranked: TermCount[] = [...counts.entries()].map(([folded, e]) => {
    // The commonest spelling wins; ties break toward the lower-cased form so the
    // result is deterministic rather than insertion-ordered.
    let best = folded;
    let bestN = -1;
    for (const [spelling, n] of e.spellings) {
      if (n > bestN || (n === bestN && spelling < best)) {
        best = spelling;
        bestN = n;
      }
    }
    return { term: best, count: e.total };
  });

  // Count desc, then term asc — a stable order matters because the layout is
  // seeded by input order and a cloud that reshuffles on every render is noise.
  ranked.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  return ranked.slice(0, maxTerms);
}

/**
 * Map counts onto a font-size range.
 *
 * Square-root rather than linear: a term appearing 400 times against one
 * appearing 4 is not 100 times more interesting, and a linear scale makes every
 * term but the top one illegible. Area — not height — is what the eye reads as
 * magnitude, and area grows with the square of the font size.
 */
export function scaleTermSizes(terms: readonly TermCount[], minSize: number, maxSize: number): Array<TermCount & { size: number }> {
  if (terms.length === 0) return [];
  const counts = terms.map((t) => t.count);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return terms.map((t) => {
    // Every term the same count ⇒ every term the same size, and no divide by zero.
    const frac = hi === lo ? 1 : (Math.sqrt(t.count) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo));
    return { ...t, size: Math.round(minSize + frac * (maxSize - minSize)) };
  });
}
