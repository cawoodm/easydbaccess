import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Row } from '../../../packages/shared/src/types.js';
import type { RowIssue } from '../../../packages/renderer/src/table/validate-rules.js';
import { clearRowErrors, decorateRows, ERROR_FIELD, ERROR_FILTER, errorColumnSpec, rowErrorsFrom, rowErrorsOf, setRowErrors, watchRowErrors, __resetRowErrors } from '../../../packages/renderer/src/table/row-errors.js';
import { matchesColumnFilter } from '../../../packages/shared/src/column-filter.js';

/**
 * What a Validate run leaves behind: one message per row, held per table, merged
 * into rows on their way to the screen and never written to the store.
 */

function issue(rowId: string, label: string, reason: string): RowIssue {
  return { row: 1, rowId, key: rowId, field: label.toLowerCase(), label, value: '', kind: 'notnull', reason };
}

function row(id: string, data: Record<string, unknown> = {}): Row {
  return { id, tableId: 't1', data, updatedAt: 0 };
}

beforeEach(() => __resetRowErrors());

describe('rowErrorsFrom', () => {
  it('gives one message per row', () => {
    const map = rowErrorsFrom([issue('r1', 'Name', 'is empty')]);
    expect([...map]).toEqual([['r1', 'Name is empty']]);
  });

  it('joins several problems in one row, naming each column', () => {
    const map = rowErrorsFrom([issue('r1', 'Name', 'is empty'), issue('r1', 'Age', 'value 40 is over the maximum of 20')]);
    expect(map.get('r1')).toBe('Name is empty · Age value 40 is over the maximum of 20');
  });

  it('keeps rows apart', () => {
    const map = rowErrorsFrom([issue('r1', 'Name', 'is empty'), issue('r2', 'Name', 'duplicates Ada')]);
    expect(map.size).toBe(2);
    expect(map.get('r2')).toBe('Name duplicates Ada');
  });

  it('is empty for no issues', () => {
    expect(rowErrorsFrom([]).size).toBe(0);
  });
});

describe('the registry', () => {
  it('holds nothing until a run publishes', () => {
    expect(rowErrorsOf('t1')).toBeNull();
  });

  it('keeps tables apart', () => {
    setRowErrors('t1', new Map([['r1', 'Name is empty']]));
    expect(rowErrorsOf('t1')?.size).toBe(1);
    expect(rowErrorsOf('t2')).toBeNull();
  });

  it('replaces the previous run rather than adding to it', () => {
    setRowErrors('t1', new Map([['r1', 'a'], ['r2', 'b']]));
    setRowErrors('t1', new Map([['r2', 'b']]));
    expect([...rowErrorsOf('t1')!.keys()]).toEqual(['r2']);
  });

  it('treats an empty run as nothing found', () => {
    setRowErrors('t1', new Map([['r1', 'a']]));
    setRowErrors('t1', new Map());
    expect(rowErrorsOf('t1')).toBeNull();
  });

  it('tells a listener about a run, and about the clear', () => {
    const seen: Array<number | null> = [];
    watchRowErrors('t1', (e) => seen.push(e ? e.size : null));
    setRowErrors('t1', new Map([['r1', 'a']]));
    clearRowErrors('t1');
    expect(seen).toEqual([1, null]);
  });

  it('says nothing to a listener on another table', () => {
    const fn = vi.fn();
    watchRowErrors('t2', fn);
    setRowErrors('t1', new Map([['r1', 'a']]));
    expect(fn).not.toHaveBeenCalled();
  });

  it('says nothing on a clear that clears nothing', () => {
    const fn = vi.fn();
    watchRowErrors('t1', fn);
    clearRowErrors('t1');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops talking to a released listener', () => {
    const fn = vi.fn();
    const off = watchRowErrors('t1', fn);
    off();
    setRowErrors('t1', new Map([['r1', 'a']]));
    expect(fn).not.toHaveBeenCalled();
  });

  it('carries on when one listener throws', () => {
    const good = vi.fn();
    watchRowErrors('t1', () => {
      throw new Error('broken');
    });
    watchRowErrors('t1', good);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setRowErrors('t1', new Map([['r1', 'a']]));
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('decorateRows', () => {
  it('returns the rows untouched when there is nothing to say', () => {
    const rows = [row('r1')];
    expect(decorateRows(rows, null)).toBe(rows);
    expect(decorateRows(rows, new Map())).toBe(rows);
  });

  it('puts the message in `_error`', () => {
    const out = decorateRows([row('r1', { name: 'Ada' })], new Map([['r1', 'Name is empty']]));
    expect(out[0]!.data[ERROR_FIELD]).toBe('Name is empty');
    // The row's own fields are still there — a script reading `row.name` beside
    // `row._error` is the point of the field being on the row at all.
    expect(out[0]!.data.name).toBe('Ada');
  });

  it('gives a row with nothing wrong an empty `_error`, not a missing one', () => {
    const out = decorateRows([row('r1'), row('r2')], new Map([['r1', 'Name is empty']]));
    expect(out[1]!.data[ERROR_FIELD]).toBe('');
  });

  it('never writes into the row it was given', () => {
    // The store hands out rows that other holders (a live subscription, a docked
    // pane) share. Stamping a field into one would be the persistence this whole
    // module exists to avoid.
    const original = row('r1', { name: 'Ada' });
    decorateRows([original], new Map([['r1', 'Name is empty']]));
    expect(ERROR_FIELD in original.data).toBe(false);
  });
});

describe('the column and its filter', () => {
  it('is text, so its funnel offers no value list', () => {
    // Every message is different: a value list would be one option per row.
    expect(errorColumnSpec().type).toBe('text');
  });

  it('is read-only, because a message is derived', () => {
    expect(errorColumnSpec().readonly).toBe(true);
  });

  it('filters to exactly the rows with a message', () => {
    const rows = decorateRows([row('r1'), row('r2')], new Map([['r1', 'Name is empty']]));
    const kept = rows.filter((r) => matchesColumnFilter(r.data[ERROR_FIELD], ERROR_FILTER));
    expect(kept.map((r) => r.id)).toEqual(['r1']);
  });
});
