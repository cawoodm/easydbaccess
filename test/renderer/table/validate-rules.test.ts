import { describe, expect, it } from 'vitest';
import { countByKind, createValidator, issueMessages, summarizeIssues } from '../../../packages/renderer/src/table/validate-rules.js';
import type { ColumnSpec, Row } from '../../../packages/shared/src/types.js';

/**
 * The four rules a column can carry, in the one place that defines them.
 *
 * Two callers share this: the columns editor's Save pre-flight (which must not run
 * scripts — a Save is not the place to start running JS over every row) and the
 * footer's Validate button (which must). Both directions are asserted, because the
 * whole reason the rules moved here was to stop two copies disagreeing about what
 * `max` means.
 */

const col = (over: Partial<ColumnSpec> & { field: string }): ColumnSpec => ({ label: over.field, type: 'string', ...over });

let n = 0;
const row = (data: Record<string, unknown>): Row => ({ id: `r${++n}`, tableId: 't', data, updatedAt: 0 });

/** Run a validator over every row, as both callers do. */
function scan(columns: ColumnSpec[], rows: Row[], opts: Parameters<typeof createValidator>[1] = {}) {
  const v = createValidator(columns, opts);
  const issues = rows.flatMap((r, i) => v.check(r, i));
  return { issues, capped: v.capped(), fields: v.fields, needsScripts: v.needsScripts };
}

describe('no rules', () => {
  it('reports no fields to check, so a caller can skip the read entirely', () => {
    const out = scan([col({ field: 'a' }), col({ field: 'b', type: 'number' })], [row({ a: '', b: null })]);
    expect(out.fields).toEqual([]);
    expect(out.issues).toEqual([]);
  });

  it('ignores a max of zero — that is "no maximum", not "everything is too long"', () => {
    const out = scan([col({ field: 'a', max: 0 })], [row({ a: 'anything' })]);
    expect(out.fields).toEqual([]);
  });
});

describe('notnull', () => {
  const columns = [col({ field: 'name', label: 'Name', notnull: true })];

  it('catches null, undefined, empty and whitespace — a space is not an entry', () => {
    const out = scan(columns, [row({ name: 'Ada' }), row({ name: '' }), row({ name: null }), row({}), row({ name: '   ' })]);
    expect(out.issues.map((i) => i.row)).toEqual([2, 3, 4, 5]);
    expect(out.issues[0]?.reason).toBe('is empty');
  });

  it('keeps a zero and a false, which are values', () => {
    expect(scan([col({ field: 'n', type: 'number', notnull: true })], [row({ n: 0 })]).issues).toEqual([]);
    expect(scan([col({ field: 'b', type: 'boolean', notnull: true })], [row({ b: false })]).issues).toEqual([]);
  });
});

describe('max', () => {
  it('means LENGTH for text', () => {
    const out = scan([col({ field: 'code', label: 'Code', max: 3 })], [row({ code: 'abc' }), row({ code: 'abcd' })]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]?.reason).toBe('length 4 is over the maximum of 3');
  });

  it('means MAGNITUDE for a number', () => {
    const out = scan([col({ field: 'age', label: 'Age', type: 'number', max: 120 })], [row({ age: 120 }), row({ age: 121 })]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]?.reason).toBe('value 121 is over the maximum of 120');
  });

  it('says nothing about a value that is neither text nor a number', () => {
    expect(scan([col({ field: 'tags', type: 'array', max: 2 })], [row({ tags: ['a', 'b', 'c'] })]).issues).toEqual([]);
  });
});

describe('unique', () => {
  const columns = [col({ field: 'sku', label: 'SKU', unique: true })];

  it('reports the SECOND row, naming the first', () => {
    const out = scan(columns, [row({ sku: 'A1' }), row({ sku: 'B2' }), row({ sku: 'A1' })]);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]?.row).toBe(3);
    expect(out.issues[0]?.reason).toBe('duplicates Row 1');
  });

  it('names the twin by its label value when the table has one', () => {
    const out = scan(columns, [row({ sku: 'A1', name: 'Widget' }), row({ sku: 'A1', name: 'Gadget' })], { labelField: 'name' });
    expect(out.issues[0]?.reason).toBe('duplicates Widget');
    expect(out.issues[0]?.key).toBe('Gadget');
  });

  it('does not call two blanks a duplicate — that is what notnull is for', () => {
    expect(scan(columns, [row({ sku: '' }), row({ sku: '' }), row({ sku: null }), row({})]).issues).toEqual([]);
  });

  it('reports every later copy, not just the second', () => {
    const out = scan(columns, [row({ sku: 'A' }), row({ sku: 'A' }), row({ sku: 'A' })]);
    expect(out.issues.map((i) => i.row)).toEqual([2, 3]);
  });
});

