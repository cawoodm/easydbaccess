// packages/renderer/src/viz/viz-tokens.ts
//
// `$TOKEN` for a visualization: the same SPELLING a view template uses, with the
// scope moved from one row to the whole set.
//
// A view's row fragment is repeated once per row and `views/view-render.ts`
// fills it from THAT row. A visualization has no such row — a KPI tile, a pill
// strip and a summary line are all statements about the dataset — so reusing
// `substituteRow` here would have produced a per-row repeat, which is exactly
// what a view window already is. Same spelling, different scope; nothing is
// shared between the two beyond the `eda-filter-pill` markup contract, which is
// deliberate so a pill looks and behaves the same wherever it appears.
//
// The vocabulary is CLOSED, and that is what lets an unrecognised `$WORD` be
// left alone rather than blanked. In a view a token comes from the mapping
// dialog, so an unmapped one is a half-finished configuration and printing a raw
// `$TOKEN` at the user is noise. Here the user writes the whole document by
// hand, `$` is ordinary text in CSS and JS, and a typo (`$COUTN`) that silently
// vanished would be much harder to spot than one left on screen.
//
// Tokens name COLUMNS DIRECTLY, not mapping keys. A custom visualization
// declares `channels: []` — there is no mapping dialog to go through — so
// `$SUM.amount` means the column called `amount`. The match is case-insensitive
// as a fallback, so `$filter.COUNTRY` finds `country` and the token row reads
// the way the rest of the vocabulary is written.
//
// Pure: no DOM, no store. Unit-tested in Node like `view-render.ts`.

import type { ColumnSpec, Row } from '@easydb/shared';
import { arrayMembers } from '@easydb/shared';

/**
 * `$NAME` or `$NAME.ARG` — the head names the function (or `filter`), the
 * argument names the column. `:` is accepted for the separator as well as `.`,
 * matching `view-render.ts`'s `$input:TOKEN`.
 */
const VIZ_TOKEN_RE = /\$([A-Za-z_][A-Za-z0-9_]*)(?:[.:]([A-Za-z_][A-Za-z0-9_]*))?/g;

/** Aggregates that take a column. `COUNT` is handled apart — it takes none. */
const AGGREGATES = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT', 'COUNT']);

/**
 * Pills emitted for one `$filter.FIELD` before the rest are summarised.
 *
 * A pill row is a header, and a column with a thousand distinct values would
 * fill the pane with them and push the picture off screen. The cap is generous
 * enough that a real category column is never truncated and the count that
 * follows says when it was.
 */
export const MAX_PILLS = 50;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A number, or null when the cell is not one. Booleans are not numbers here. */
function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Is this cell "no value"? The same reading `viz-diagnose.ts` applies. */
function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * How a number is written into the HTML.
 *
 * Locale-formatted, because these land in a KPI tile a human reads, and capped
 * at two decimals so an average of 3.333333333333333 does not become the widest
 * thing in the pane. An exact figure is what the CSV export is for.
 */
function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** The error chip a bad token renders, mirroring the grid's broken-script mark. */
function errorChip(message: string, label: string): string {
  return `<span class="eda-token-error" title="${escapeAttr(message)}">⚠ ${escapeHtml(label)}</span>`;
}

/**
 * The column a token's argument names: exact field match first, then
 * case-insensitive, then a key some row actually carries.
 *
 * The last fallback matters for a table whose columns were never declared (an
 * import that has not been through the columns editor) — the rows hold the data
 * either way, and refusing to read it because no `ColumnSpec` exists would be a
 * distinction the user cannot see.
 */
function resolveField(name: string, rows: readonly Row[], columns: readonly ColumnSpec[]): string | null {
  if (columns.some((c) => c.field === name)) return name;
  const ci = columns.find((c) => c.field.toLowerCase() === name.toLowerCase());
  if (ci) return ci.field;
  for (const r of rows) {
    if (Object.hasOwn(r.data, name)) return name;
    const key = Object.keys(r.data).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) return key;
  }
  return null;
}

/**
 * The values of one column across the set, one entry per row — INCLUDING the
 * blanks, which `MIN`/`AVG` must skip but `COUNT` must not.
 */
function columnValues(rows: readonly Row[], field: string): unknown[] {
  return rows.map((r) => r.data[field]);
}

/**
 * Every distinct value of a column, as text.
 *
 * A list cell contributes each MEMBER separately, for the same reason
 * `view-render.ts` renders one pill per member: a filter on `=a,b` matches
 * nothing, and a tags column's whole point is that a row belongs to several
 * groups at once. Blanks are dropped — there is no pill for an empty cell.
 *
 * Sorted, numerically where both sides look numeric. A pill row is chrome, and
 * ordering it by first appearance would have made the pills jump every time the
 * grid re-sorted underneath.
 */
