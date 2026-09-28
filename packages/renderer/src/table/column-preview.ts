// packages/renderer/src/table/column-preview.ts
//
// What a column editor's live preview SHOWS for each cell: the value after the
// column's `script` has run, and the reason the cell is wrong, if it is.
//
// Pure, and the whole rule — the element that draws the preview
// (`dialogs/column-preview-table.ts`) does the DOM and nothing else, so both
// column editors (the table's and a view's) agree on what a cell means.
//
// Three things a preview has to do that the first version of it did not:
//
//   1. Run the column SCRIPT. A scripted column is derived — the stored cell is
//      usually empty — so a preview reading the stored value showed a blank
//      column and no hint that the script was the thing being previewed.
//   2. Check the value the user will SEE. So the rules run over the computed
//      rows, not the stored ones: `notnull` on a scripted column asks whether
//      the script produced something, which is the only question that has an
//      answer there.
//   3. Run the `validate` script. It is edited in the same dialog, two clicks
//      from the preview, and until now was the one rule the preview ignored.
//
// The rules themselves are NOT redefined here. `createValidator` owns them —
// this module's own predecessor kept a second copy of what `max` means, which is
// exactly the drift `table/validate-rules.ts` was written to end.

import type { ColumnSpec, Row } from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';
import { withRowMeta } from '../views/row-meta.js';
import { createValidator } from './validate-rules.js';

/** Rows a preview reads. Enough to judge a column against real data, bounded so
 * a 600k-row table is not read to show a sample of it. */
export const PREVIEW_ROWS = 100;

/** One cell of the preview. */
export interface PreviewCell {
  /** What a renderer should draw: the script's result, else the stored value. */
  value: unknown;
  /** The stored cell, for a renderer that offers an editor on the source. */
  raw: unknown;
  /**
   * Set when the column's `script` did not produce a value. Shown INSTEAD of a
   * value, because there is no value — and a preview that showed the stored cell
   * here would be showing something the grid never will.
   */
  error: string | null;
  /** Why this cell breaks a rule, in words. Null when it is fine. */
  problem: string | null;
}

/**
 * The preview grid: one row of cells per row, one cell per column, in the order
 * `columns` gives.
 *
 * The caller has already decided which columns to show (hidden ones are the
 * table editor's business, a view's `visibleColumns` its own) and has re-keyed
 * the rows for any pending rename. This runs the scripts and the rules over what
 * it is given.
 */
export function previewCells(columns: readonly ColumnSpec[], rows: readonly Row[]): PreviewCell[][] {
  const scripted = columns.filter((c) => c.script?.trim());
  /** field → message, per row index. Only for columns whose script failed. */
  const failures: Array<Map<string, string>> = [];

  // The rows as the grid would show them: every script run, its result standing
  // in for the stored cell. A script that throws leaves the cell alone and is
  // recorded — the run is per row, so one bad row does not blank the column.
  const computed: Row[] = rows.map((r) => {
    if (scripted.length === 0) {
      failures.push(new Map());
      return r;
    }
    const failed = new Map<string, string>();
    const data = { ...r.data };
    for (const c of scripted) {
      const run = runColumnScript(c.script, withRowMeta(r));
      if (run.ok) data[c.field] = run.value;
      else failed.set(c.field, run.message ? `${run.label}: ${run.message}` : run.label);
    }
    failures.push(failed);
    return { ...r, data };
  });

  // `runScripts` is on here, unlike the Save pre-flight: a preview of a hundred
  // rows is the one place a validation script SHOULD run, since seeing it reject
  // real data is the reason to look.
  const validator = createValidator(columns, { runScripts: true });
  const problems: Array<Map<string, string>> = computed.map((r, i) => {
    const found = new Map<string, string>();
    for (const issue of validator.check(r, i)) {
      // First reason per cell. A value that is both empty and a duplicate has
      // one thing wrong with it as far as the person reading the grid is
      // concerned, and two tooltips do not fit in one cell.
      if (!found.has(issue.field)) found.set(issue.field, `${issue.label} ${issue.reason}`);
    }
    return found;
  });

  return computed.map((row, i) =>
    columns.map((c) => {
      const error = failures[i]?.get(c.field) ?? null;
      const value = row.data[c.field];
      return {
        value,
        raw: rows[i]?.data[c.field],
        error,
        // A failed script has no value, so nothing to check it against.
        problem: error ? null : (problems[i]?.get(c.field) ?? typeProblem(c, value)),
      };
    }),
  );
}

