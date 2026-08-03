import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  parseCsvRaw,
  dedupeFields,
  readCsvHead,
  separatorForName,
  stripDelimitedExt,
} from '../../../packages/renderer/src/plugins/csv-import.js';

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

// -- Type inference (inferType() is module-private; exercised via parseCsv's
// -- resulting column types + coerced cell values, since no header pins a type). --

describe('parseCsv: type inference', () => {
  it('infers "number" when every non-empty sample parses as a finite number', () => {
    const { columns, rows } = parseCsv('n\n1\n2.5\n-3\n');
    expect(columns[0]).toMatchObject({ field: 'n', type: 'number' });
    expect(rows).toEqual([{ n: 1 }, { n: 2.5 }, { n: -3 }]);
  });

  it('infers "boolean" for true/false/yes/no/0/1 (case-insensitive)', () => {
    const { columns, rows } = parseCsv('b\ntrue\nFALSE\nyes\nNo\n1\n0\n');
    expect(columns[0]).toMatchObject({ field: 'b', type: 'boolean', renderer: 'boolean' });
    expect(rows.map((r) => r.b)).toEqual([true, false, true, false, true, false]);
  });

  it('infers "date" for ISO and D/M/Y forms, normalizing to YYYY-MM-DD', () => {
    const { columns, rows } = parseCsv('d\n2024-01-05\n17/03/2024\n');
    expect(columns[0]).toMatchObject({ field: 'd', type: 'date', renderer: 'date' });
    expect(rows.map((r) => r.d)).toEqual(['2024-01-05', '2024-03-17']);
  });

  it('infers "datetime" only when a time component follows the date', () => {
    const { columns, rows } = parseCsv('dt\n2024-01-05 09:30\n2024-01-06T14:00:00\n');
    expect(columns[0]).toMatchObject({ field: 'dt', type: 'datetime', renderer: 'datetime' });
    expect(rows.map((r) => r.dt)).toEqual(['2024-01-05T09:30', '2024-01-06T14:00']);
  });

  it('infers "number" (not "date") for a column of bare-integer strings', () => {
    // isDate() explicitly rejects all-digit strings so a column of years/IDs
    // doesn't become 'date' — but isNumber() is checked first and DOES accept
    // them, so the column ends up 'number', not 'string'. Leading zeros are
    // therefore lost on coercion (a real, if unsurprising, lossy conversion).
    const { columns, rows } = parseCsv('id\n12345\n067890\n');
    expect(columns[0]).toMatchObject({ field: 'id', type: 'number' });
    expect(rows.map((r) => r.id)).toEqual([12345, 67890]);
  });

  it('falls back to "string" for a column with mixed number/non-number samples', () => {
    const { columns, rows } = parseCsv('v\n1\ntwo\n3\n');
    expect(columns[0]).toMatchObject({ field: 'v', type: 'string' });
    expect(rows.map((r) => r.v)).toEqual(['1', 'two', '3']);
  });

  it('falls back to "string" for an ambiguous column mixing booleans and numbers', () => {
    // "1"/"0" alone would be boolean-eligible, but a literal "true" mixed with
    // a non-boolean-shaped number like "2" cannot satisfy either inference.
    const { columns } = parseCsv('v\ntrue\n2\n');
    expect(columns[0]).toMatchObject({ field: 'v', type: 'string' });
  });

  it('defaults to "string" when every sample is empty', () => {
    // A single-column all-blank CSV can't be used here: parseCsv drops any
    // data row that tokenizes to exactly one empty cell (treated as a blank
    // line), which would swallow the rows before inference even runs. Use a
    // second populated column so the empty-valued rows survive that filter.
    const { columns, rows } = parseCsv('v,other\n,x\n,y\n');
    expect(columns[0]).toMatchObject({ field: 'v', type: 'string' });
    expect(rows.map((r) => r.v)).toEqual(['', '']);
  });

  it('an explicit header type annotation overrides inference', () => {
    const { columns, rows } = parseCsv('id:ID:string\n007\n042\n');
    expect(columns[0]).toMatchObject({ field: 'id', type: 'string' });
    // The annotation has to reach the VALUES, not only the column meta: a
    // leading-zero id that came out as a number would have lost its zero.
    expect(rows).toEqual([{ id: '007' }, { id: '042' }]);
    // Without the annotation these bare-integer strings would still infer to
    // "string" anyway (isDate rejects them) — use a value that WOULD infer
    // differently to prove the annotation, not the inference, is in control.
    const forced = parseCsv('n:N:string\n1\n2\n');
    expect(forced.columns[0]).toMatchObject({ type: 'string' });
    expect(forced.rows.map((r) => r.n)).toEqual(['1', '2']);
  });
});

// -- RFC-4180 edge cases -------------------------------------------------------

