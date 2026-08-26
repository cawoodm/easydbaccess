// packages/renderer/src/dialogs/column-row.ts
//
// The new-table-dialog's in-progress column draft, and the pure mapping back
// to a persisted ColumnSpec. Pulled out of new-table-dialog.ts so the save
// mapping is unit-testable without a Lit element.

import type { ColumnSpec, ColumnType } from '@easydb/shared';

/** One row of the column editor's draft state. */
export interface ColumnRow {
  field: string;
  label: string;
  type: ColumnType;
  renderer?: string | undefined;
  /**
   * JS body whose `render(row)` return value replaces the stored value on its
   * way into whatever `renderer` this column has (or shows as text with none).
   */
  script?: string | undefined;
  /** False parks `script`: kept, not run. Absent/true ⇒ it runs. */
  scriptActive?: boolean | undefined;
  /**
   * JS body whose `validate(value, row)` throws to reject a manual cell edit.
   * The column's other script — see ColumnSpec.validate.
   */
  validate?: string | undefined;
  /** False parks `validate` the same way. */
  validateActive?: boolean | undefined;
  max?: number | undefined;
  unique?: boolean | undefined;
  notnull?: boolean | undefined;
  hidden?: boolean | undefined;
  /** Uncheck to disable sorting on this column. Absent/true ⇒ sortable. */
  sortable?: boolean | undefined;
  /**
   * Uncheck to disable filtering (funnel + free-text search) on this column.
   * Absent/true ⇒ filterable.
   */
  filterable?: boolean | undefined;
  /** field name in the saved table (edit mode only); used to detect field renames */
  origField?: string | undefined;
  /**
   * The full ColumnSpec this row was hydrated from (edit mode only). Kept as
   * the spread base in `buildColumnSpec` so ColumnSpec fields the editor
   * doesn't own — `default`, `width`, `description`, `units`, and anything
   * added to ColumnSpec later — survive a save untouched instead of being
   * silently dropped. Absent in "new table" mode.
   */
  orig?: ColumnSpec | undefined;
}

/**
 * Build the saved ColumnSpec for one editor row.
 *
 * `orig` (when present) is spread in first as the base, so any ColumnSpec
 * field the editor doesn't own rides through unchanged. `field`/`label`/
 * `type` are always overwritten from the draft.
 *
 * Every OTHER editor-owned optional field (`renderer`, `script`, `scriptActive`,
 * `validate`, `validateActive`,
 * `max`, `unique`, `notnull`, `hidden`, `sortable`, `filterable`) is explicitly set
 * OR deleted based on the current draft state — never left to a bare
 * `if (truthy) spec.x = ...`, because with a spread base that pattern would
 * leave the OLD value from `orig` alive when the user clears the field in
 * the UI (e.g. picks "— none —" for renderer after it had one). Note
 * `sortable`/`filterable` are inverted: they default to enabled, so the
 * "set" branch fires on `false` and the "delete" branch fires otherwise. The
 * delete branch looks redundant for a
 * fresh spec (there's nothing to remove) but is load-bearing once `orig`
 * carries a previous value.
 */
export function buildColumnSpec(row: ColumnRow): ColumnSpec {
  const spec: ColumnSpec = {
    ...(row.orig ?? {}),
    field: row.field.trim(),
    label: row.label.trim() || row.field.trim(),
    type: row.type,
  };
  if (row.renderer) spec.renderer = row.renderer;
  else delete spec.renderer;
  if (row.script) spec.script = row.script;
  else delete spec.script;
  // The switch is only meaningful with a script behind it: clearing the body
  // clears the switch too, so a column that gets a NEW script later starts by
  // running it rather than inheriting "off" from one deleted months ago.
  if (row.script && row.scriptActive === false) spec.scriptActive = false;
  else delete spec.scriptActive;
  if (row.validate) spec.validate = row.validate;
  else delete spec.validate;
  if (row.validate && row.validateActive === false) spec.validateActive = false;
  else delete spec.validateActive;
  if (row.max != null && row.max > 0) spec.max = row.max;
  else delete spec.max;
  if (row.unique) spec.unique = true;
  else delete spec.unique;
  if (row.notnull) spec.notnull = true;
  else delete spec.notnull;
  if (row.hidden) spec.hidden = true;
  else delete spec.hidden;
  if (row.sortable === false) spec.sortable = false;
  else delete spec.sortable;
  if (row.filterable === false) spec.filterable = false;
  else delete spec.filterable;
  return spec;
}

/** The editor's five checkbox columns, named for what their header glyph means. */
export type ColumnFlag = 'unique' | 'notnull' | 'visible' | 'sortable' | 'filterable';

/**
 * Read and write one checkbox column the way the CHECKBOX reads it: `true` is
 * ticked.
 *
 * Three of the five are not stored that way. `hidden` is the opposite of the
 * "visible" box, and `sortable`/`filterable` are absent-means-yes, so ticking
 * them clears the field rather than setting `true` (`buildColumnSpec` only
 * persists the `false`). Doing that arithmetic in one place is what lets the
 * header toggle treat all five alike.
 */
const FLAGS: Record<ColumnFlag, { get(row: ColumnRow): boolean; set(on: boolean): Partial<ColumnRow> }> = {
  unique: { get: (r) => !!r.unique, set: (on) => ({ unique: on ? true : undefined }) },
  notnull: { get: (r) => !!r.notnull, set: (on) => ({ notnull: on ? true : undefined }) },
  visible: { get: (r) => !r.hidden, set: (on) => ({ hidden: on ? undefined : true }) },
  sortable: { get: (r) => r.sortable !== false, set: (on) => ({ sortable: on ? undefined : false }) },
  filterable: { get: (r) => r.filterable !== false, set: (on) => ({ filterable: on ? undefined : false }) },
};

/** Is this checkbox ticked on `row`? */
export function columnFlag(row: ColumnRow, flag: ColumnFlag): boolean {
  return FLAGS[flag].get(row);
}

/** Are every row's boxes ticked in this column? Vacuously true for no rows. */
export function allColumnsFlagged(rows: readonly ColumnRow[], flag: ColumnFlag): boolean {
  return rows.every((r) => FLAGS[flag].get(r));
}

/**
 * All-or-none for one checkbox column, as clicking its header does.
 *
 * A MIXED column ticks rather than unticks: the click means "select all", and
 * only a column that is already fully ticked has anything else to do. So the
 * two states a user can reach by clicking twice are all and none, in that order.
 */
export function toggleColumnFlag(rows: readonly ColumnRow[], flag: ColumnFlag): ColumnRow[] {
  const next = !allColumnsFlagged(rows, flag);
  return rows.map((r) => ({ ...r, ...FLAGS[flag].set(next) }));
}
