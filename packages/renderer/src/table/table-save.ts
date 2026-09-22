/**
 * The decisions the columns editor's Save makes, as pure functions.
 *
 * `dialogs/new-table-dialog.ts` used to hold all of this inline in one 162-line
 * `submit()`: validation, the deleted/purged column bookkeeping, the constraint
 * pre-flight and the row re-key were a single linear run with no seam a test
 * could reach without mounting the element. Everything here is DOM-free and
 * store-free — the dialog still owns the awaits, this file owns the rules.
 *
 * Nothing in here writes. `submit()` runs the writes in stages and reports
 * which ones landed if one throws ({@link saveStageError}), because the save is
 * a multi-step migration with no transaction around it: table patch, row
 * re-key, projection repoint, view repoint. A failure halfway used to be
 * silent.
 */

import type { ColumnSpec, Table } from '@easydb/shared';
import type { FieldRename } from './column-merge.js';
import { renameRowFields } from './column-merge.js';
import { remapFilterFields, sameFilterMap } from './filter-map.js';

/**
 * The first thing wrong with the draft, worded for the error banner, or null
 * when it can be saved.
 *
 * Both name checks are case-INSENSITIVE, and for the same reason: a table name
 * and a field name each become a real SQLite identifier, and SQLite compares
 * those without case. `Name` beside `name` is one column in the file — the save
 * went through with no complaint and one of the two columns then read as empty.
 */
export function draftProblem(draft: { name: string; fields: readonly string[]; tables: readonly Table[]; selfId: string | null }): string | null {
  if (!draft.name) return 'Table name is required.';
  const lower = draft.name.toLowerCase();
  const clash = draft.tables.find((t) => t.name.toLowerCase() === lower && t.id !== draft.selfId);
  if (clash) return `A table named "${clash.name}" already exists — names must be unique.`;
  if (draft.fields.length === 0) return 'At least one column is required.';
  // The first spelling is kept so the message can name what the clash is with —
  // "duplicate: name" reads like a false alarm when the other column is `Name`.
  const seen = new Map<string, string>();
  for (const raw of draft.fields) {
    const f = raw.trim();
    if (!f) return 'Column field names cannot be empty.';
    const first = seen.get(f.toLowerCase());
    if (first !== undefined) {
      return first === f ? `Duplicate column field: ${f}` : `Duplicate column field: "${f}" clashes with "${first}" — column names are not case-sensitive.`;
    }
    seen.set(f.toLowerCase(), f);
  }
  return null;
}

/** What a save has to do to the saved table's fields, beyond writing `columns`. */
export interface ColumnChanges {
  /** Every field name the save is about to store. */
  savedFields: Set<string>;
  /** Saved fields no draft row claims any more — removed in THIS save. */
  removedNow: string[];
  /** `Table.deletedColumns` as it stands before this save. */
  prevDeleted: readonly string[];
  /** `Table.deletedColumns` as it should stand after it. */
  deletedColumns: string[];
  /** Fields whose values must be scrubbed from every row. */
  purgeFields: string[];
}

/**
 * Work out which columns this save removes, and what that means for the rows.
 *
 * A removed column is an original field no longer kept by any draft row.
 * Renames keep their `origField`, so they are not removals — that is what
 * `keptOrig` carries. The names are remembered in `deletedColumns` so a later
 * re-import or refresh does not re-add them, and re-adding a column under a
 * previously-deleted name clears it from that set again.
 */
export function planColumnChanges(existing: Table | null | undefined, columns: readonly ColumnSpec[], keptOrig: ReadonlySet<string>): ColumnChanges {
  const savedFields = new Set(columns.map((c) => c.field));
  const removedNow = (existing?.columns ?? []).map((c) => c.field).filter((f) => !keptOrig.has(f));
  const prevDeleted = existing?.deletedColumns ?? [];
  const deletedColumns = [...new Set([...prevDeleted, ...removedNow])].filter((f) => !savedFields.has(f));
  // A field removed and re-added under the same name in one save keeps its
  // values: it is still a saved field, so there is nothing to scrub.
  const purgeFields = removedNow.filter((f) => !savedFields.has(f));
  return { savedFields, removedNow, prevDeleted, deletedColumns, purgeFields };
}

