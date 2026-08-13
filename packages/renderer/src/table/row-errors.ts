// packages/renderer/src/table/row-errors.ts
//
// What the last Validate run found, held per table, and shown as a column the
// store never sees.
//
// The first version of the ✓ button wrote its findings into a second table,
// `<name> issues`. That table filtered, sorted and exported — it was a table —
// but it was the wrong place to FIX anything: the row needing the edit is in the
// table the user was already looking at, and a copy of a problem goes stale the
// moment they repair it. So the findings come back as a column of the table
// itself, `_error`, and the grid filters on that. Fixing a row is then editing
// the cell beside the message.
//
// **Nothing here is persisted.** No row's `data._error` is ever written to the
// store: the grid merges the message into the rows it already holds, on their way
// to the screen. So a verdict cannot be exported by accident, cannot sync to
// another device, and cannot outlive the data it judged. A `render` script sees
// `row._error` like any other field, which is the way out for a user who does
// want it kept — write it into a column of their own.
//
// The registry is a plain map with listeners, for the reason `visible-rows.ts`
// gives: the producer (the Validate plugin) and the consumer (the grid) know each
// other, publishing has to be conditional, and a module with no `document` in it
// can be unit-tested in this repo's DOM-free vitest.

import type { ColumnSpec, Row } from '@easydb/shared';
import type { RowIssue } from './validate-rules.js';

/**
 * The field the messages arrive under.
 *
 * Leading underscore because it is not the user's column: it marks the field as
 * the app's own, the way `_id` does elsewhere, and it keeps the name clear of a
 * real column called "error" that a user may already have.
 */
export const ERROR_FIELD = '_error';

/** Filter expression for "this row has a message" — see `column-filter.ts`. */
export const ERROR_FILTER = '!NULL';

/**
 * The column the grid appends while a table has messages.
 *
 * `text`, so its funnel offers no value list: every message is different and too
 * long to browse, so the list would be one option per row (the rule
 * `search/facet-values.ts` documents). Typing in the funnel still narrows, which
 * is how a user reads "just the duplicates".
 *
 * `readonly`, because a message is derived. There is nowhere to write an edit of
 * it back to.
 */
export function errorColumnSpec(): ColumnSpec {
  return { field: ERROR_FIELD, label: 'Problem', type: 'text', readonly: true, description: 'What Validate found in this row. Not stored — press ✓ again to refresh it.' };
}

/** Several problems in one row, as one cell. */
function joinReasons(issues: readonly RowIssue[]): string {
  return issues.map((i) => `${i.label} ${i.reason}`).join(' · ');
}

/**
 * The issue list as one message per row.
 *
 * Grouped by row, not by column, because the column is already named inside each
 * message and the row is what the grid shows.
 */
export function rowErrorsFrom(issues: readonly RowIssue[]): Map<string, string> {
  const byRow = new Map<string, RowIssue[]>();
  for (const i of issues) {
    const list = byRow.get(i.rowId);
    if (list) list.push(i);
    else byRow.set(i.rowId, [i]);
  }
  const out = new Map<string, string>();
  for (const [rowId, list] of byRow) out.set(rowId, joinReasons(list));
  return out;
}

export type RowErrors = ReadonlyMap<string, string>;
export type RowErrorsListener = (errors: RowErrors | null) => void;

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
 * Publish what a run found. Replaces the previous run's messages outright, which
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

/** Drop this table's messages, taking the column and its filter with them. */
export function clearRowErrors(tableId: string): void {
  if (!errors.delete(tableId)) return;
  announce(tableId);
}

export function rowErrorsOf(tableId: string): RowErrors | null {
  return errors.get(tableId) ?? null;
}

/** Hear about this table's messages. Returns the release function. */
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

/**
 * Merge the messages into rows on their way to the screen.
 *
 * A new object per row, never a write into the stored one: the rows a store hands
 * over are shared with whatever else is holding them (a live subscription, a
 * docked visualization), and stamping a field into those would be the persistence
 * this module exists to avoid.
 *
 * Rows with nothing to say get an EMPTY `_error`, not a missing one. A missing
 * field and an empty one already mean the same thing to the filter language
 * (`NULL` matches both), and the column reads better as blank than as undefined.
 */
export function decorateRows(rows: readonly Row[], found: RowErrors | null): Row[] {
  if (!found || found.size === 0) return rows as Row[];
  return rows.map((r) => ({ ...r, data: { ...r.data, [ERROR_FIELD]: found.get(r.id) ?? '' } }));
}

/** Test seam: forget every table's messages and every listener. */
export function __resetRowErrors(): void {
  errors.clear();
  listeners.clear();
}