export function distinctValues(rows: readonly Row[], field: string, spec?: ColumnSpec | undefined): string[] {
  const seen = new Set<string>();
  for (const v of columnValues(rows, field)) {
    const members = spec?.type === 'array' || Array.isArray(v) ? arrayMembers(v) : null;
    if (members) {
      for (const m of members) if (!isBlank(m)) seen.add(String(m));
      continue;
    }
    if (!isBlank(v)) seen.add(String(v));
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * One aggregate over the set, already formatted — or `''` when there is nothing
 * to state.
 *
 * `COUNT` and `DISTINCT` always answer, because zero is a true count. The rest
 * are blank when no value is usable: a `$SUM.price` of `0` over a column holding
 * no numbers reads as a real total of nothing, which is a lie.
 *
 * `MIN`/`MAX` compare numerically when every value in play is a number and as
 * text otherwise, the rule `view-render.ts`'s `sortRows` uses — so the extremes
 * of a version column are the ones a reader would pick out by eye.
 */
export function aggregate(fn: string, rows: readonly Row[], field: string, spec?: ColumnSpec | undefined): string {
  const upper = fn.toUpperCase();
  if (upper === 'DISTINCT') return formatNumber(distinctValues(rows, field, spec).length);
  const values = columnValues(rows, field).filter((v) => !isBlank(v));
  if (upper === 'COUNT') return formatNumber(values.length);
  if (values.length === 0) return '';
  const numbers = values.map(asNumber).filter((n): n is number => n !== null);
  if (upper === 'SUM' || upper === 'AVG') {
    if (numbers.length === 0) return '';
    const total = numbers.reduce((a, b) => a + b, 0);
    return formatNumber(upper === 'SUM' ? total : total / numbers.length);
  }
  const allNumeric = numbers.length === values.length;
  if (allNumeric) return formatNumber(upper === 'MIN' ? Math.min(...numbers) : Math.max(...numbers));
  const texts = values.map((v) => String(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return escapeHtml((upper === 'MIN' ? texts[0] : texts[texts.length - 1]) ?? '');
}

/**
 * One clickable pill. Identical markup to a view's pill (`view-render.ts`) —
 * same class, same data attributes — so one stylesheet and one click handler
 * shape serve both, and a user who has met a pill in a view meets the same
 * thing here.
 */
function pillButton(field: string, text: string): string {
  const field_ = escapeAttr(field);
  const value_ = escapeAttr(text);
  return `<button type="button" class="eda-filter-pill" data-eda-filter-field="${field_}" data-eda-filter-value="${value_}" title="Filter by ${field_}: ${value_}">${escapeHtml(text)}</button>`;
}

/** The pills for one `$filter.FIELD`, capped and honest about the cap. */
function filterPills(rows: readonly Row[], field: string, spec: ColumnSpec | undefined): string {
  const values = distinctValues(rows, field, spec);
  const shown = values.slice(0, MAX_PILLS);
  const rest = values.length - shown.length;
  const more = rest > 0 ? `<span class="eda-pill-more" title="${escapeAttr(`${rest} more value(s) not shown`)}">+${formatNumber(rest)}</span>` : '';
  return shown.map((v) => pillButton(field, v)).join('') + more;
}

/**
 * The fields a template offers a `$filter.` pill for, in the order they appear.
 *
 * Names as WRITTEN, not resolved — the caller has the rows and columns needed to
 * resolve them, and this is used for diagnostics where the raw spelling is what
 * the reader has to compare against.
 */
export function vizFilterFields(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(VIZ_TOKEN_RE)) {
    if (m[1]?.toLowerCase() === 'filter' && m[2] && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

/**
 * Replace every recognised `$TOKEN` in `html` with a statement about `rows`.
 *
 * | Token             | Becomes                                              |
 * | ----------------- | ---------------------------------------------------- |
 * | `$COUNT`          | how many rows the pane was given                     |
 * | `$COUNT.field`    | how many of them carry a value in that column        |
 * | `$SUM.field`      | numeric total                                        |
 * | `$AVG.field`      | mean                                                 |
 * | `$MIN.field` / `$MAX.field` | the extremes                               |
 * | `$DISTINCT.field` | how many different values the column holds           |
 * | `$filter.field`   | one clickable pill per distinct value                |
 *
 * A recognised function naming a column that does not exist renders an error
 * chip, not a blank — the commonest way this goes wrong is a renamed or
 * mistyped column, and a silently empty tile is indistinguishable from a
 * genuinely empty one. Anything outside the vocabulary is left exactly as
 * written; see the note at the top of this file.
 */
export function substituteVizTokens(html: string, rows: readonly Row[], columns: readonly ColumnSpec[] = []): string {
  const byField = new Map(columns.map((c) => [c.field, c]));
  return html.replace(VIZ_TOKEN_RE, (full, head: string, arg: string | undefined) => {
    const isFilter = head.toLowerCase() === 'filter';
    const upper = head.toUpperCase();
    if (!isFilter && !AGGREGATES.has(upper)) return full;
    if (!arg) {
      // `$COUNT` alone is the row count. Every other head needs a column, and
      // without one it is not a token this vocabulary knows.
      return upper === 'COUNT' ? formatNumber(rows.length) : full;
    }
    const field = resolveField(arg, rows, columns);
    if (!field) return errorChip(`No column named “${arg}”.`, `no column ${arg}`);
    const spec = byField.get(field);
    return isFilter ? filterPills(rows, field, spec) : aggregate(upper, rows, field, spec);
  });
}
