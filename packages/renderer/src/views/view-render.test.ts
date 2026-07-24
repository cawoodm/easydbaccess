import { describe, it, expect } from 'vitest';
import type { Row } from '@easydb/shared';
import {
  extractTokens,
  substituteRow,
  filterRows,
  sortRows,
  viewRows,
  hasRowHtml,
} from './view-render.js';

const row = (data: Record<string, unknown>): Row => ({ id: 'r', tableId: 't', data, updatedAt: 0 });

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
