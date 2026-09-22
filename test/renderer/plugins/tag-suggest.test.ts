import { describe, expect, it } from 'vitest';
import { appendTag, applyTag, caretOf, suggestTags, SUGGEST_MAX, termAt } from '../../../packages/renderer/src/plugins/tag-suggest.js';

/**
 * A tags cell is edited as its raw text, which may be a comma list or a JSON
 * array. So the word being completed is the one around the CARET, not the whole
 * field a native `<datalist>` would match.
 */

const VOCAB = ['blue', 'evergreen', 'green', 'red'];

/** A caret with nothing selected. */
const at = (i: number) => ({ from: i, to: i });

describe('caretOf', () => {
  it('reads an input as a range, lowest first', () => {
    expect(caretOf({ value: 'red', selectionStart: 3, selectionEnd: 1 })).toEqual({ from: 1, to: 3 });
  });

  it('falls back to the end of the value when there is no selection at all', () => {
    expect(caretOf({ value: 'red', selectionStart: null, selectionEnd: null })).toEqual({ from: 3, to: 3 });
  });
});

describe('termAt', () => {
  it('takes the whole value when there is no separator', () => {
    expect(termAt('gre', at(3))).toMatchObject({ start: 0, end: 3, term: 'gre', quote: '' });
  });

  it('takes the word after the last comma, skipping the space', () => {
    const t = termAt('red, gre', at(8));
    expect(t.term).toBe('gre');
    expect(t.start).toBe(5);
  });

  it('reads the caret, not the end of the text', () => {
    expect(termAt('red, gre, blue', at(8)).term).toBe('gre');
    expect(termAt('red, gre, blue', at(3)).term).toBe('red');
  });

  it('is empty right after a separator — which offers everything', () => {
    expect(termAt('red, ', at(5)).term).toBe('');
    expect(termAt('red,', at(4)).term).toBe('');
  });

  it('treats a SELECTION as the term — the editor opens with everything selected', () => {
    // Without this the caret reads as 0 and a pick lands in front of the value
    // it was meant to replace.
    const t = termAt('green', { from: 0, to: 5 });
    expect(t).toMatchObject({ start: 0, end: 5, term: 'green' });
  });

  it('steps over the bracket and the quote of a JSON array', () => {
    const t = termAt('["red", "gre', at(12));
    expect(t.term).toBe('gre');
    expect(t.quote).toBe('"');
  });

  it('handles a caret sitting after a closing quote', () => {
    const t = termAt('["red"', at(6));
    expect(t.term).toBe('red');
    expect(t.quote).toBe('"');
  });
});

describe('suggestTags', () => {
  it('matches what is being typed, case-blind', () => {
    expect(suggestTags(VOCAB, 'GRE', at(3))).toEqual(['green', 'evergreen']);
  });

  it('puts starts-with above contains', () => {
    // `green` starts with it, `evergreen` only holds it.
    expect(suggestTags(VOCAB, 'gre', at(3))[0]).toBe('green');
  });

  it('offers everything for an empty term, so an empty cell shows the vocabulary', () => {
    expect(suggestTags(VOCAB, '', at(0))).toEqual(VOCAB);
    expect(suggestTags(VOCAB, 'red, ', at(5))).toEqual(['blue', 'evergreen', 'green']);
  });

  it('leaves out what the TEXT already carries — a tag list is a set', () => {
    expect(suggestTags(VOCAB, 'red, blue, ', at(11))).toEqual(['evergreen', 'green']);
    // Including the JSON spelling.
    expect(suggestTags(VOCAB, '["red","blue","', at(15))).toEqual(['evergreen', 'green']);
  });

  it('does not count the word being typed as already chosen', () => {
    expect(suggestTags(VOCAB, 'gre', at(3))).toContain('green');
    // A SELECTION is the term, so it filters rather than being excluded — it is
    // what typing would replace. `cell-tags` asks with a caret at 0 when the
    // editor opens (where everything is selected), which is how a cell holding
    // `green` still offers the whole vocabulary.
    expect(suggestTags(VOCAB, 'green', { from: 0, to: 5 })).toEqual(['green', 'evergreen']);
    expect(suggestTags(VOCAB, 'green', { from: 0, to: 0 })).toEqual(['blue', 'evergreen', 'red']);
  });

  it('is empty when nothing matches', () => {
    expect(suggestTags(VOCAB, 'zzz', at(3))).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(suggestTags(many, '', at(0))).toHaveLength(SUGGEST_MAX);
    expect(suggestTags(many, '', at(0), { max: 3 })).toHaveLength(3);
  });
});

describe('applyTag', () => {
  it('replaces the term and invites the next tag', () => {
    expect(applyTag('gre', at(3), 'green')).toEqual({ text: 'green, ', caret: 7 });
  });

  it('replaces a selection rather than inserting in front of it', () => {
    expect(applyTag('green', { from: 0, to: 5 }, 'blue')).toEqual({ text: 'blue, ', caret: 6 });
  });

  it('keeps the tags before it', () => {
    expect(applyTag('red, gre', at(8), 'green')).toEqual({ text: 'red, green, ', caret: 12 });
  });

  it('adds no separator in the middle of a list', () => {
    const out = applyTag('red, gre, blue', at(8), 'green');
    expect(out.text).toBe('red, green, blue');
    // Caret right after the word that was completed.
    expect(out.caret).toBe(10);
  });

  it('closes the quote in a JSON array, and steps over the one already there', () => {
    // An unterminated string gets its closing quote, so the value stays parseable.
    expect(applyTag('["gre', at(5), 'green').text).toBe('["green"');
    // And where the quote is already written it is not doubled.
    expect(applyTag('["gre"]', at(5), 'green').text).toBe('["green"]');
  });

  it('replaces an empty term rather than doubling a separator', () => {
    expect(applyTag('red, ', at(5), 'blue')).toEqual({ text: 'red, blue, ', caret: 11 });
  });
});

describe('appendTag', () => {
  it('adds to the end of a comma list, and invites the next', () => {
    expect(appendTag('green', 'blue')).toEqual({ text: 'green, blue, ', caret: 13 });
  });

  it('starts an empty cell off', () => {
    expect(appendTag('', 'blue')).toEqual({ text: 'blue, ', caret: 6 });
    expect(appendTag('  ', 'blue').text).toBe('blue, ');
  });

  it('does not double a separator already typed', () => {
    expect(appendTag('green,', 'blue').text).toBe('green, blue, ');
    expect(appendTag('green, ', 'blue').text).toBe('green, blue, ');
  });

  it('goes INSIDE a JSON array, quoted, with the caret before the bracket', () => {
    const out = appendTag('["green"]', 'blue');
    expect(out.text).toBe('["green", "blue"]');
    expect(out.text[out.caret]).toBe(']');
    expect(appendTag('[]', 'blue').text).toBe('["blue"]');
  });
});
