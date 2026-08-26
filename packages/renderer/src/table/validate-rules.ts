// packages/renderer/src/table/validate-rules.ts
//
// The rules a column can carry — `notnull`, `max`, `unique` and a `validate`
// script — applied to rows, in ONE place.
//
// There were two half-implementations before this: the columns editor's Save
// pre-flight (`scanConstraintViolations`, in-memory, declarative rules only) and
// the per-edit check the grid runs on one cell. Neither could answer "is this
// whole table clean?", and a third copy for the Validate button would have been
// the second chance for two of them to drift into disagreeing about what `max`
// means. So the rules live here and both callers use them.
//
// The unique rule is why this is a stateful validator and not a pure function per
// row: a duplicate is only visible in the light of every row already seen.

import type { ColumnSpec, Row } from '@easydb/shared';
import { activeValidateScript } from '@easydb/shared';
import { runValidateScript } from '../util/column-script.js';

export type IssueKind = 'notnull' | 'max' | 'unique' | 'script';

/** One rule broken by one value. */
export interface RowIssue {
  /** Row position in the table, 1-based — what a message can name. */
  row: number;
  /** The row's own id, for a caller that wants to reach the row itself. */
  rowId: string;
  /** How a human recognizes the row: the label column's value, else `Row 12`. */
  key: string;
  field: string;
  label: string;
  value: unknown;
  kind: IssueKind;
  reason: string;
}

export interface ValidatorOptions {
  /** Field whose value names a row. Absent ⇒ rows are named by position. */
  labelField?: string | undefined;
  /**
   * Stop collecting after this many issues from one column. 0 ⇒ no cap.
   *
   * A script that throws for every row would otherwise return one issue per row:
   * 609,283 of them, all saying the same thing. The count that was dropped is
   * reported instead — see {@link Validator.capped}.
   */
  capPerColumn?: number;
  /**
   * Run the `validate` scripts too. Off by default, because the columns editor's
   * Save pre-flight must not start running a script over every row: nothing in
   * the app did that before the Validate button, and a Save is not the place to
   * find out.
   */
  runScripts?: boolean;
}

export interface Validator {
  /** Check one row. `index` is 0-based and only used to name the row. */
  check(row: Row, index: number): RowIssue[];
  /** How many issues the cap dropped, per column label. */
  capped(): Map<string, number>;
  /** Columns carrying a rule at all. Empty ⇒ nothing to check. */
  readonly fields: readonly string[];
  /** True when a script has to run — the part no store could answer for us. */
  readonly needsScripts: boolean;
}

/** Is this value absent as far as `notnull` is concerned? */
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Does this column carry any rule worth a pass over the rows? */
function hasRule(c: ColumnSpec, runScripts: boolean): boolean {
  return c.notnull === true || (c.max != null && c.max > 0) || c.unique === true || (runScripts && activeValidateScript(c) !== undefined);
}

/**
 * A validator for one table's columns.
 *
 * Feed it every row in order. It reports the issues in each row as it goes, so a
 * caller streaming a big table never holds more than its own results.
 */
