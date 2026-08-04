// Pure helpers for the View system — no DOM, unit-testable.
//
// A View Template is three HTML fragments (header / row / footer). When the row
// fragment is present it's repeated per row with `$TOKEN` placeholders replaced
// by the row's mapped column values; otherwise the view falls back to a
// read-only columns table. These helpers cover token extraction, substitution,
// and the snapshotted filter/sort a view instance applies.

import type { ColumnSpec, Row, ViewInstance } from '@easydb/shared';
import {
  composeColumnFilter,
  matchesColumnFilter,
  parseColumnFilter,
  type FilterToken,
} from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';

/**
 * Matches a `$TOKEN` placeholder. An optional `input.` (or `input:`) prefix
 * marks the token as EDITABLE — it renders an `<input>` bound to the mapped
 * field instead of the read-only value. A `filter.` (or `filter:`) prefix
 * instead renders a clickable PILL — see {@link substituteRow}. Group 1 is the
 * prefix (or undefined), group 2 is the token NAME (letters/digits/underscore,
 * not starting with a digit); the name — without any prefix — is the mapping
 * key, so `$TITLE`, `$input.TITLE` and `$filter.TITLE` all map to the same
 * column but render read-only, editable, or as a filter pill.
 */
const TOKEN_RE = /\$((?:input|filter)[.:])?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Distinct token names (without the `$` or any `input.`/`filter.` prefix) found across the fragments. */
export function extractTokens(...fragments: string[]): string[] {
  const seen = new Set<string>();
  for (const frag of fragments) {
    if (!frag) continue;
    for (const m of frag.matchAll(TOKEN_RE)) seen.add(m[2]!);
  }
  return [...seen];
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string =>
  escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Coerce a stored cell value to a checkbox state (handles bool / number / common truthy strings). */
function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'y', 't', 'on'].includes(v.trim().toLowerCase());
  return false;
}

/**
 * Render an editable `<input>` for an `$input.TOKEN`, bound to the row's cell.
 * A boolean column becomes a checkbox, a number column a number input, anything
 * else a text input. Data attributes let the view window write changes back;
 * `readonly` disables the control. Wrapped in a `<label>` carrying the column's
 * caption so a bare checkbox still says what it toggles.
 */
function renderInput(
  field: string,
  value: unknown,
  rowId: string,
  spec: ColumnSpec | undefined,
  readonly: boolean,
): string {
  const type = spec?.type ?? 'string';
  const caption = escapeHtml(spec?.label || field);
  const attrs =
    `class="eda-input" data-eda-row="${escapeAttr(rowId)}" ` +
    `data-eda-field="${escapeAttr(field)}" data-eda-type="${escapeAttr(type)}"`;
  const dis = readonly ? ' disabled' : '';
  let control: string;
  if (type === 'boolean') {
    control = `<input type="checkbox" ${attrs}${coerceBool(value) ? ' checked' : ''}${dis} />`;
  } else {
    const inputType = type === 'number' ? 'number' : 'text';
    const val = value == null ? '' : escapeAttr(String(value));
    control = `<input type="${inputType}" ${attrs} value="${val}"${dis} />`;
  }
  return `<label class="eda-input-field" title="${caption}">${control}<span class="eda-input-label">${caption}</span></label>`;
}

/**
 * Render a `$filter.TOKEN` as a clickable pill showing the row's value for the
 * mapped field. Clicking it (wired up in the view window) OR-appends an
 * exact-match pill filter for that field/value. A null/empty value renders
 * nothing — there is no pill for an empty cell.
 */
function renderFilterPill(field: string, value: unknown): string {
  if (value == null || value === '') return '';
  const text = String(value);
  const field_ = escapeAttr(field);
  const value_ = escapeAttr(text);
  return (
    `<button type="button" class="eda-filter-pill" data-eda-filter-field="${field_}" ` +
    `data-eda-filter-value="${value_}" title="Filter by ${field_}: ${value_}">${escapeHtml(text)}</button>`
  );
}

