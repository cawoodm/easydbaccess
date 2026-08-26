// packages/renderer/src/table/validate-value.ts
//
// One value against one column's rules, worded for a person.
//
// This was a private function inside `data-table.ts`, reached only by a cell
// edit. The new-record form needs the same verdict in the same words — a rule
// that reads one way in the grid and another in a form is two rules — so it
// lives here and both call it.
//
// Not the same job as `validate-rules.ts`, which walks a whole table and
// collects `RowIssue`s for a report. This answers "can this one value go in?"
// and returns the sentence to show. `validate-rules.ts` owns `unique` across a
// table; here `unique` can only be checked against the rows the caller hands
// over.

import type { ColumnSpec, Row } from '@easydb/shared';
import { activeValidateScript } from '@easydb/shared';
import { runValidateScript } from '../util/column-script.js';

/**
 * Returns a human-readable rejection reason, or null if value is acceptable.
 *
 * The declarative constraints run first and the column's `validate` script
 * last: the boxes are cheap and predictable, and a script author writing
 * "must be a valid IBAN" shouldn't have to re-check emptiness that the
 * Not-null box already covers.
 *
 * `allRows` is what `unique` is checked against, and an empty list means it
 * cannot be checked at all — which is the honest answer for a record that does
 * not exist yet. The grid passes the rows it holds; the new-record form has
 * none, and its own duplicate would be caught by the next edit or by Validate.
 */
export function validateValue(col: ColumnSpec, value: unknown, allRows: readonly Row[], rowId: string, row: { data: Record<string, unknown> }): string | null {
  if (col.notnull) {
    if (value === null || value === undefined) return `${col.label} cannot be empty.`;
    if (typeof value === 'string' && value.trim().length === 0) {
      return `${col.label} cannot be empty.`;
    }
  }
  if (col.max != null && col.max > 0) {
    if (typeof value === 'string' && value.length > col.max) {
      return `${col.label} must be at most ${col.max} characters (got ${value.length}).`;
    }
    if (typeof value === 'number' && value > col.max) {
      return `${col.label} must be at most ${col.max} (got ${value}).`;
    }
  }
  if (col.unique && value !== null && value !== undefined && value !== '') {
    const dup = allRows.find((r) => r.id !== rowId && r.data[col.field] === value);
    if (dup) return `${col.label} must be unique. Another row already has "${String(value)}".`;
  }
  const rule = activeValidateScript(col);
  if (rule !== undefined) {
    // The script sees the row AS IT WOULD BE — a rule comparing this cell to a
    // sibling field must read the pending edit, not the value on disk, or a
    // two-field rule contradicts itself depending on which cell you touch last.
    const proposed = { ...row.data, [col.field]: value };
    const run = runValidateScript(rule, value, proposed);
    if (!run.ok) return run.message;
  }
  return null;
}

/**
 * Every rule broken by a whole proposed record, keyed by field.
 *
 * What the form needs: a cell edit fails one value at a time, but a record is
 * filled in all at once and the user wants every problem at once rather than one
 * per attempt.
 */
export function validateRecord(columns: readonly ColumnSpec[], data: Record<string, unknown>, allRows: readonly Row[] = [], rowId = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of columns) {
    const reason = validateValue(c, data[c.field], allRows, rowId, { data });
    if (reason) out.set(c.field, reason);
  }
  return out;
}
