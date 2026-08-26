import { describe, expect, it } from 'vitest';
import { clampPreviewHeight, previewCells, previewText, PREVIEW_HEIGHT_DEFAULT, PREVIEW_ROWS } from '../../../packages/renderer/src/table/column-preview.js';
import type { ColumnSpec, Row } from '../../../packages/shared/src/types.js';

/**
 * What a column editor's preview shows per cell.
 *
 * The first version of this showed the STORED value as plain text and checked it
 * against a hand-rolled copy of the constraint rules. So a scripted column
 * previewed blank, a `validate` script edited two clicks away never ran, and
 * `max` had a second definition waiting to drift from the real one.
 */

const col = (over: Partial<ColumnSpec> & { field: string }): ColumnSpec => ({ label: over.field, type: 'string', ...over });

const row = (id: string, data: Record<string, unknown>): Row => ({ id, tableId: 't', data, updatedAt: 0 });

describe('previewCells', () => {
  it('shows the stored value when the column has no script', () => {
    const cells = previewCells([col({ field: 'a' })], [row('1', { a: 'hi' })]);
    expect(cells[0]?.[0]).toEqual({ value: 'hi', raw: 'hi', error: null, problem: null });
  });

  it('runs the column script, so a derived column previews what the grid will draw', () => {
    const cols = [col({ field: 'n', type: 'number' }), col({ field: 'double', type: 'number', script: 'function render(row) { return row.n * 2; }' })];
    const cells = previewCells(cols, [row('1', { n: 21 })]);
    expect(cells[0]?.[1]?.value).toBe(42);
    // The stored cell travels alongside, for a renderer whose editor writes there.
    expect(cells[0]?.[1]?.raw).toBeUndefined();
  });

  it('reports a script that throws per row, and leaves the other rows alone', () => {
    const cols = [col({ field: 'n', type: 'number' }), col({ field: 'd', script: 'function render(row) { if (row.n > 5) throw new Error("too big"); return row.n; }' })];
    const cells = previewCells(cols, [row('1', { n: 1 }), row('2', { n: 9 })]);
    expect(cells[0]?.[1]?.error).toBeNull();
    expect(cells[0]?.[1]?.value).toBe(1);
    expect(cells[1]?.[1]?.error).toContain('too big');
  });

  it('does not also flag a rule on a cell whose script failed: there is no value to judge', () => {
    const cols = [col({ field: 'd', notnull: true, script: 'function render() { throw new Error("nope"); }' })];
    const cells = previewCells(cols, [row('1', {})]);
    expect(cells[0]?.[0]?.error).toContain('nope');
    expect(cells[0]?.[0]?.problem).toBeNull();
  });

  it('checks the rules against the COMPUTED value, not the stored one', () => {
    // The stored cell is empty — every scripted column's is — so a notnull check
    // on the stored value would call every row of every scripted column empty.
    const cols = [col({ field: 'n', type: 'number' }), col({ field: 'd', notnull: true, script: 'function render(row) { return row.n > 0 ? "ok" : ""; }' })];
    const cells = previewCells(cols, [row('1', { n: 1 }), row('2', { n: 0 })]);
    expect(cells[0]?.[1]?.problem).toBeNull();
    expect(cells[1]?.[1]?.problem).toBe('d is empty');
  });

  it('runs the validate script — the one rule the old preview ignored', () => {
    const cols = [col({ field: 'n', type: 'number', validate: 'function validate(value) { if (value > 5) throw new Error("must be 5 or less"); }' })];
    const cells = previewCells(cols, [row('1', { n: 3 }), row('2', { n: 9 })]);
    expect(cells[0]?.[0]?.problem).toBeNull();
    expect(cells[1]?.[0]?.problem).toBe('n must be 5 or less');
  });

  it('takes notnull, max and unique from the shared rules, reasons and all', () => {
    const cols = [col({ field: 'a', notnull: true }), col({ field: 'b', max: 3 }), col({ field: 'c', unique: true })];
    const cells = previewCells(cols, [row('1', { a: 'x', b: 'abcd', c: 'dup' }), row('2', { a: '', b: 'ab', c: 'dup' })]);
    expect(cells[0]?.[1]?.problem).toBe('b length 4 is over the maximum of 3');
    expect(cells[1]?.[0]?.problem).toBe('a is empty');
    expect(cells[1]?.[2]?.problem).toContain('duplicates');
    // The FIRST row of a duplicated pair is not the duplicate.
    expect(cells[0]?.[2]?.problem).toBeNull();
  });

  it('flags a value the column TYPE cannot hold — the question a column editor exists to answer', () => {
    const cols = [col({ field: 'n', type: 'number' }), col({ field: 'd', type: 'date' }), col({ field: 'b', type: 'boolean' })];
    const cells = previewCells(cols, [row('1', { n: 'abc', d: 'not a date', b: 'maybe' })]);
    expect(cells[0]?.[0]?.problem).toBe('n is not a number');
    expect(cells[0]?.[1]?.problem).toBe('d is not a date');
    expect(cells[0]?.[2]?.problem).toBe('b is not true or false');
  });

  it('leaves an empty cell alone unless notnull says otherwise', () => {
    const cols = [col({ field: 'n', type: 'number' }), col({ field: 'd', type: 'date' })];
    const cells = previewCells(cols, [row('1', { n: '', d: null })]);
    expect(cells[0]?.[0]?.problem).toBeNull();
    expect(cells[0]?.[1]?.problem).toBeNull();
  });

  it('accepts the values a type CAN hold, including a numeric string', () => {
    const cols = [col({ field: 'n', type: 'number' }), col({ field: 'b', type: 'boolean' }), col({ field: 'd', type: 'date' })];
    const cells = previewCells(cols, [row('1', { n: '42', b: 'yes', d: '2026-08-26' })]);
    expect(cells[0]?.map((c) => c.problem)).toEqual([null, null, null]);
  });

  it('is one row of cells per row, in the column order it was given', () => {
    const cols = [col({ field: 'b' }), col({ field: 'a' })];
    const cells = previewCells(cols, [row('1', { a: 'A', b: 'B' })]);
    expect(cells).toHaveLength(1);
    expect(cells[0]?.map((c) => c.value)).toEqual(['B', 'A']);
  });

  it('has nothing to say about no rows', () => {
    expect(previewCells([col({ field: 'a' })], [])).toEqual([]);
  });
});

