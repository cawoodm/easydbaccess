// packages/renderer/src/table/row-errors.ts
//
// What the last Validate run found, held per table: one message per row, and one
// reason per offending CELL.
//
// Two consumers, and they need different shapes of the same answer:
//
//  - **The grid** marks the cell that is wrong — pink like an empty one, with the
//    reason in its tooltip. That needs `row + field → reason`, which nothing in
//    the store holds: a cell is wrong relative to a rule, not by its value.
//  - **The `_error` column** holds the whole row's verdict as text. That IS in the
//    store — see below — so the grid reads it like any other column.
//
// The findings were a second TABLE first (`Pets issues`), then a column the grid
// synthesized and never persisted. Both are gone. `_error` is now an ordinary
// column of the table, created hidden, and Validate owns its values: a run writes
// the rows it flagged and clears the ones it no longer flags. Ordinary is what
// makes the rest work — the columns editor can show it, a filter on it needs no
// special case in the store, and renaming it hands the messages over as data,
// because a field rename re-keys every row (`table/column-merge.ts`).
//
// So this registry is only the part that CANNOT be stored: the per-cell reasons,
// and the fact that a run just happened. It is emptied at the start of every run
// and lost on reload, which is correct — a verdict must not outlive the data it
// judged. The text in `_error` survives, and the next run rewrites it.
//
// A plain registry with listeners, for the reason `visible-rows.ts` gives: the
// producer (the Validate plugin) and the consumer (the grid) know each other, and
// a module with no `document` in it can be unit-tested in this repo's DOM-free
// vitest.

import type { ColumnSpec } from '@easydb/shared';
import type { RowIssue } from './validate-rules.js';

/**
 * The field Validate writes its verdict to.
 *
 * Leading underscore because the app made it, not the user. It stays a normal
 * field in every other way: renaming it in the columns editor makes it theirs,
 * and the next run creates a fresh `_error` beside it rather than taking it back.
 */
export const ERROR_FIELD = '_error';

/** Filter expression for "this row has a message" — see `column-filter.ts`. */
export const ERROR_FILTER = '!NULL';

/**
 * The column a run creates when the table has no `_error` yet.
 *
 * `hidden`, because the message is not what the user is reading the table for —
 * the pink cell and its tooltip say what is wrong, in place. Hidden ONLY at
 * creation: a later run must not re-hide a column the user unhid, so this spec is
 * used for the insert and never to patch one that already exists.
 *
 * `text`, so its funnel offers no value list: every message is different, and a
 * list would be one option per row (the rule `search/facet-values.ts` documents).
 *
 * Deliberately NOT `readonly`. The columns editor keeps a column's untouched
 * fields through a save, so `readonly` would follow the field through a rename
 * and leave the user with a column of their own they could not edit.
 */
export function errorColumnSpec(): ColumnSpec {
  return {
    field: ERROR_FIELD,
    label: 'Problem',
    type: 'text',
    hidden: true,
    description: 'What Validate found in this row. Rewritten by every run — rename this column to keep a copy.',
  };
}

/** One row's verdict, in the two shapes its two readers need. */
export interface RowProblems {
  /** Every problem in the row as one line. This is what `_error` holds. */
  message: string;
  /** Field → why that cell is wrong. One entry per offending column. */
  fields: ReadonlyMap<string, string>;
}

export type RowErrors = ReadonlyMap<string, RowProblems>;
export type RowErrorsListener = (errors: RowErrors | null) => void;

/** How a single issue reads. The column is named, so a cell tooltip stands alone. */
function say(issue: RowIssue): string {
  return `${issue.label} ${issue.reason}`;
}

/** Group the issue list by row, and within a row by field. */
export function rowErrorsFrom(issues: readonly RowIssue[]): Map<string, RowProblems> {
  const byRow = new Map<string, RowIssue[]>();
  for (const i of issues) {
    const list = byRow.get(i.rowId);
    if (list) list.push(i);
    else byRow.set(i.rowId, [i]);
  }
  const out = new Map<string, RowProblems>();
  for (const [rowId, list] of byRow) {
    const fields = new Map<string, string>();
    for (const i of list) {
      // A cell can break two rules at once — empty AND rejected by a script.
      const had = fields.get(i.field);
      fields.set(i.field, had ? `${had} · ${say(i)}` : say(i));
    }
    out.set(rowId, { message: list.map(say).join(' · '), fields });
  }
  return out;
}

/** Why this cell is wrong, or undefined when it is not. */
export function problemAt(errors: RowErrors | null | undefined, rowId: string, field: string): string | undefined {
  return errors?.get(rowId)?.fields.get(field);
}

const errors = new Map<string, RowErrors>();
const listeners = new Map<string, Set<RowErrorsListener>>();

function announce(tableId: string): void {
  const set = listeners.get(tableId);
  if (!set || set.size === 0) return;
  const current = errors.get(tableId) ?? null;
  // Snapshot: a listener may release itself while being called.
  for (const fn of [...set]) {
    try {
      fn(current);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[row-errors] listener failed', err);
    }
  }
}

/**
 * Publish what a run found. Replaces the previous run's findings outright, which
 * is what "cleared on every run" means — a row repaired since the last press is
 * simply not in the new map.
 */
export function setRowErrors(tableId: string, found: RowErrors): void {
  if (found.size === 0) {
    clearRowErrors(tableId);
    return;
  }
  errors.set(tableId, found);
  announce(tableId);
}

/** Drop this table's findings, taking the cell marks and the filter with them. */
export function clearRowErrors(tableId: string): void {
  if (!errors.delete(tableId)) return;
  announce(tableId);
}

export function rowErrorsOf(tableId: string): RowErrors | null {
  return errors.get(tableId) ?? null;
}

/** Hear about this table's findings. Returns the release function. */
export function watchRowErrors(tableId: string, fn: RowErrorsListener): () => void {
  let set = listeners.get(tableId);
  if (!set) {
    set = new Set();
    listeners.set(tableId, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(tableId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(tableId);
  };
}

/** Test seam: forget every table's findings and every listener. */
export function __resetRowErrors(): void {
  errors.clear();
  listeners.clear();
}
