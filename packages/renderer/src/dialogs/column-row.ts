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
  max?: number | undefined;
  unique?: boolean | undefined;
  notnull?: boolean | undefined;
  hidden?: boolean | undefined;
  /** field name in the saved table (edit mode only); used to detect field renames */
  origField?: string | undefined;
  /**
   * The full ColumnSpec this row was hydrated from (edit mode only). Kept as
   * the spread base in `buildColumnSpec` so ColumnSpec fields the editor
   * doesn't own — `default`, `width`, `description`, `units`, `sortable`, and
   * anything added to ColumnSpec later — survive a save untouched instead of
   * being silently dropped. Absent in "new table" mode.
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
 * Every OTHER editor-owned optional field (`renderer`, `script`, `max`,
 * `unique`, `notnull`, `hidden`) is explicitly set OR deleted based on the
 * current draft state — never left to a bare `if (truthy) spec.x = ...`,
 * because with a spread base that pattern would leave the OLD value from
 * `orig` alive when the user clears the field in the UI (e.g. picks "— none —"
 * for renderer after it had one). The delete branch looks redundant for a
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
  if (row.max != null && row.max > 0) spec.max = row.max;
  else delete spec.max;
  if (row.unique) spec.unique = true;
  else delete spec.unique;
  if (row.notnull) spec.notnull = true;
  else delete spec.notnull;
  if (row.hidden) spec.hidden = true;
  else delete spec.hidden;
  return spec;
}
