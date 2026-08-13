import { describe, expect, it } from 'vitest';
import { effectiveVizOptions, overrideDelta, overriddenKeys } from '../../../packages/renderer/src/viz/viz-options.js';

describe('effectiveVizOptions', () => {
  it('returns the template options when nothing is overridden', () => {
    expect(effectiveVizOptions({ minLength: 3, rotate: true }, undefined)).toEqual({ minLength: 3, rotate: true });
  });

  it('lets an instance override one key without touching the rest', () => {
    expect(effectiveVizOptions({ minLength: 3, maxTerms: 120 }, { minLength: 5 })).toEqual({ minLength: 5, maxTerms: 120 });
  });

  it('lets an instance add a key the template never set', () => {
    expect(effectiveVizOptions({ minLength: 3 }, { keepWords: 'AI, UI' })).toEqual({ minLength: 3, keepWords: 'AI, UI' });
  });

  it('treats an explicit undefined override as absent, so clearing reverts to the template', () => {
    expect(effectiveVizOptions({ minLength: 3 }, { minLength: undefined })).toEqual({ minLength: 3 });
  });

  it('keeps a deliberately empty string, which is a real answer for a word list', () => {
    // "ignore no common words" has to be expressible, and it is not the same as
    // "inherit the template's list".
    expect(effectiveVizOptions({ stopWords: 'the, and' }, { stopWords: '' })).toEqual({ stopWords: '' });
  });

  it('handles both sides being absent', () => {
    expect(effectiveVizOptions(undefined, undefined)).toEqual({});
  });

  it('does not mutate either input', () => {
    const tpl = { a: 1 };
    const inst = { a: 2 };
    effectiveVizOptions(tpl, inst);
    expect(tpl).toEqual({ a: 1 });
    expect(inst).toEqual({ a: 2 });
  });
});

describe('overrideDelta', () => {
  it('stores only what actually differs from the template', () => {
    // The whole point: storing the full set would freeze a copy, and a later
    // template edit would stop reaching this instance.
    expect(overrideDelta({ minLength: 3, maxTerms: 120 }, { minLength: 5, maxTerms: 120 })).toEqual({ minLength: 5 });
  });

  it('stores nothing when the editor was closed unchanged', () => {
    expect(overrideDelta({ minLength: 3, rotate: false }, { minLength: 3, rotate: false })).toEqual({});
  });

  it('does not record an override for a blank that was already absent', () => {
    // A text input renders an absent option as '', so a user who never touched
    // the field must not end up overriding it.
    expect(overrideDelta({ minLength: 3 }, { minLength: 3, keepWords: '' })).toEqual({});
    expect(overrideDelta({ keepWords: null }, { keepWords: '' })).toEqual({});
  });

  it('records clearing a list the template had set', () => {
    expect(overrideDelta({ stopWords: 'the, and' }, { stopWords: '' })).toEqual({ stopWords: '' });
  });

  it('compares a numeric string against a number by value', () => {
    // Number inputs hand back strings; '3' is not a change from 3.
    expect(overrideDelta({ minLength: 3 }, { minLength: '3' })).toEqual({});
    expect(overrideDelta({ minLength: 3 }, { minLength: '5' })).toEqual({ minLength: '5' });
  });

  it('records a booleans flip in both directions', () => {
    expect(overrideDelta({ rotate: false }, { rotate: true })).toEqual({ rotate: true });
    expect(overrideDelta({ rotate: true }, { rotate: false })).toEqual({ rotate: false });
  });

  it('handles an absent template', () => {
    expect(overrideDelta(undefined, { minLength: 5 })).toEqual({ minLength: 5 });
  });
});

describe('overriddenKeys', () => {
  it('names the keys an instance has taken over', () => {
    expect(overriddenKeys({ a: 1, b: 2 }, { a: 9 })).toEqual(new Set(['a']));
  });

  it('is empty when an instance overrides nothing', () => {
    expect(overriddenKeys({ a: 1 }, {})).toEqual(new Set());
  });

  it('round-trips with effectiveVizOptions', () => {
    const tpl = { minLength: 3, stopWords: 'the' };
    const delta = overrideDelta(tpl, { minLength: 5, stopWords: 'the' });
    expect(effectiveVizOptions(tpl, delta)).toEqual({ minLength: 5, stopWords: 'the' });
    expect(overriddenKeys(tpl, delta)).toEqual(new Set(['minLength']));
  });
});
