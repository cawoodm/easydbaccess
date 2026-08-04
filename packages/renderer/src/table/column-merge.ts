// packages/renderer/src/table/column-merge.ts
//
// Reconcile freshly-discovered columns from a (re)import or refresh against the
// user's existing column arrangement. Pure and DOM-free so it's unit-testable.
//
// The rules preserve everything the user has done to a snapshot table's columns
// while still surfacing genuine schema changes:
//   • keep every existing column exactly as arranged (order, hidden, width,
//     label, type, renderer, description, units …) — an incoming column that
//     already exists NEVER overwrites the user's version;
//   • never re-add a column the user explicitly deleted (`deleted`);
//   • append genuinely-new columns (neither existing nor deleted), in incoming
//     order, and report them as `newFields` so the caller can surface them
//     (e.g. open the column editor).
// When `existing` is empty (a failed first import left the table with no
// columns), every non-deleted incoming column is added — recreating the schema.

import type { ColumnSpec } from '@easydb/shared';

/**
 * Build a row rekeyer for a column edit that only renamed fields.
 *
 * The pre-import column editor (`editColumnNames`) can rename and hide, never
 * add, remove or reorder — so index `i` names the same column in both lists.
 * Renaming a field changes the object KEY the rows are stored under, so every
 * row must be rewritten or its values simply disappear.
 *
 * Returns null when nothing was renamed, so the caller can skip the copy.
 * Values under keys the editor did not touch are carried across unchanged.
 */
export function rowRekeyer(oldCols: ColumnSpec[], newCols: ColumnSpec[]): ((row: Record<string, unknown>) => Record<string, unknown>) | null {
  if (oldCols.every((c, i) => c.field === newCols[i]?.field)) return null;
  return (row) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < oldCols.length; i++) {
      out[newCols[i]!.field] = row[oldCols[i]!.field];
    }
    return out;
  };
}

export interface FieldRename {
  from: string;
  to: string;
}

/**
 * Re-key a row's `data` object after the column editor renamed fields.
 *
 * Unlike `rowRekeyer` (positional, pre-import only), this handles the
 * general edit-mode case: renames are named `from`/`to` pairs, and the
 * editor can also add/remove/reorder columns in the same save, so position
 * is meaningless here. All values are read from the original `data`
 * snapshot before anything is written, so a swap (`a`↔`b`) or a chain
 * (`a`→`b`→`c`) moves values correctly instead of one rename clobbering
 * another's source value.
 *
 * Returns null when `renames` is empty, so the caller can skip the write.
 */
export function renameRowFields(data: Record<string, unknown>, renames: readonly FieldRename[]): Record<string, unknown> | null {
  if (renames.length === 0) return null;
  const fromKeys = new Set(renames.map((r) => r.from));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (!fromKeys.has(key)) out[key] = data[key];
  }
  for (const { from, to } of renames) {
    if (Object.prototype.hasOwnProperty.call(data, from)) out[to] = data[from];
  }
  return out;
}

export interface ColumnMergeResult {
  columns: ColumnSpec[];
  /** Incoming fields that were neither already known nor previously deleted. */
  newFields: string[];
}

export function reconcileColumns(existing: ColumnSpec[], incoming: ColumnSpec[], deleted: readonly string[] = []): ColumnMergeResult {
  const existingFields = new Set(existing.map((c) => c.field));
  const deletedSet = new Set(deleted);
  const columns = [...existing];
  const newFields: string[] = [];
  for (const col of incoming) {
    if (existingFields.has(col.field) || deletedSet.has(col.field)) continue;
    columns.push(col);
    newFields.push(col.field);
    existingFields.add(col.field); // guard against duplicate incoming fields
  }
  return { columns, newFields };
}
