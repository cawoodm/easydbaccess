import { describe, it, expect } from 'vitest';
import type { ColumnSpec, Row } from '@easydb/shared';
import {
  extractTokens,
  substituteRow,
  filterRows,
  sortRows,
  viewRows,
  hasRowHtml,
} from './view-render.js';

const row = (data: Record<string, unknown>): Row => ({ id: 'r', tableId: 't', data, updatedAt: 0 });
const col = (field: string, type: ColumnSpec['type'], label?: string): ColumnSpec => ({
  field,
  label: label ?? field,
  type,
});

describe('view-render', () => {
  it('extracts distinct tokens across fragments', () => {
    expect(extractTokens('<a href="$URL">$TITLE</a>', '', 'foot $DATE $TITLE').sort()).toEqual([
      'DATE',
      'TITLE',
      'URL',
    ]);
  });

  it('ignores a $ not followed by a word (e.g. prices)', () => {
    expect(extractTokens('costs $5.00 today')).toEqual([]);
  });

  it('substitutes mapped tokens and blanks unmapped/null ones', () => {
    const html = '<a href="$URL">$TITLE</a>$MISSING';
    const out = substituteRow(html, row({ t: 'Hi', u: 'http://x' }), { TITLE: 't', URL: 'u' });
    expect(out).toBe('<a href="http://x">Hi</a>');
  });

  it('extractTokens strips the input. prefix so $X and $input.X share one key', () => {
    expect(extractTokens('$input.CHECK1 $input:CHECK2 $TITLE $input.TITLE').sort()).toEqual([
      'CHECK1',
      'CHECK2',
      'TITLE',
    ]);
  });

  it('renders a checked, wired checkbox for an $input.TOKEN over a boolean field', () => {
    const cols = new Map([['read', col('read', 'boolean', 'Read?')]]);
    const out = substituteRow('$input.MARKREAD', row({ read: true }), { MARKREAD: 'read' }, { columns: cols });
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('class="eda-input"');
    expect(out).toContain('data-eda-row="r"');
    expect(out).toContain('data-eda-field="read"');
    expect(out).toContain('data-eda-type="boolean"');
    expect(out).toContain(' checked');
    expect(out).not.toContain('disabled');
    expect(out).toContain('Read?'); // caption from the column label
  });

  it('leaves the checkbox unchecked for falsy values and honours readonly (disabled)', () => {
    const cols = new Map([['read', col('read', 'boolean')]]);
    const off = substituteRow('$input.R', row({ read: 0 }), { R: 'read' }, { columns: cols });
    expect(off).not.toContain(' checked');
    const ro = substituteRow('$input.R', row({ read: true }), { R: 'read' }, { columns: cols, readonly: true });
    expect(ro).toContain('disabled');
  });

  it('renders number/text inputs for non-boolean $input.TOKENs, escaping the value', () => {
    const cols = new Map([
      ['qty', col('qty', 'number')],
      ['note', col('note', 'string')],
    ]);
    const num = substituteRow('$input.N', row({ qty: 5 }), { N: 'qty' }, { columns: cols });
    expect(num).toContain('type="number"');
    expect(num).toContain('value="5"');
    const txt = substituteRow('$input.T', row({ note: 'a "b" <c>' }), { T: 'note' }, { columns: cols });
    expect(txt).toContain('type="text"');
    expect(txt).toContain('value="a &quot;b&quot; &lt;c&gt;"');
  });

  it('a plain (non-input) token still renders the read-only value even with columns provided', () => {
    const cols = new Map([['read', col('read', 'boolean')]]);
    const out = substituteRow('$READ', row({ read: true }), { READ: 'read' }, { columns: cols });
    expect(out).toBe('true');
  });

  it('an unmapped $input.TOKEN renders nothing', () => {
    expect(substituteRow('$input.NOPE', row({}), {}, {})).toBe('');
  });

  it('filters case-insensitively and ANDs multiple columns', () => {
    const rows = [row({ a: 'Apple', b: 'red' }), row({ a: 'Banana', b: 'yellow' })];
    expect(filterRows(rows, { a: 'app' })).toHaveLength(1);
    expect(filterRows(rows, { a: 'a', b: 'zzz' })).toHaveLength(0);
    expect(filterRows(rows, {})).toHaveLength(2);
  });

  it('sorts empties to the bottom in BOTH directions', () => {
    const rows = [row({ n: 2 }), row({ n: null }), row({ n: 1 })];
    expect(sortRows(rows, 'n', true).map((r) => r.data.n)).toEqual([1, 2, null]);
    expect(sortRows(rows, 'n', false).map((r) => r.data.n)).toEqual([2, 1, null]);
  });

  it('viewRows filters then sorts', () => {
    const rows = [row({ n: 3, k: 'x' }), row({ n: 1, k: 'y' }), row({ n: 2, k: 'x' })];
    const out = viewRows(rows, { filters: { k: 'x' }, sortColumn: 'n', sortAsc: true });
    expect(out.map((r) => r.data.n)).toEqual([2, 3]);
  });

  it('hasRowHtml treats whitespace as empty', () => {
    expect(hasRowHtml('   \n')).toBe(false);
    expect(hasRowHtml(undefined)).toBe(false);
    expect(hasRowHtml('<div>$X</div>')).toBe(true);
  });
});
