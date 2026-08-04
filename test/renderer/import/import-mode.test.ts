import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import { columnsLineUp } from '../../../packages/renderer/src/import/import-mode.js';

/**
 * `columnsLineUp` decides whether an import can map a file's columns onto a
 * table's without asking. It has to be strict: a wrong "yes" lands every cell
 * one column over, silently, in a table that already held data.
 */
const col = (field: string, label?: string): ColumnSpec => ({ field, label: label ?? field, type: 'string' });

describe('columnsLineUp', () => {
  const target = [col('name', 'Name'), col('age', 'Age')];

  it('accepts the file the table was imported from', () => {
    expect(columnsLineUp(['name', 'age'], target)).toBe(true);
  });

  it('accepts a header written as the column LABELS', () => {
    expect(columnsLineUp(['Name', 'Age'], target)).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    expect(columnsLineUp([' NAME ', 'age'], target)).toBe(true);
  });

  it('accepts a header that only slugifies to the field', () => {
    expect(columnsLineUp(['First Name'], [col('first_name', 'First Name')])).toBe(true);
  });

  it('refuses a different count, in either direction', () => {
    expect(columnsLineUp(['name'], target)).toBe(false);
    expect(columnsLineUp(['name', 'age', 'extra'], target)).toBe(false);
  });

  it('refuses the same names in a different ORDER — position is what maps', () => {
    expect(columnsLineUp(['age', 'name'], target)).toBe(false);
  });

  it('refuses a header that names something else', () => {
    expect(columnsLineUp(['name', 'years'], target)).toBe(false);
  });

  it('two empty sides line up — there is nothing to get wrong', () => {
    expect(columnsLineUp([], [])).toBe(true);
  });
});
