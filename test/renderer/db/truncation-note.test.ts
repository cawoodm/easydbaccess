import { describe, expect, it } from 'vitest';
import { truncationNote } from '../../../packages/renderer/src/db/truncation-note.js';

/**
 * The sentence a capped read shows. The SEARCH wording is the point of the
 * module: a free-text query runs in memory over the rows that were fetched, so an
 * empty result means "nothing in the rows we have" — which reads exactly like
 * "nothing" unless it is said out loud.
 */
describe('truncationNote', () => {
  // The counts go through `toLocaleString`, so the thousands separator is the
  // reader's, not `,`. Expectations build it the same way rather than pinning a
  // locale the app deliberately does not pin.
  const n = (v: number) => v.toLocaleString();

  it('says nothing when there is nothing to warn about', () => {
    expect(truncationNote(null)).toBeNull();
  });

  it('a filtered read says how far it got and what widens it', () => {
    const note = truncationNote({ shown: 20000, total: 20000, searching: false });
    expect(note).toContain(`first ${n(20000)}`);
    expect(note).toContain('Narrow the filter');
  });

  it('a search that found nothing does not claim there is nothing', () => {
    const note = truncationNote({ shown: 0, total: 0, searching: true, searched: 20000 })!;
    expect(note).toContain(`Nothing found in the first ${n(20000)} rows`);
    expect(note).toContain('may be matches further in');
    // Narrowing a search re-runs over the same rows; a column filter is pushed
    // down to the store and so reaches the rest.
    expect(note).toContain('Filter a column');
    expect(note).not.toContain('Narrow the filter');
  });

  it('a search that found some calls the count a floor, not a total', () => {
    const note = truncationNote({ shown: 12, total: 12, searching: true, searched: 20000 })!;
    expect(note).toContain(`Found 12 in the first ${n(20000)} rows`);
    expect(note).toContain('may be more further in');
  });

  it('falls back to vaguer wording when the number searched is unknown', () => {
    const note = truncationNote({ shown: 3, total: 3, searching: true })!;
    expect(note).toContain('the rows loaded so far');
    expect(note).not.toContain('undefined');
    expect(truncationNote({ shown: 3, total: 3, searching: true, searched: 0 })!).toContain('the rows loaded so far');
  });

  it('formats thousands and never shows a negative', () => {
    expect(truncationNote({ shown: 1234567, total: 1234567, searching: false })).toContain(n(1234567));
    expect(truncationNote({ shown: -5, total: -5, searching: false })).toContain('first 0 of 0+');
  });
});