describe('parseCsv: RFC-4180 quoting edge cases', () => {
  it('unescapes doubled quotes ("") inside a quoted field', () => {
    const text = 'a,b\n"He said ""hi""",2\n';
    const { rows } = parseCsv(text);
    expect(rows).toEqual([{ a: 'He said "hi"', b: 2 }]);
  });

  it('treats commas inside a quoted field as literal, not separators', () => {
    const text = 'a,b\n"1,2,3",4\n';
    const { rows } = parseCsv(text);
    expect(rows).toEqual([{ a: '1,2,3', b: 4 }]);
  });

  it('handles CRLF line endings without introducing blank rows or stray \\r', () => {
    const text = 'a,b\r\n1,2\r\n3,4\r\n';
    const { columns, rows } = parseCsv(text);
    expect(columns.map((c) => c.field)).toEqual(['a', 'b']);
    expect(rows).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it('keeps a newline embedded in a quoted field as part of that one cell', () => {
    const text = 'a,b\n1,"line1\nline2"\n3,4\n';
    const { rows } = parseCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: 1, b: 'line1\nline2' });
    // Column "b" is inferred as one type for the whole column: since row 1's
    // value is non-numeric text, "b" infers "string" overall, so row 2's "4"
    // stays an uncoerced string rather than becoming a number.
    expect(rows[1]).toEqual({ a: 3, b: '4' });
  });

  it('handles a quoted field containing a CRLF newline', () => {
    const text = 'a,b\n1,"line1\r\nline2"\n3,4\n';
    const { rows } = parseCsv(text);
    expect(rows).toHaveLength(2);
    // The bare \r inside the quoted run is not treated as a row terminator
    // (that only fires outside quotes), so it is preserved verbatim in the cell.
    expect(rows[0]).toEqual({ a: 1, b: 'line1\r\nline2' });
  });

  it('parseCsvRaw applies the same quoting rules with no type coercion', () => {
    const text = 'a,b\n"x,""y""",2\n';
    const { header, rows } = parseCsvRaw(text);
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['x,"y"', '2']]);
  });
});

describe('TSV support', () => {
  it('auto-detects tabs when they outnumber other separators', () => {
    const text = 'name\tage\nAda\t36\nGrace\t45\n';
    const { columns, rows } = parseCsv(text);
    expect(columns.map((c) => c.field)).toEqual(['name', 'age']);
    expect(rows).toEqual([
      { name: 'Ada', age: 36 },
      { name: 'Grace', age: 45 },
    ]);
  });

  it('an explicit tab separator wins over a comma-heavy sample', () => {
    // A real TSV risk: the cells hold more commas than the row holds tabs, so
    // auto-detection picks the comma and the whole row collapses into one cell.
    const text = 'name\tnote\nAda\tone, two, three\nGrace\tfour, five, six\n';
    expect(parseCsv(text).columns).toHaveLength(1); // auto-detect gets it wrong
    const { columns, rows } = parseCsv(text, { separator: '\t' });
    expect(columns.map((c) => c.field)).toEqual(['name', 'note']);
    expect(rows[0]).toEqual({ name: 'Ada', note: 'one, two, three' });
  });

  it('parseCsvRaw honors an explicit separator too', () => {
    const { header, rows } = parseCsvRaw('a\tb\n1\t2,3\n', { separator: '\t' });
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['1', '2,3']]);
  });

  it('separatorForName pins TAB only for .tsv/.tab names', () => {
    expect(separatorForName('data.tsv')).toBe('\t');
    expect(separatorForName('DATA.TAB')).toBe('\t');
    expect(separatorForName('data.csv')).toBeUndefined();
    expect(separatorForName('data.txt')).toBeUndefined();
  });

  it('stripDelimitedExt drops a csv/tsv/tab extension only', () => {
    expect(stripDelimitedExt('sales.tsv')).toBe('sales');
    expect(stripDelimitedExt('sales.CSV')).toBe('sales');
    expect(stripDelimitedExt('sales.tab')).toBe('sales');
    expect(stripDelimitedExt('sales.json')).toBe('sales.json');
    expect(stripDelimitedExt('my.data.tsv')).toBe('my.data');
  });
});

describe('integers too big for a JS number', () => {
  // A snowflake id: `Number('1298624375692894210')` is …894200, so importing it
  // as a number silently changes the id. Such a column is text.
  const BIG = '1298624375692894210';

  it('types a column of big ids as string and keeps every digit', () => {
    const { columns, rows } = parseCsv(`id\n${BIG}\n9007199254740993\n`);
    expect(columns[0]).toMatchObject({ field: 'id', type: 'string' });
    expect(rows.map((r) => r.id)).toEqual([BIG, '9007199254740993']);
  });

  it('still types ordinary integers as number', () => {
    const { columns, rows } = parseCsv('n\n1\n9007199254740991\n');
    expect(columns[0]).toMatchObject({ type: 'number' });
    expect(rows.map((r) => r.n)).toEqual([1, 9007199254740991]);
  });

  it('keeps the digits even when the header pins the column to number', () => {
    const { rows } = parseCsv(`id:ID:number\n${BIG}\n`);
    expect(rows[0]!.id).toBe(BIG);
  });

  it('one big id in a column of small ones makes the whole column text', () => {
    // Mixed is the common case (ids grow over time) and a per-cell decision
    // would give one column two types.
    const { columns } = parseCsv(`id\n1\n${BIG}\n`);
    expect(columns[0]).toMatchObject({ type: 'string' });
  });
});
