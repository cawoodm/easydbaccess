import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RowIssue } from '../../../packages/renderer/src/table/validate-rules.js';
import {
  clearRowErrors,
  ERROR_FIELD,
  ERROR_FILTER,
  errorColumnSpec,
  problemAt,
  rowErrorsFrom,
  rowErrorsOf,
  setRowErrors,
  watchRowErrors,
  __resetRowErrors,
  type RowErrors,
} from '../../../packages/renderer/src/table/row-errors.js';
import { matchesColumnFilter } from '../../../packages/shared/src/column-filter.js';

/**
 * What a Validate run leaves behind: one message per row for the `_error` column,
 * and one reason per offending CELL for the grid's mark and tooltip.
 */

function issue(rowId: string, field: string, label: string, reason: string): RowIssue {
  return { row: 1, rowId, key: rowId, field, label, value: '', kind: 'notnull', reason };
}

/** The registry takes any map of the right shape; tests only need messages. */
function errorsOf(pairs: Array<[string, string]>): RowErrors {
  return new Map(pairs.map(([id, message]) => [id, { message, fields: new Map() }]));
}

beforeEach(() => __resetRowErrors());

describe('rowErrorsFrom', () => {
  it('gives one message per row', () => {
    const map = rowErrorsFrom([issue('r1', 'name', 'Name', 'is empty')]);
    expect(map.get('r1')?.message).toBe('Name is empty');
  });

  it('joins several problems in one row, naming each column', () => {
    const map = rowErrorsFrom([issue('r1', 'name', 'Name', 'is empty'), issue('r1', 'age', 'Age', 'value 40 is over the maximum of 20')]);
    expect(map.get('r1')?.message).toBe('Name is empty · Age value 40 is over the maximum of 20');
  });

  it('keeps one reason per field, so the grid can mark the cell', () => {
    const map = rowErrorsFrom([issue('r1', 'name', 'Name', 'is empty'), issue('r1', 'age', 'Age', 'value 40 is over the maximum of 20')]);
    expect(map.get('r1')?.fields.get('name')).toBe('Name is empty');
    expect(map.get('r1')?.fields.get('age')).toBe('Age value 40 is over the maximum of 20');
  });

  it('joins two rules broken by the same cell', () => {
    const map = rowErrorsFrom([issue('r1', 'name', 'Name', 'is empty'), issue('r1', 'name', 'Name', 'is not an address')]);
    expect(map.get('r1')?.fields.get('name')).toBe('Name is empty · Name is not an address');
  });

  it('keeps rows apart', () => {
    const map = rowErrorsFrom([issue('r1', 'name', 'Name', 'is empty'), issue('r2', 'name', 'Name', 'duplicates Ada')]);
    expect(map.size).toBe(2);
    expect(map.get('r2')?.message).toBe('Name duplicates Ada');
  });

  it('is empty for no issues', () => {
    expect(rowErrorsFrom([]).size).toBe(0);
  });
});

describe('problemAt', () => {
  it('answers for the cell that is wrong, and only that one', () => {
    const errors = rowErrorsFrom([issue('r1', 'name', 'Name', 'is empty')]);
    expect(problemAt(errors, 'r1', 'name')).toBe('Name is empty');
    expect(problemAt(errors, 'r1', 'age')).toBeUndefined();
    expect(problemAt(errors, 'r2', 'name')).toBeUndefined();
  });

  it('answers nothing when no run has happened', () => {
    expect(problemAt(null, 'r1', 'name')).toBeUndefined();
  });
});

describe('the registry', () => {
  it('holds nothing until a run publishes', () => {
    expect(rowErrorsOf('t1')).toBeNull();
  });

  it('keeps tables apart', () => {
    setRowErrors('t1', errorsOf([['r1', 'Name is empty']]));
    expect(rowErrorsOf('t1')?.size).toBe(1);
    expect(rowErrorsOf('t2')).toBeNull();
  });

  it('replaces the previous run rather than adding to it', () => {
    setRowErrors(
      't1',
      errorsOf([
        ['r1', 'a'],
        ['r2', 'b'],
      ]),
    );
    setRowErrors('t1', errorsOf([['r2', 'b']]));
    expect([...rowErrorsOf('t1')!.keys()]).toEqual(['r2']);
  });

  it('treats an empty run as nothing found', () => {
    setRowErrors('t1', errorsOf([['r1', 'a']]));
    setRowErrors('t1', new Map());
    expect(rowErrorsOf('t1')).toBeNull();
  });

  it('tells a listener about a run, and about the clear', () => {
    const seen: Array<number | null> = [];
    watchRowErrors('t1', (e) => seen.push(e ? e.size : null));
    setRowErrors('t1', errorsOf([['r1', 'a']]));
    clearRowErrors('t1');
    expect(seen).toEqual([1, null]);
  });

  it('says nothing to a listener on another table', () => {
    const fn = vi.fn();
    watchRowErrors('t2', fn);
    setRowErrors('t1', errorsOf([['r1', 'a']]));
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
    setRowErrors('t1', errorsOf([['r1', 'a']]));
    expect(fn).not.toHaveBeenCalled();
  });

  it('carries on when one listener throws', () => {
    const good = vi.fn();
    watchRowErrors('t1', () => {
      throw new Error('broken');
    });
    watchRowErrors('t1', good);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setRowErrors('t1', errorsOf([['r1', 'a']]));
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('the column it creates', () => {
  it('is hidden, because the marked cell says it in place', () => {
    expect(errorColumnSpec().hidden).toBe(true);
  });

  it('is text, so its funnel offers no value list', () => {
    // Every message is different: a value list would be one option per row.
    expect(errorColumnSpec().type).toBe('text');
  });

  it('is NOT read-only, or a rename would hand over a column nobody can edit', () => {
    // The columns editor keeps a column's untouched fields through a save, so
    // `readonly` would follow the field to its new name.
    expect(errorColumnSpec().readonly).toBeUndefined();
  });

  it('is the field the filter narrows on', () => {
    const rows = [{ [ERROR_FIELD]: 'Name is empty' }, { [ERROR_FIELD]: '' }, {}];
    const kept = rows.filter((d) => matchesColumnFilter(d[ERROR_FIELD], ERROR_FILTER));
    expect(kept).toEqual([{ [ERROR_FIELD]: 'Name is empty' }]);
  });
});