/** What trying a script against the preview rows found. */
export interface ScriptCheck {
  /** Rows it was tried on. `0` ⇒ there were none, so only a compile error counts. */
  total: number;
  failed: number;
  /** The first failure, ready to show. Empty when there is nothing to say. */
  message: string;
}

/**
 * Try a script against the rows the column editor is previewing, and say what
 * broke.
 *
 * The preview grid already marks each failing CELL, which answers "is this row
 * odd?". This answers the other question — "is my script wrong?" — from the same
 * evidence, so the script editor can say it while the script is being written
 * rather than after it has been saved and run over the whole table.
 *
 * **A compile error counts with no rows at all; a runtime error does not.**
 * `function render(row) { retrun x }` is broken whatever the data is, and
 * refusing to say so until a table has rows would leave the one unambiguous
 * error silent in `new table` mode. A script that THROWS on an empty object, by
 * contrast, is usually fine on real rows — `row.first.trim()` says nothing about
 * a table where `first` is always filled in — so it is not evidence and is not
 * reported.
 *
 * Pure, like the rest of this module.
 */
export function checkScriptOnRows(src: string | undefined, rows: readonly Row[]): ScriptCheck {
  if (!src || !src.trim()) return { total: rows.length, failed: 0, message: '' };

  if (rows.length === 0) {
    const run = runColumnScript(src, {});
    const broken = !run.ok && run.label === 'compile error';
    return { total: 0, failed: 0, message: broken && !run.ok ? describeRun(run.label, run.message) : '' };
  }

  let failed = 0;
  let message = '';
  for (const r of rows) {
    const run = runColumnScript(src, withRowMeta(r));
    if (run.ok) continue;
    failed++;
    if (!message) message = describeRun(run.label, run.message);
  }
  return { total: rows.length, failed, message };
}

function describeRun(label: string, message: string): string {
  return message ? `${label}: ${message}` : label;
}

/**
 * The script check as one sentence, or `null` when there is nothing to warn
 * about.
 *
 * Says how MANY rows broke, because the difference is the whole diagnosis: all
 * of them is a wrong script, one of them is a row with a surprise in it, and a
 * warning that did not distinguish the two would send people hunting in the
 * wrong place.
 */
export function scriptWarning(check: ScriptCheck): string | null {
  if (!check.message) return null;
  if (check.total === 0) return `This script will not run — ${check.message}`;
  if (check.failed >= check.total) return `This script fails on all ${check.total.toLocaleString()} preview ${check.total === 1 ? 'row' : 'rows'} — ${check.message}`;
  return `This script fails on ${check.failed.toLocaleString()} of ${check.total.toLocaleString()} preview rows — ${check.message}`;
}

/**
 * Does this value fit the column's TYPE?
 *
 * Deliberately not in `validate-rules.ts` with the others. A type mismatch is
 * not a rule the table carries — nothing rejects a write for it and the Validate
 * button does not report it. It matters in a column editor and only there,
 * because the type is what the user is changing, and "will `date` work on this
 * column?" is answerable only by looking at the data.
 */
function typeProblem(col: ColumnSpec, v: unknown): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const label = col.label || col.field;
  if (col.type === 'number' && typeof v !== 'number' && !Number.isFinite(Number(v))) return `${label} is not a number`;
  if (col.type === 'boolean' && typeof v !== 'boolean' && !/^(true|false|yes|no|0|1)$/i.test(String(v))) return `${label} is not true or false`;
  if ((col.type === 'date' || col.type === 'datetime') && Number.isNaN(new Date(String(v)).getTime())) return `${label} is not a date`;
  return null;
}

/** Height the preview opens at, before anyone drags its grip. */
export const PREVIEW_HEIGHT_DEFAULT = 200;

/** Smallest useful preview: the heading, a header row and about two rows. */
const PREVIEW_HEIGHT_MIN = 90;

/**
 * Keep a dragged preview height inside what the window can show.
 *
 * The upper bound is a share of the viewport rather than a constant, because the
 * grip trades space with the column list ABOVE it: dragged to the ceiling on a
 * short window the list would be a sliver, and the list is what the dialog is
 * for. The lower bound stops a stray drag from closing the preview to nothing,
 * which reads as "the preview broke" rather than "I resized it".
 */
export function clampPreviewHeight(px: number, viewportHeight: number): number {
  const max = Math.max(PREVIEW_HEIGHT_MIN, Math.round(viewportHeight * 0.7));
  return Math.min(max, Math.max(PREVIEW_HEIGHT_MIN, Math.round(px)));
}

/** Plain-text fallback for a cell with no renderer. */
export function previewText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
