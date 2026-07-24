import { describe, expect, it } from 'vitest';
import { parseCsv, dedupeFields } from './csv-import.js';

describe('dedupeFields', () => {
  it('suffixes repeats in first-seen order, leaving the first untouched', () => {
    expect(dedupeFields(['tm', 'tm', 'tm'])).toEqual(['tm', 'tm_2', 'tm_3']);
    expect(dedupeFields(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'a_2', 'c', 'b_2']);
  });

  it('avoids colliding with an existing literal suffix', () => {
    // "x" appears twice → the 2nd wants "x_2", but "x_2" already exists → "x_3".
    expect(dedupeFields(['x', 'x_2', 'x'])).toEqual(['x', 'x_2', 'x_3']);
  });
});

describe('parseCsv with colliding header slugs', () => {
  it('keeps every column and every value when headers slug to the same field', () => {
    // The real air-quality header: "TM" and "Tm" both slug to "tm".
    const text = 'T,TM,Tm\n16.9,25.1,6.6\n17.0,26.0,7.0\n';
    const { columns, rows } = parseCsv(text);

    // Three distinct columns survive (no clobbering).
    expect(columns.map((c) => c.field)).toEqual(['t', 'tm', 'tm_2']);
    // Labels keep the original header text so the collision is still readable.
    expect(columns.map((c) => c.label)).toEqual(['T', 'TM', 'Tm']);

    // Both formerly-colliding values are preserved on their own keys.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ t: 16.9, tm: 25.1, tm_2: 6.6 });
  });
});
