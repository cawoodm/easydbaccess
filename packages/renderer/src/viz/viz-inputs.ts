// packages/renderer/src/viz/viz-inputs.ts
//
// What a visualization actually reads off a `Table`, as a comparable key.
//
// `viz-panel` subscribes to the whole `tables` collection so a column rename, a
// type change or a new script reaches the chart the same way it reaches the grid.
// But most writes to a table record are not about the data at all: resizing a
// column persists `width` on every ColumnSpec, and that write fired the same
// subscription, re-rendered the panel and made a word cloud re-run its layout
// and a map re-fit its bounds. Optics are not data.
//
// So the subscription asks this module "did anything I draw from change?" first.
// A key rather than a predicate because the caller has to REMEMBER the last
// answer, and a string it can hold is simpler than a snapshot of columns it then
// has to keep from aliasing.
//
// Pure, so it is unit-testable — the DataStore is not.

import type { ColumnSpec } from '@easydb/shared';
import { activeColumnScript } from '@easydb/shared';

/**
 * The ColumnSpec fields that change what is DRAWN. Everything else on a
 * `ColumnSpec` is grid presentation or metadata:
 *
 *  - `width` — the one this exists for;
 *  - `hidden`, `sortable`, `filterable`, `readonly` — grid behaviour. A chart
 *    plots the column its channel is mapped to whether or not the grid shows it;
 *  - `description`, `units`, `renderer`, `validate`, `default`, `max`, `unique`,
 *    `notnull` — never read by `viz-panel` or by any element under `viz/`.
 *
 * Listing what MATTERS rather than what to ignore is deliberate: a new
 * presentation field then defaults to "does not redraw the chart", and a new
 * field that a visualization does read has to be added here — which is the review
 * that catches it. The cost of being wrong either way is one stale or one wasted
 * redraw, never a wrong picture: the rows themselves come from a different
 * subscription.
 */
function columnKey(c: ColumnSpec): string {
  // `label` is in because a chart's axis and legend are labelled with it, and
  // `type` because it decides how a cell is read as a number or a date.
  // The script comes in as what would actually RUN, so switching it off redraws
  // the chart with the stored (empty) column, exactly as switching it on redraws
  // with the computed one.
  return JSON.stringify([c.field, c.label, c.type, activeColumnScript(c) ?? '']);
}

/**
 * A key over the columns of a table, ignoring anything only the grid cares about.
 *
 * Order is significant — it is the order channels are offered in and the order a
 * `data: 'rows'` visualization walks — so this is not sorted.
 */
export function vizColumnsKey(columns: readonly ColumnSpec[] | undefined): string {
  return (columns ?? []).map(columnKey).join('');
}