/**
 * Replace every `$TOKEN` in `html` with the row's value for the column mapped to
 * that token. An `$input.TOKEN` instead renders an editable control (checkbox /
 * number / text) bound to the mapped field (see {@link renderInput}); a
 * `$filter.TOKEN` renders a clickable pill (see {@link renderFilterPill}).
 * Unmapped tokens (or null values) become an empty string, so a
 * partially-mapped template never shows a raw `$TOKEN`.
 *
 * Values are read straight from `row.data`, so pass a row that has been through
 * {@link evaluateRow} when the table has scripted columns.
 */
export function substituteRow(
  html: string,
  row: Row,
  mapping: Record<string, string>,
  opts: { columns?: Map<string, ColumnSpec>; readonly?: boolean } = {},
): string {
  return html.replace(TOKEN_RE, (_full, prefix: string | undefined, token: string) => {
    const field = mapping[token];
    if (!field) return '';
    const v = row.data[field];
    if (!prefix) return v == null ? '' : String(v);
    if (prefix.startsWith('filter')) return renderFilterPill(field, v);
    const spec = opts.columns?.get(field);
    // A scripted column is computed from the rest of the row, so there is
    // nowhere to write an edit back to — the grid treats such a cell as
    // read-only, and so does an `$input.TOKEN` bound to one.
    const readonly = opts.readonly === true || !!spec?.script?.trim();
    return renderInput(field, v, row.id, spec, readonly);
  });
}

function isEmpty(v: unknown): boolean {
  return v == null || v === '';
}

/**
 * A copy of `row` in which every scripted column carries what its script
 * returns, under the column's own field name.
 *
 * A scripted column stores nothing: the grid computes its cell from the whole
 * row on render. A view read the STORED value, so a computed column came out
 * blank in a card — and a view filtered or sorted on one was working with
 * empties. Running the scripts up front means the template, the filters, the
 * sort and the search all see the values the grid shows.
 *
 * A script that will not compile, or that throws, puts its error label in the
 * cell (as the grid does) rather than an empty string — a broken script must
 * not read as "no data". A row with no scripted column is returned as it is,
 * without a copy.
 */
export function evaluateRow(row: Row, columns: readonly ColumnSpec[]): Row {
  let data: Record<string, unknown> | null = null;
  for (const c of columns) {
    if (!c.script?.trim()) continue;
    const run = runColumnScript(c.script, row.data);
    data ??= { ...row.data };
    data[c.field] = run.ok ? run.value : `⚠ ${run.label}`;
  }
  return data ? { ...row, data } : row;
}

/**
 * {@link evaluateRow} over a list. Returns `rows` untouched when no column is
 * scripted, which is the common case — the scripts otherwise re-run on every
 * recompute, exactly as the grid re-runs them on every render.
 */
export function evaluateRows(rows: Row[], columns: readonly ColumnSpec[]): Row[] {
  if (!columns.some((c) => c.script?.trim())) return rows;
  return rows.map((r) => evaluateRow(r, columns));
}

/** Apply an instance's snapshotted per-column filters (case-insensitive, AND). */
export function filterRows(rows: Row[], filters: Record<string, string>): Row[] {
  const active = Object.entries(filters).filter(([, v]) => v != null && String(v).trim() !== '');
  if (active.length === 0) return rows;
  return rows.filter((r) => active.every(([field, needle]) => matchesColumnFilter(r.data[field], needle)));
}

/** Does an exact-match token's term equal `value`, case-insensitively? */
function isExactPillToken(t: FilterToken, value: string): boolean {
  return t.exact === true && !t.negate && t.term.toLowerCase() === value.toLowerCase();
}

/**
 * Add an exact-match (`=`) token for `value` to a pill-filter column string,
 * OR-ed with whatever tokens are already there. Idempotent — clicking the
 * same value twice leaves a single token for it. Built on `parseColumnFilter`
 * / `composeColumnFilter` rather than splicing the raw string.
 */
