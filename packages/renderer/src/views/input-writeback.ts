// packages/renderer/src/views/input-writeback.ts
//
// What an `$input.FIELD` control's change means: read the control, check the
// value against the column's rules, write the cell.
//
// It was inside `view-window.ts` (`onInputChange`), where a view template's
// inputs are the only caller. A record pane's inputs are the same controls
// produced by the same `renderInput`, carrying the same three data attributes —
// so the alternative was a second copy of the parsing and a second, slightly
// different answer to "may this be written".
//
// **The rules are the grid's, not this module's invention.** `data-table.ts`'s
// `commitCell` is the reference and `commandlet-run.ts`'s `saveField` already
// mirrors it once (v0.0.454). A value a user cannot type into a cell must not be
// writable through a template either, or the template becomes a way round the
// column's own constraints.
//
// One rule the grid has that cannot be honoured here: `unique` is checked
// against the rows the caller holds. A record pane holds one row, so it cannot
// see a duplicate — `validateValue` is given the rows anyway where the caller has
// them, and an empty list simply means that one check does not run. Saying so is
// better than pretending; see the note in `validate-value.ts`.
//
// DOM-aware only in `readInputValue`, which takes the element. The decision half
// is pure and tested in plain Node.

import type { ColumnSpec, Row } from '@easydb/shared';
import { activeColumnScript } from '@easydb/shared';
import { validateValue } from '../table/validate-value.js';

/** The three data attributes `renderInput` writes onto every `$input` control. */
export interface InputTarget {
  rowId: string;
  field: string;
  /** The column's `ColumnType`, as the control recorded it. */
  type: string;
}

/**
 * What an `$input` control is asking to write, once it has been read.
 *
 * Deliberately NOT an `InputTarget` with a value bolted on: `type` says how the
 * control's text was parsed, which is over by the time anything here runs. The
 * decision half takes the column's own spec instead, so a caller that never had
 * a DOM control — a commandlet, a test — can ask the same question.
 */
export interface InputEdit {
  rowId: string;
  field: string;
  value: unknown;
}

/** Why a write was refused, or `null` when it may go ahead. */
export type WriteVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The target of a change event, or null when the event was not one of ours.
 *
 * A record pane's container holds the user's own markup, so a `change` can come
 * from anything they put in it. The class is what says "this control was
 * produced by an `$input` token".
 */
export function inputTargetOf(el: unknown): InputTarget | null {
  if (!(el instanceof HTMLInputElement) || !el.classList.contains('eda-input')) return null;
  const rowId = el.getAttribute('data-eda-row') ?? '';
  const field = el.getAttribute('data-eda-field') ?? '';
  if (!rowId || !field) return null;
  return { rowId, field, type: el.getAttribute('data-eda-type') ?? 'string' };
}

/**
 * The value a control is holding, typed by the column it is bound to.
 *
 * A number that will not parse is kept as the TEXT the user typed rather than
 * becoming `NaN`: the validator then rejects it with a sentence naming the
 * column, which is more use than a cell that silently reads `NaN`. An empty
 * number box is null, not 0 — "no value" and "zero" are different answers.
 */
export function readInputValue(el: HTMLInputElement, type: string): unknown {
  if (type === 'boolean') return el.checked;
  if (type === 'number') {
    if (el.value.trim() === '') return null;
    const n = Number(el.value);
    return Number.isNaN(n) ? el.value : n;
  }
  return el.value;
}

/**
 * May this edit be written?
 *
 * Four refusals, in the order they cost least to check:
 *
 *  1. the whole view or pane is read-only,
 *  2. the table is read-only — `Table.readonly`, which the record form reads too,
 *  3. the column is read-only, or is COMPUTED by an active render script: a
 *     scripted cell has nowhere to write back to, and the grid greys it out for
 *     the same reason (`substituteRow` already disables the control, so this is
 *     the second lock on the same door),
 *  4. the column's own rules, through `validateValue` — the sentence it returns
 *     is the one the user sees, unchanged.
 */
export function mayWrite(
  edit: InputEdit,
  col: ColumnSpec | undefined,
  row: Row | undefined,
  opts: { readonly?: boolean | undefined; tableReadonly?: boolean | undefined; allRows?: readonly Row[] | undefined } = {},
): WriteVerdict {
  if (opts.readonly === true) return { ok: false, reason: 'This view is read-only.' };
  if (opts.tableReadonly === true) return { ok: false, reason: 'This table is read-only.' };
  if (!col) return { ok: false, reason: `There is no column called "${edit.field}".` };
  if (!row) return { ok: false, reason: 'That record is no longer here.' };
  if (col.readonly === true) return { ok: false, reason: `${col.label || col.field} is read-only.` };
  if (activeColumnScript(col) !== undefined) {
    return { ok: false, reason: `${col.label || col.field} is written by its column script, so it cannot be edited here.` };
  }
  const why = validateValue(col, edit.value, opts.allRows ?? [], edit.rowId, row);
  return why === null ? { ok: true } : { ok: false, reason: why };
}

/**
 * The patch a permitted edit becomes.
 *
 * Spread over the row's existing `data` rather than a single-key patch, matching
 * what the view window has always written: the store's `patch` replaces `data`
 * wholesale, so a partial object would drop every other field.
 */
export function patchFor(edit: InputEdit, row: Row): { data: Record<string, unknown>; updatedAt: number } {
  return { data: { ...row.data, [edit.field]: edit.value }, updatedAt: Date.now() };
}
