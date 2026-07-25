import { describe, expect, it } from 'vitest';
import { parseCsv, dedupeFields, readCsvHead } from './csv-import.js';

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

describe('parseCsv maxRows cap', () => {
  it('parses only the first maxRows data rows (header still drives the schema)', () => {
    const text = 'a,b\n1,2\n3,4\n5,6\n7,8\n';
    const { columns, rows } = parseCsv(text, { maxRows: 2 });
    expect(columns.map((c) => c.field)).toEqual(['a', 'b']);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it('returns everything when maxRows exceeds the row count', () => {
    const text = 'a,b\n1,2\n3,4\n';
    expect(parseCsv(text, { maxRows: 100 }).rows).toHaveLength(2);
  });
});

describe('readCsvHead (streamed prefix of a large CSV)', () => {
  const blob = (s: string) => new Blob([s]);

  it('returns the header plus exactly maxRows data rows', async () => {
    const text = 'a,b\n1,2\n3,4\n5,6\n7,8\n';
    const head = await readCsvHead(blob(text), 2);
    expect(parseCsv(head).rows).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it('does not cut a row on a newline inside a quoted field', async () => {
    // Row 1's "b" value contains a newline; it must count as ONE row, so
    // asking for 1 row returns the whole quoted cell intact.
    const text = 'a,b\n1,"line1\nline2"\n3,4\n5,6\n';
    const head = await readCsvHead(blob(text), 1);
    const { rows } = parseCsv(head);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ b: 'line1\nline2' });
  });

  it('returns the whole file when it has fewer rows than the cap', async () => {
    const text = 'a,b\n1,2\n3,4\n';
    const head = await readCsvHead(blob(text), 999);
    expect(parseCsv(head).rows).toHaveLength(2);
  });
});