describe('previewText', () => {
  it('shows nothing for an absent value, rather than the word undefined', () => {
    expect(previewText(null)).toBe('');
    expect(previewText(undefined)).toBe('');
  });

  it('words a boolean, so a false cell is not mistaken for an empty one', () => {
    expect(previewText(false)).toBe('false');
    expect(previewText(true)).toBe('true');
  });

  it('serialises an object instead of showing [object Object]', () => {
    expect(previewText({ a: 1 })).toBe('{"a":1}');
    expect(previewText(['x', 'y'])).toBe('["x","y"]');
  });

  it('passes a string and a number straight through', () => {
    expect(previewText('hi')).toBe('hi');
    expect(previewText(0)).toBe('0');
  });
});

describe('PREVIEW_ROWS', () => {
  it('is a cap both editors share, so neither reads a whole table to sample it', () => {
    expect(PREVIEW_ROWS).toBe(100);
  });
});

describe('clampPreviewHeight', () => {
  it('passes an ordinary dragged height straight through', () => {
    expect(clampPreviewHeight(300, 900)).toBe(300);
  });

  it('keeps room for the column list above it, however far the grip is dragged', () => {
    // The grip trades space with the list, and the list is what the dialog is for.
    expect(clampPreviewHeight(5000, 900)).toBe(630);
  });

  it('will not close the preview to nothing — that reads as broken, not resized', () => {
    expect(clampPreviewHeight(0, 900)).toBe(90);
    expect(clampPreviewHeight(-200, 900)).toBe(90);
  });

  it('still gives a minimum on a window too short for one', () => {
    // 70% of 100px is less than the floor: the floor wins, so a tiny window
    // shows a scrollable preview rather than a sliver of one.
    expect(clampPreviewHeight(200, 100)).toBe(90);
  });

  it('rounds, so a fractional pointer position is not stored to the device', () => {
    expect(clampPreviewHeight(200.6, 900)).toBe(201);
  });

  it('has a default that survives clamping on any usable window', () => {
    expect(clampPreviewHeight(PREVIEW_HEIGHT_DEFAULT, 800)).toBe(PREVIEW_HEIGHT_DEFAULT);
  });
});