export function addPillValue(current: string | undefined, value: string): string {
  const tokens = parseColumnFilter(current ?? '');
  if (tokens.some((t) => isExactPillToken(t, value))) return composeColumnFilter(tokens);
  tokens.push({ term: value, negate: false, exact: true });
  return composeColumnFilter(tokens);
}

/**
 * Remove the exact-match (`=`) token for `value` from a pill-filter column
 * string. Returns `''` when nothing is left.
 */
export function removePillValue(current: string | undefined, value: string): string {
  const tokens = parseColumnFilter(current ?? '').filter((t) => !isExactPillToken(t, value));
  return composeColumnFilter(tokens);
}

/** What a pill-filter column string says about ONE value. */
export type PillValueState = 'on' | 'not' | 'off';

/** Does an exact-match token EXCLUDE `value`, case-insensitively? */
function isExcludedPillToken(t: FilterToken, value: string): boolean {
  return t.exact === true && t.negate === true && t.term.toLowerCase() === value.toLowerCase();
}

/** Is `value` included, excluded, or absent from `current`? */
export function pillValueState(current: string | undefined, value: string): PillValueState {
  const tokens = parseColumnFilter(current ?? '');
  if (tokens.some((t) => isExactPillToken(t, value))) return 'on';
  if (tokens.some((t) => isExcludedPillToken(t, value))) return 'not';
  return 'off';
}

/**
 * Cycle one value's state in a pill-filter column string: `on` → `not` → `off`
 * → `on`. Every other value's token is carried through untouched, so cycling
 * one chip never disturbs the others OR-ed onto the same field.
 *
 * This is what clicking a chip's FIELD does. Three states rather than a
 * checkbox's two, because "show me everything except this" is the other half of
 * a filter you arrived at by clicking a value — and it was previously
 * unreachable from a chip at all.
 */
export function cyclePillValue(current: string | undefined, value: string): string {
  const state = pillValueState(current, value);
  const others = parseColumnFilter(current ?? '').filter(
    (t) => !isExactPillToken(t, value) && !isExcludedPillToken(t, value),
  );
  if (state === 'off') return composeColumnFilter([...others, { term: value, negate: false, exact: true }]);
  if (state === 'on') return composeColumnFilter([...others, { term: value, negate: true, exact: true }]);
  return composeColumnFilter(others);
}

/**
 * Sort by the instance's snapshotted column. Empty values always sink to the
 * bottom (both directions); present values compare numerically when both look
 * numeric, else as case-insensitive strings.
 */
export function sortRows(rows: Row[], sortColumn?: string, sortAsc = true): Row[] {
  if (!sortColumn) return rows;
  const factor = sortAsc ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a.data[sortColumn];
    const bv = b.data[sortColumn];
    const ae = isEmpty(av);
    const be = isEmpty(bv);
    if (ae || be) return ae === be ? 0 : ae ? 1 : -1;
    const na = Number(av);
    const nb = Number(bv);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * factor;
    return (
      String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) *
      factor
    );
  });
}

/**
 * Rows a view instance shows, in order: the snapshotted `filters` layer, then
 * the `pillFilters` layer (built by clicking `$filter.TOKEN` pills) — both
 * ANDed via `filterRows` — then sorted.
 */
export function viewRows(
  rows: Row[],
  inst: Pick<ViewInstance, 'filters' | 'sortColumn' | 'sortAsc'> & {
    pillFilters?: Record<string, string> | undefined;
  },
): Row[] {
  const filtered = filterRows(rows, inst.filters ?? {});
  const pilled = filterRows(filtered, inst.pillFilters ?? {});
  return sortRows(pilled, inst.sortColumn, inst.sortAsc ?? true);
}

/** True when a template should render as a repeated row fragment (vs. a table). */
export function hasRowHtml(rowHtml: string | undefined): boolean {
  return !!rowHtml && rowHtml.trim().length > 0;
}
