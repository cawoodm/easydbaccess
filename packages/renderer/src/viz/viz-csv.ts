// packages/renderer/src/viz/viz-csv.ts
//
// A visualization's data as CSV — the numbers behind the picture.
//
// A chart is a summary, and the summary is often the thing worth keeping: the
// word counts, the totals per category. They exist nowhere else in the workspace
// (aggregation happens at draw time and is never stored), so without this the
// only way out is to read them off the screen.
//
// **The CSV dialect is duplicated from `plugins/csv-export.ts` on purpose.** That
// is a plugin and this is core; a core module importing a plugin would invert the
// plugin model, the same reason `table/grid-settings.ts` and
// `viz/viz-settings.ts` exist as separate namespaces. It is eight lines of
// escaping that mirror the CSV IMPORTER's parser, and the two have not diverged
// in this codebase's life — but they must stay the same dialect: comma delimiter,
// CRLF terminators, double-quote escaping for any cell holding a comma, quote or
// newline.
//
// Pure: no DOM, no store, so the escaping rules are unit-tested directly.

import type { VizFrame } from './viz-aggregate.js';
import type { CloudTerm, MapPoint } from './elements/chart-data.js';

function cell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = typeof v === 'number' || typeof v === 'string' ? String(v) : JSON.stringify(v);
  if (s === '') return '';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of values to a CSV document. */
export function toCsv(rows: ReadonlyArray<readonly unknown[]>): string {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** A word cloud: one row per term, most frequent first (the order it was ranked). */
export function termsToCsv(terms: readonly CloudTerm[]): string {
  return toCsv([['Word', 'Count'], ...terms.map((t) => [t.term, t.count])]);
}

/**
 * A categorical chart: one row per category, one column per series.
 *
 * A `null` point stays EMPTY rather than becoming 0 — the frame distinguishes
 * "no usable value" from zero, and flattening that here would put numbers in the
 * file that the chart never drew.
 */
export function frameToCsv(frame: VizFrame): string {
  const header = ['Category', ...frame.series.map((s) => s.label)];
  const body = frame.categories.map((c, i) => [c.label, ...frame.series.map((s) => s.points[i] ?? '')]);
  return toCsv([header, ...body]);
}

/** A map: one row per plotted point. */
export function pointsToCsv(points: readonly MapPoint[]): string {
  const hasLabel = points.some((p) => p.label != null && p.label !== '');
  const hasWeight = points.some((p) => p.weight != null);
  const header = ['Latitude', 'Longitude', ...(hasLabel ? ['Label'] : []), ...(hasWeight ? ['Weight'] : [])];
  const body = points.map((p) => [p.lat, p.lon, ...(hasLabel ? [p.label ?? ''] : []), ...(hasWeight ? [p.weight ?? ''] : [])]);
  return toCsv([header, ...body]);
}

/**
 * A filename for a visualization's export.
 *
 * Sanitised the same way a table name is for a `.db` file: anything that is not
 * a letter, digit, dash or underscore becomes a dash, because this string reaches
 * a filesystem.
 */
export function csvFilename(vizName: string): string {
  const slug = vizName
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'visualization' : slug}.csv`;
}
