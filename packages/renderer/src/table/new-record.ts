// packages/renderer/src/table/new-record.ts
//
// What a new record starts as, and which of its fields the user is asked for.
//
// Pure, so the two rules that decide what the form shows — and the defaults it
// shows them with — are testable without a dialog, a store or a grid.

import type { ColumnSpec } from '@easydb/shared';
import { activeColumnScript } from '@easydb/shared';

/**
 * The value a column starts a new record with.
 *
 * `default` when the column declares one, otherwise the empty value for its
 * type. `number` starts as `null` rather than `0`: a blank number field means
 * "nobody said", and 0 is an answer.
 *
 * Moved here from `chrome/panel-footer.ts`, which used it for the blank row it
 * inserted directly. The form and that row have to agree about what a new record
 * holds, or the same table would gain different rows depending on which path was
 * taken.
 */
export function defaultFor(c: ColumnSpec): unknown {
  if (c.default !== undefined) return c.default;
  switch (c.type) {
    case 'boolean':
      return false;
    case 'number':
      return null;
    default:
      return '';
  }
}

/** Every column's default — the record before the user types anything. */
export function blankRecord(columns: readonly ColumnSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c.field] = defaultFor(c);
  return out;
}

/**
 * A column the user cannot be asked for.
 *
 * A scripted column is DERIVED — its value comes from `render(row)` every time
 * it is shown, so there is nowhere to put an answer. Same reasoning as the grid,
 * which makes those cells read-only.
 */
export function isDerived(c: ColumnSpec): boolean {
  return activeColumnScript(c) !== undefined;
}

/**
 * The fields the form asks for, in column order.
 *
 * Visible columns only, unless `showAll` — which is the toggle's whole job. A
 * hidden column still gets its default written (see {@link blankRecord}); it is
 * only left off the FORM, because a form that asks for forty fields when the
 * table shows six is not the quick way to add a record.
 */
export function recordFields(columns: readonly ColumnSpec[], showAll: boolean): ColumnSpec[] {
  return columns.filter((c) => !isDerived(c) && (showAll || c.hidden !== true));
}

/** Are there fields the toggle would reveal? No ⇒ do not offer it. */
export function hasMoreFields(columns: readonly ColumnSpec[]): boolean {
  return recordFields(columns, true).length > recordFields(columns, false).length;
}

/**
 * What an `<input>`'s string becomes for a column of this type.
 *
 * The form's counterpart to the grid's per-type editors. Two rules are worth
 * stating:
 *
 *  - **An empty box is `null`, not `0` or `''`, for every type but text.** A
 *    number field left alone has no value, and `0` would be a number the user
 *    never typed. Text keeps `''` because that is what an empty text cell is.
 *  - **A number that will not parse is kept as the STRING the user typed.**
 *    Throwing it away mid-form loses their work, and the grid already shows a
 *    value that does not fit its type as invalid rather than pretending it is
 *    absent. Validation says so; saving is still allowed.
 */
export function coerceInput(type: ColumnSpec['type'], raw: string): unknown {
  if (type === 'boolean') return raw === 'true';
  const trimmed = raw.trim();
  if (type === 'number') {
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'date' || type === 'datetime') return trimmed === '' ? null : raw;
  if (type === 'array') return trimmed === '' ? [] : raw.split(',').map((s) => s.trim());
  return raw;
}

/** What a column's stored value looks like in a text box. */
export function inputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