export function createValidator(columns: readonly ColumnSpec[], opts: ValidatorOptions = {}): Validator {
  const runScripts = opts.runScripts === true;
  const cap = opts.capPerColumn ?? 0;
  const rules = columns.filter((c) => hasRule(c, runScripts));
  // First value → the row that had it, so a duplicate can name its twin.
  const seen = new Map<string, Map<unknown, string>>();
  const found = new Map<string, number>();
  const dropped = new Map<string, number>();
  for (const c of rules) if (c.unique) seen.set(c.field, new Map());

  return {
    fields: rules.map((c) => c.field),
    needsScripts: runScripts && rules.some((c) => activeValidateScript(c) !== undefined),
    capped: () => new Map(dropped),
    check(row: Row, index: number): RowIssue[] {
      const out: RowIssue[] = [];
      const position = index + 1;
      const labelValue = opts.labelField ? row.data[opts.labelField] : undefined;
      const key = labelValue == null || labelValue === '' ? `Row ${position}` : String(labelValue);

      /** Record an issue unless this column has already reported its fill. */
      const add = (c: ColumnSpec, kind: IssueKind, reason: string, value: unknown) => {
        const already = found.get(c.field) ?? 0;
        if (cap > 0 && already >= cap) {
          dropped.set(c.label, (dropped.get(c.label) ?? 0) + 1);
          return;
        }
        found.set(c.field, already + 1);
        out.push({ row: position, rowId: row.id, key, field: c.field, label: c.label, value, kind, reason });
      };

      for (const c of rules) {
        const v = row.data[c.field];

        if (c.notnull && isBlank(v)) add(c, 'notnull', 'is empty', v);

        if (c.max != null && c.max > 0) {
          // `max` means length for text and magnitude for a number — the same
          // split the per-cell check and the column editor use.
          if (typeof v === 'string' && v.length > c.max) add(c, 'max', `length ${v.length} is over the maximum of ${c.max}`, v);
          else if (typeof v === 'number' && v > c.max) add(c, 'max', `value ${v} is over the maximum of ${c.max}`, v);
        }

        if (c.unique) {
          const values = seen.get(c.field)!;
          // A blank is not a duplicate. Two empty cells are two rows nobody filled
          // in, which is what `notnull` is for.
          if (!isBlank(v) && v !== '') {
            const twin = values.get(v);
            if (twin !== undefined) add(c, 'unique', `duplicates ${twin}`, v);
            else values.set(v, key);
          }
        }

        const rule = runScripts ? activeValidateScript(c) : undefined;
        if (rule !== undefined) {
          // Fed the row itself: `runValidateScript` takes the value and the row,
          // and a scan of an unedited row is the row as stored.
          const verdict = runValidateScript(rule, v, row.data);
          if (!verdict.ok) add(c, 'script', verdict.message ?? 'rejected by this column’s validation script', v);
        }
      }
      return out;
    },
  };
}

/**
 * The Save pre-flight's message list: `Row 3: Name is empty.`
 *
 * Kept in the shape the columns editor already showed, so the rules could move
 * here without changing what that dialog says.
 */
export function issueMessages(issues: readonly RowIssue[]): string[] {
  return issues.map((i) => `Row ${i.row}: ${i.label} ${i.reason}.`);
}

/** `3 empty, 1 too long` — the per-kind tally for a summary line. */
export function countByKind(issues: readonly RowIssue[]): Map<IssueKind, number> {
  const out = new Map<IssueKind, number>();
  for (const i of issues) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
  return out;
}

const KIND_WORDS: Record<IssueKind, string> = {
  notnull: 'empty',
  max: 'over the maximum',
  unique: 'duplicated',
  script: 'rejected by a script',
};

/**
 * The order kinds are named in, and it is fixed rather than the order they were
 * met in. Rows are read in the store's own order, which nothing promises,
 * so an encounter order would word the same table's summary differently on every
 * run, and a user comparing two runs would read that as a change in the data.
 */
const KIND_ORDER: IssueKind[] = ['notnull', 'max', 'unique', 'script'];

/**
 * One line per column, in plain words, plus what the cap dropped.
 *
 * `columns` fixes the order of the LINES for the same reason `KIND_ORDER` fixes
 * the words: the grid's column order is one the user recognizes, and read order is
 * not an order at all. Without it the lines keep the order the issues arrived in.
 */
export function summarizeIssues(issues: readonly RowIssue[], capped: Map<string, number>, columns: readonly ColumnSpec[] = []): string[] {
  const byColumn = new Map<string, RowIssue[]>();
  for (const i of issues) {
    const list = byColumn.get(i.label);
    if (list) list.push(i);
    else byColumn.set(i.label, [i]);
  }
  const order = columns.map((c) => c.label);
  const labels = [...byColumn.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia < 0 || ib < 0) return 0;
    return ia - ib;
  });

  const lines: string[] = [];
  for (const label of labels) {
    const list = byColumn.get(label)!;
    const counts = countByKind(list);
    const kinds = KIND_ORDER.filter((k) => counts.has(k)).map((k) => `${counts.get(k)!.toLocaleString()} ${KIND_WORDS[k]}`);
    const missed = capped.get(label);
    lines.push(`${label}: ${kinds.join(', ')}${missed ? ` (and ${missed.toLocaleString()} more not listed)` : ''}`);
  }
  return lines;
}
