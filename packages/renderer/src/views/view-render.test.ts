import { describe, it, expect } from 'vitest';
import type { ColumnSpec, Row } from '@easydb/shared';
import {
  extractTokens,
  substituteRow,
  filterRows,
  sortRows,
  viewRows,
  hasRowHtml,
  addPillValue,
  removePillValue,
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

  it('extractTokens finds filter.-prefixed tokens under the bare name', () => {
    expect(extractTokens('$filter.TAG $filter:STATUS $TAG').sort()).toEqual(['STATUS', 'TAG']);
  });

  it('$filter.TOKEN renders a clickable pill with field/value data attributes', () => {
    const out = substituteRow('$filter.TAG', row({ tag: 'foo' }), { TAG: 'tag' });
    expect(out).toContain('class="eda-filter-pill"');
    expect(out).toContain('data-eda-filter-field="tag"');
    expect(out).toContain('data-eda-filter-value="foo"');
    expect(out).toContain('>foo</button>');
    expect(out).toContain('<button type="button"');
  });

  it('$filter.TOKEN escapes the field/value attributes and text', () => {
    const out = substituteRow('$filter.TAG', row({ tag: '"><script>' }), { TAG: 'tag' });
    expect(out).not.toContain('"><script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('a null/empty value renders no pill at all', () => {
    expect(substituteRow('$filter.TAG', row({ tag: null }), { TAG: 'tag' })).toBe('');
    expect(substituteRow('$filter.TAG', row({ tag: '' }), { TAG: 'tag' })).toBe('');
    expect(substituteRow('$filter.NOPE', row({}), {})).toBe('');
  });

  it('$TOKEN and $input.TOKEN rendering is unchanged', () => {
    expect(substituteRow('$TAG', row({ tag: 'foo' }), { TAG: 'tag' })).toBe('foo');
    const cols = new Map([['tag', col('tag', 'string')]]);
    expect(substituteRow('$input.TAG', row({ tag: 'foo' }), { TAG: 'tag' }, { columns: cols })).toContain(
      'type="text"',
    );
  });

  describe('addPillValue / removePillValue', () => {
    it('addPillValue appends an exact-match token', () => {
      expect(addPillValue(undefined, 'foo')).toBe('=foo');
      expect(addPillValue('', 'foo')).toBe('=foo');
    });

    it('addPillValue OR-appends a second value on the same field', () => {
      expect(addPillValue('=foo', 'bar')).toBe('=foo,=bar');
    });

    it('addPillValue is idempotent — clicking the same value twice leaves one token', () => {
      expect(addPillValue('=foo', 'foo')).toBe('=foo');
      expect(addPillValue('=foo,=bar', 'Foo')).toBe('=foo,=bar'); // case-insensitive
    });

    it('addPillValue preserves tokens already present', () => {
      expect(addPillValue('=foo', 'bar')).toBe('=foo,=bar');
    });

    it('removePillValue removes one token, case-insensitively', () => {
      expect(removePillValue('=foo,=bar', 'foo')).toBe('=bar');
      expect(removePillValue('=foo,=bar', 'BAR')).toBe('=foo');
    });

    it('removePillValue returns empty string when nothing is left', () => {
      expect(removePillValue('=foo', 'foo')).toBe('');
      expect(removePillValue(undefined, 'foo')).toBe('');
    });
  });

  it('viewRows ANDs the filters and pillFilters layers, then sorts', () => {
    const rows = [
      row({ n: 3, k: 'x', tag: 'a' }),
      row({ n: 1, k: 'y', tag: 'a' }),
      row({ n: 2, k: 'x', tag: 'b' }),
      row({ n: 4, k: 'x', tag: 'a' }),
    ];
    const out = viewRows(rows, {
      filters: { k: 'x' },
      pillFilters: { tag: '=a' },
      sortColumn: 'n',
      sortAsc: true,
    });
    expect(out.map((r) => r.data.n)).toEqual([3, 4]);
  });
});