describe('validate scripts', () => {
  const columns = [col({ field: 'email', label: 'Email', validate: 'function validate(value) { if (!String(value).includes("@")) throw "needs an @"; }' })];

  it('are not run unless asked — a Save must not start running JS over every row', () => {
    const out = scan(columns, [row({ email: 'nope' })]);
    expect(out.issues).toEqual([]);
    expect(out.fields).toEqual([]);
    expect(out.needsScripts).toBe(false);
  });

  it('report the script’s own message', () => {
    const out = scan(columns, [row({ email: 'a@b.c' }), row({ email: 'nope' })], { runScripts: true });
    expect(out.needsScripts).toBe(true);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ row: 2, kind: 'script', reason: 'needs an @' });
  });

  it('see the whole row, not just their own cell', () => {
    const cols = [col({ field: 'end', label: 'End', validate: 'function validate(value, row) { if (value < row.start) throw "before the start"; }' })];
    const out = scan(cols, [row({ start: 5, end: 9 }), row({ start: 5, end: 1 })], { runScripts: true });
    expect(out.issues.map((i) => i.row)).toEqual([2]);
  });

  it('report a compile error once per row rather than throwing the scan away', () => {
    const cols = [col({ field: 'x', label: 'X', validate: 'function validate( {{{' })];
    const out = scan(cols, [row({ x: 1 })], { runScripts: true });
    expect(out.issues[0]?.reason).toContain('compile error');
  });
});

describe('the per-column cap', () => {
  const columns = [col({ field: 'a', label: 'A', notnull: true }), col({ field: 'b', label: 'B', notnull: true })];
  const rows = Array.from({ length: 10 }, () => row({ a: '', b: '' }));

  it('stops listing after the cap and counts the rest', () => {
    // A script that rejects every row would otherwise return one issue per row:
    // 609,283 of them, all saying the same thing.
    const out = scan(columns, rows, { capPerColumn: 3 });
    expect(out.issues.filter((i) => i.label === 'A')).toHaveLength(3);
    expect(out.capped.get('A')).toBe(7);
  });

  it('caps each column on its own', () => {
    const out = scan(columns, rows, { capPerColumn: 3 });
    expect(out.issues).toHaveLength(6);
    expect([...out.capped.keys()].sort()).toEqual(['A', 'B']);
  });

  it('lists everything when the cap is zero', () => {
    const out = scan(columns, rows, { capPerColumn: 0 });
    expect(out.issues).toHaveLength(20);
    expect(out.capped.size).toBe(0);
  });
});

describe('reporting helpers', () => {
  const columns = [col({ field: 'name', label: 'Name', notnull: true }), col({ field: 'sku', label: 'SKU', unique: true })];
  const rows = [row({ name: 'Ada', sku: 'A' }), row({ name: '', sku: 'A' })];

  it('issueMessages keeps the shape the Save pre-flight has always shown', () => {
    const { issues } = scan(columns, rows);
    expect(issueMessages(issues)).toEqual(['Row 2: Name is empty.', 'Row 2: SKU duplicates Row 1.']);
  });

  it('countByKind tallies per rule', () => {
    const { issues } = scan(columns, rows);
    expect([...countByKind(issues)]).toEqual([
      ['notnull', 1],
      ['unique', 1],
    ]);
  });

  it('summarizeIssues writes one line per column, in plain words', () => {
    const { issues, capped } = scan(columns, rows);
    expect(summarizeIssues(issues, capped)).toEqual(['Name: 1 empty', 'SKU: 1 duplicated']);
  });

  it('summarizeIssues says when a column was capped', () => {
    const many = Array.from({ length: 5 }, () => row({ name: '', sku: 'x' }));
    const { issues, capped } = scan([columns[0]!], many, { capPerColumn: 2 });
    expect(summarizeIssues(issues, capped)).toEqual(['Name: 2 empty (and 3 more not listed)']);
  });
});