/**
 * The columns whose constraints just got STRICTER — the only ones the existing
 * rows have to be re-checked against.
 *
 * A constraint that was already on has already been enforced on every write, so
 * re-scanning for it would only ever re-report data the user has been living
 * with. Scanning is a full table read; this is what keeps it off the common
 * save.
 */
export function tightenedConstraints(columns: readonly ColumnSpec[], existing: readonly ColumnSpec[]): ColumnSpec[] {
  const prev = new Map(existing.map((c) => [c.field, c]));
  return columns.filter((c) => {
    const was = prev.get(c.field);
    return (c.unique && !was?.unique) || (c.notnull && !was?.notnull) || (c.max !== undefined && c.max > 0 && c.max !== was?.max);
  });
}

/** How many offending rows to name before switching to a count. */
const SHOWN_VIOLATIONS = 5;

/** The banner text for a save blocked by the constraint pre-flight. */
export function constraintErrorMessage(violations: readonly string[]): string {
  const head = `Cannot save: ${violations.length} existing ${violations.length === 1 ? 'row violates' : 'rows violate'} the new constraints.`;
  const shown = violations.slice(0, SHOWN_VIOLATIONS);
  const rest = violations.length - shown.length;
  return `${head}\n${shown.join('\n')}${rest > 0 ? `\n…and ${rest} more.` : ''}`;
}

/**
 * One row's `data` after the save's renames and purges, or null when the row
 * carries none of the affected fields and must not be written at all.
 *
 * Renames are applied BEFORE purges so a field that is renamed and then purged
 * can never collide with the value being moved.
 */
export function migrateRowData(data: Readonly<Record<string, unknown>>, renames: readonly FieldRename[], purgeFields: readonly string[]): Record<string, unknown> | null {
  let touched = false;
  let next: Record<string, unknown> = { ...data };
  const renamed = renameRowFields(next, renames);
  if (renamed) {
    next = renamed;
    touched = true;
  }
  for (const f of purgeFields) {
    if (f in next) {
      delete next[f];
      touched = true;
    }
  }
  return touched ? next : null;
}

/**
 * The parts of an edit patch that are written only when they carry meaning:
 *
 * - `deletedColumns` — something is tracked, or a tracked set is being cleared.
 * - `filters` — a funnel was toggled, or a rename / removal moved the keys.
 *   Field-keyed, so `remapFilterFields` has to run whether or not the user
 *   touched a funnel at all.
 */
export function conditionalPatch(
  existing: Table | null | undefined,
  changes: Pick<ColumnChanges, 'deletedColumns' | 'prevDeleted' | 'savedFields'>,
  filters: Readonly<Record<string, string>>,
  renames: readonly FieldRename[],
): Partial<Table> {
  const out: Partial<Table> = {};
  if (changes.deletedColumns.length > 0 || changes.prevDeleted.length > 0) out.deletedColumns = changes.deletedColumns;
  const next = remapFilterFields(filters, renames, changes.savedFields);
  if (!sameFilterMap(existing?.filters ?? {}, next)) out.filters = next;
  return out;
}

/**
 * One write of the save: what it is called in a message, and how to run it.
 * The label is user-facing — it completes "Could not save …".
 */
export type SaveStage = [what: string, run: () => Promise<unknown>];

/**
 * What to tell the user when one write stage of the save throws.
 *
 * The save is four independent writes with no transaction around them, so a
 * failure in the middle really does leave the workspace part-migrated — the
 * table patched but its rows not re-keyed, say. Naming what landed is the
 * difference between "save again" being an informed choice and a guess.
 */
export function saveStageError(failed: string, done: readonly string[], err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  const head = `Could not save ${failed}: ${why}`;
  if (done.length === 0) return `${head}\nNothing was changed.`;
  return `${head}\nAlready written: ${done.join(', ')}. The table is part-saved — fix the problem and save again.`;
}
