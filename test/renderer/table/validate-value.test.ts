import { describe, expect, it } from 'vitest';
import { validateRecord, validateValue } from '../../../packages/renderer/src/table/validate-value.js';
import type { ColumnSpec, Row } from '../../../packages/shared/src/types.js';

/**
 * One value against one column's rules, in the words the user reads.
 *
 * This was private to `data-table.ts` and reached only by a cell edit; the
 * new-record form needs the same verdict in the same words, so it moved here.
 * These tests are the first it has ever had.
 */

const col = (extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ field: 'f', label: 'Name', type: 'string', ...extra });
const row = (data: Record<string, unknown> = {}) => ({ data });
const stored = (id: string, data: Record<string, unknown>): Row => ({ id, tableId: 't', data, updatedAt: 0 });

describe('validateValue', () => {
  it('accepts anything from a column with no rules', () => {
    expect(validateValue(col(), '', [], 'r1', row())).toBeNull();
    expect(validateValue(col(), null, [], 'r1', row())).toBeNull();
  });

  describe('notnull', () => {
    const c = col({ notnull: true });

    it('rejects absent and whitespace-only values', () => {
      expect(validateValue(c, null, [], 'r1', row())).toBe('Name cannot be empty.');
      expect(validateValue(c, undefined, [], 'r1', row())).toBe('Name cannot be empty.');
      expect(validateValue(c, '   ', [], 'r1', row())).toBe('Name cannot be empty.');
    });

    it('accepts a real value, including a falsy one', () => {
      expect(validateValue(c, 'x', [], 'r1', row())).toBeNull();
      // 0 and false are answers, not absences.
      expect(validateValue(col({ notnull: true, type: 'number' }), 0, [], 'r1', row())).toBeNull();
      expect(validateValue(col({ notnull: true, type: 'boolean' }), false, [], 'r1', row())).toBeNull();
    });
  });

  describe('max', () => {
    it('means LENGTH for text and MAGNITUDE for a number', () => {
      expect(validateValue(col({ max: 3 }), 'abcd', [], 'r1', row())).toBe('Name must be at most 3 characters (got 4).');
      expect(validateValue(col({ max: 3, type: 'number' }), 4, [], 'r1', row())).toBe('Name must be at most 3 (got 4).');
    });

    it('accepts the boundary itself', () => {
      expect(validateValue(col({ max: 3 }), 'abc', [], 'r1', row())).toBeNull();
      expect(validateValue(col({ max: 3, type: 'number' }), 3, [], 'r1', row())).toBeNull();
    });

    it('ignores a max of zero — that is "no maximum", not "nothing allowed"', () => {
      expect(validateValue(col({ max: 0 }), 'abc', [], 'r1', row())).toBeNull();
    });
  });

  describe('unique', () => {
    const c = col({ unique: true });
    const rows = [stored('r1', { f: 'taken' }), stored('r2', { f: 'other' })];

    it('names the row that already has the value', () => {
      expect(validateValue(c, 'taken', rows, 'r9', row())).toBe('Name must be unique. Another row already has "taken".');
    });

    it('does not count the row being edited against itself', () => {
      expect(validateValue(c, 'taken', rows, 'r1', row())).toBeNull();
    });

    it('lets blanks repeat — two empty cells are two unanswered rows', () => {
      const blanks = [stored('r1', { f: '' }), stored('r2', { f: null })];
      expect(validateValue(c, '', blanks, 'r9', row())).toBeNull();
      expect(validateValue(c, null, blanks, 'r9', row())).toBeNull();
    });

    it('cannot be checked with no rows to compare — the new-record case', () => {
      // Documented, not accidental: a record that does not exist yet has nothing
      // to be a duplicate of here. The grid's next edit and Validate both catch it.
      expect(validateValue(c, 'taken', [], 'new', row())).toBeNull();
    });
  });

  describe('the validate script', () => {
    const c = col({ validate: 'function validate(value){ if (value !== "ok") throw new Error("must be ok"); }' });

    it('shows what the script threw', () => {
      expect(validateValue(c, 'nope', [], 'r1', row())).toBe('must be ok');
      expect(validateValue(c, 'ok', [], 'r1', row())).toBeNull();
    });

    it('sees the row AS IT WOULD BE, not as stored', () => {
      // A two-field rule must read the pending value, or it contradicts itself
      // depending on which cell was touched last.
      const pair = col({ field: 'b', label: 'B', validate: 'function validate(value, row){ if (row.a !== row.b) throw new Error("a and b must match"); }' });
      expect(validateValue(pair, 2, [], 'r1', row({ a: 1, b: 1 }))).toBe('a and b must match');
      expect(validateValue(pair, 1, [], 'r1', row({ a: 1, b: 9 }))).toBeNull();
    });

    it('runs only after the declarative rules pass', () => {
      // A script author writing "must be a valid IBAN" should not have to
      // re-check the emptiness that the Not-null box already covers.
      const both = col({ notnull: true, validate: 'function validate(){ throw new Error("script ran"); }' });
      expect(validateValue(both, '', [], 'r1', row())).toBe('Name cannot be empty.');
    });
  });
});

describe('validateRecord', () => {
  const columns = [col({ field: 'a', label: 'A', notnull: true }), col({ field: 'b', label: 'B', max: 2 }), col({ field: 'c', label: 'C' })];

  it('reports every broken field at once, keyed by field', () => {
    // A record is filled in all at once, so the user wants every problem at once
    // rather than one per attempt.
    const issues = validateRecord(columns, { a: '', b: 'abc', c: 'fine' });
    expect([...issues.keys()]).toEqual(['a', 'b']);
    expect(issues.get('a')).toBe('A cannot be empty.');
    expect(issues.get('b')).toBe('B must be at most 2 characters (got 3).');
  });

  it('is empty for a record that meets every rule', () => {
    expect(validateRecord(columns, { a: 'x', b: 'yz', c: '' }).size).toBe(0);
  });

  it('only judges the columns it is given, so a hidden field left off the form is not blamed', () => {
    // The form validates what it shows. A hidden required column would otherwise
    // report a problem in a box the user cannot see.
    const shown = columns.filter((c) => c.field !== 'a');
    expect(validateRecord(shown, { b: 'yz' }).size).toBe(0);
  });
});
