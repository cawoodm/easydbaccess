// packages/renderer/src/viz/viz-diagnose.ts
//
// "Why is this chart blank?" — answered in words, before the user has to guess.
//
// `viz-aggregate.ts` already catches a channel mapped to a field NO column
// carries (the renamed-column case). This module catches the other half, which is
// commoner and was silent: a channel mapped to a column that exists and is
// simply EMPTY. Picking the wrong column from a dropdown of a dozen is easy, and
// the result was a blank pane indistinguishable from a broken feature.
//
// Pure — no DOM, no store — so the wording is unit-tested rather than eyeballed.
//
// The distinction worth keeping is between two blanks that need different advice:
//
//   - **The column has no values.** Nothing the chart's own options can fix; the
//     user mapped the wrong column and needs to remap.
//   - **The column has values but nothing survived filtering.** For a word cloud
//     that means the stop list, the minimum length or the numbers-excluded rule
//     ate everything — all of which ARE adjustable, so the message points there
//     instead of at the mapping.

import type { ColumnSpec, Row } from '@easydb/shared';

/** One channel the visualization actually reads, resolved to a column. */
export interface MappedChannel {
  /** Channel key, e.g. `CATEGORY`. */
  channel: string;
  /** Human label from the channel spec, e.g. "Category (group by)". */
  label: string;
  /** The column field it is mapped to. */
  field: string;
}

/** Is this cell "no value" for charting purposes? Mirrors the aggregator's rule. */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  // An empty list is an absent list — the same reading `array-cell.ts` applies.
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** How many of these rows carry a value in `field`. */
export function countNonEmpty(rows: readonly Row[], field: string): number {
  let n = 0;
  for (const r of rows) if (!isBlank(r.data[field])) n++;
  return n;
}

/**
 * The channels whose mapped column is empty across every row.
 *
 * Returns labels rather than keys, because the message is read by whoever picked
 * the column and they picked it by label.
 */
export function emptyChannels(rows: readonly Row[], columns: readonly ColumnSpec[], mapped: readonly MappedChannel[]): Array<{ label: string; column: string }> {
  if (rows.length === 0) return [];
  const byField = new Map(columns.map((c) => [c.field, c]));
  const out: Array<{ label: string; column: string }> = [];
  for (const m of mapped) {
    if (!m.field) continue; // unmapped is a different message
    if (!byField.has(m.field)) continue; // missing column is the aggregator's message
    if (countNonEmpty(rows, m.field) === 0) {
      out.push({ label: m.label, column: byField.get(m.field)?.label || m.field });
    }
  }
  return out;
}

const plural = (n: number): string => n.toLocaleString();

/**
 * The sentence for one or more empty channels, or null when there is nothing to
 * say. Callers render it as-is.
 */
export function emptyChannelNote(empties: ReadonlyArray<{ label: string; column: string }>, rowCount: number): string | null {
  if (empties.length === 0) return null;
  const rows = `${plural(rowCount)} ${rowCount === 1 ? 'row' : 'rows'}`;
  if (empties.length === 1) {
    const e = empties[0] as { label: string; column: string };
    return `Nothing to show: the column “${e.column}” is empty in all ${rows}. Pick a different column for ${e.label} with Edit.`;
  }
  const list = empties.map((e) => `“${e.column}”`).join(' and ');
  return `Nothing to show: the columns ${list} are empty in all ${rows}. Pick different columns with Edit.`;
}

/**
 * Why a word cloud came out with no terms, given that its column DOES hold text.
 *
 * Separate from `emptyChannelNote` because the fix is different: these are the
 * cloud's own options, all editable behind the Chart button, so saying "pick a
 * different column" would send the user the wrong way.
 */
export function noTermsNote(opts: { minLength: number; stopWordsOn: boolean; numbersExcluded: boolean }): string {
  const reasons: string[] = [];
  if (opts.minLength > 1) reasons.push(`shorter than ${opts.minLength} characters`);
  if (opts.stopWordsOn) reasons.push('a common word (the, and, of…)');
  if (opts.numbersExcluded) reasons.push('a number');
  const tail = reasons.length > 0 ? ` Every word was ${reasons.join(', or ')}.` : '';
  return `No words left to show.${tail} Adjust the word rules with Chart, or map a different column with Edit.`;
}
