import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row, Table } from '../../../packages/shared/src/types.js';
import { serializeCsv, typedHeaderCell } from '../../../packages/renderer/src/plugins/csv-export.js';
import { parseCsv } from '../../../packages/renderer/src/plugins/csv-import.js';

/**
 * The CSV writer and the options the export dialog's CSV panel offers.
 *
 * The typed header is the one worth reading twice: it writes csv-import's own header
 * mini-language, so a file exported and imported again comes back with the types it
 * left with instead of whatever inference guesses from the values.
 */

const COLUMNS: ColumnSpec[] = [
  { field: 'name', label: 'Name', type: 'string' },
  { field: 'qty', label: 'Qty', type: 'number' },
];

function table(over: Partial<Table> = {}): Table {
  return { id: 't1', workspaceId: 'w1', name: 'Stock', code: 'stock', columns: COLUMNS, createdAt: 1, updatedAt: 1, ...over } as Table;
}

function rows(data: Array<Record<string, unknown>>): Row[] {
  return data.map((d, i) => ({ id: `r${i}`, tableId: 't1', data: d, updatedAt: 1 }));
}

const TWO = rows([
  { name: 'Pear', qty: 3 },
  { name: 'Apple', qty: 10 },
]);

describe('serializeCsv — defaults', () => {
  it('writes labels and CRLF, as it always did', () => {
    // The two-argument call is what `table-copy`, the Gist push and the older tests
    // use. Its output must not move.
    expect(serializeCsv(table(), TWO)).toBe('Name,Qty\r\nPear,3\r\nApple,10');
  });

  it('quotes only what has to be quoted', () => {
    const out = serializeCsv(table(), rows([{ name: 'Pear, ripe', qty: 3 }]));
    expect(out).toContain('"Pear, ripe",3');
  });

  it('doubles a quote inside a cell', () => {
    const out = serializeCsv(table(), rows([{ name: 'a "b" c', qty: 1 }]));
    expect(out).toContain('"a ""b"" c"');
  });
});

describe('serializeCsv — the panel options', () => {
  it('uses the chosen separator', () => {
    expect(serializeCsv(table(), TWO, { separator: ';' })).toBe('Name;Qty\r\nPear;3\r\nApple;10');
  });

  it('quotes by the CHOSEN separator, not by a comma', () => {
    // With `;` picked, a cell holding a comma needs no quotes and one holding a
    // semicolon does. Testing the comma case is what catches a hard-coded delimiter.
    const out = serializeCsv(table(), rows([{ name: 'Pear, ripe', qty: 3 }]), { separator: ';' });
    expect(out).toContain('Pear, ripe;3');
    const other = serializeCsv(table(), rows([{ name: 'a;b', qty: 3 }]), { separator: ';' });
    expect(other).toContain('"a;b";3');
  });

  it('writes a tab separator', () => {
    expect(serializeCsv(table(), TWO, { separator: '\t' })).toContain('Pear\t3');
  });

  it('drops the header row when asked', () => {
    expect(serializeCsv(table(), TWO, { header: false })).toBe('Pear,3\r\nApple,10');
  });

  it('prefixes a byte-order mark when asked', () => {
    const out = serializeCsv(table(), TWO, { bom: true });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(serializeCsv(table(), TWO, { bom: false }).charCodeAt(0)).not.toBe(0xfeff);
  });

  it('writes LF line ends when CRLF is off', () => {
    expect(serializeCsv(table(), TWO, { crlf: false })).toBe('Name,Qty\nPear,3\nApple,10');
  });
});

describe('typedHeaderCell', () => {
  it('writes field:label:type', () => {
    expect(typedHeaderCell({ field: 'qty', label: 'Qty', type: 'number' })).toBe('qty:Qty:number');
  });

  it('drops the trailing empty parts rather than writing colons', () => {
    expect(typedHeaderCell({ field: 'name', label: 'name', type: 'string' })).toBe('name:name:string');
  });

  it('carries the constraints as flags', () => {
    expect(typedHeaderCell({ field: 'id', label: 'Id', type: 'string', unique: true, notnull: true, hidden: true })).toBe('id:Id:string:::unh');
  });

  it('carries a default and a max', () => {
    expect(typedHeaderCell({ field: 'qty', label: 'Qty', type: 'number', default: 0, max: 99 })).toBe('qty:Qty:number:0:99');
  });

  it('leaves out a label holding a colon, which the grammar cannot carry', () => {
    // A colon in the label would be read back as the next part of the spec, so the
    // field name carries the column instead of a label that would corrupt the parse.
    expect(typedHeaderCell({ field: 'time', label: 'Start: local', type: 'string' })).toBe('time::string');
  });
});

describe('a typed header round-trips through csv-import', () => {
  it('restores the types instead of inferring them', () => {
    const t = table({
      columns: [
        { field: 'code', label: 'Code', type: 'string' },
        { field: 'qty', label: 'Qty', type: 'number' },
        { field: 'when', label: 'When', type: 'date' },
      ] as ColumnSpec[],
    });
    // Values that would infer differently: "007" reads as a number without the type.
    const csv = serializeCsv(t, rows([{ code: '007', qty: 3, when: '2026-08-13' }]), { typedHeader: true });
    const parsed = parseCsv(csv, {});
    expect(parsed.columns.map((c) => [c.field, c.type])).toEqual([
      ['code', 'string'],
      ['qty', 'number'],
      ['when', 'date'],
    ]);
  });

  it('restores hidden and unique from the flags', () => {
    const t = table({
      columns: [
        { field: 'id', label: 'Id', type: 'string', unique: true },
        { field: 'note', label: 'Note', type: 'string', hidden: true },
      ] as ColumnSpec[],
    });
    const parsed = parseCsv(serializeCsv(t, rows([{ id: 'a', note: 'n' }]), { typedHeader: true }), {});
    expect(parsed.columns[0]?.unique).toBe(true);
    expect(parsed.columns[1]?.hidden).toBe(true);
  });

  it('a plain header gives inference, which is the point of the option', () => {
    const t = table({ columns: [{ field: 'code', label: 'Code', type: 'string' }] as ColumnSpec[] });
    const parsed = parseCsv(serializeCsv(t, rows([{ code: '007' }]), { typedHeader: false }), {});
    expect(parsed.columns[0]?.type).toBe('number');
  });
});
