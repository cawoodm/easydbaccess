// Pure helpers for the View system — no DOM, unit-testable.
//
// A View Template is three HTML fragments (header / row / footer). When the row
// fragment is present it's repeated per row with `$TOKEN` placeholders replaced
// by the row's mapped column values; otherwise the view falls back to a
// read-only columns table. These helpers cover token extraction, substitution,
// and the snapshotted filter/sort a view instance applies.

import type { ColumnSpec, Row, ViewInstance } from '@easydb/shared';
import { matchesColumnFilter } from '../search/column-filter.js';

/**
 * Matches a `$TOKEN` placeholder. An optional `input.` (or `input:`) prefix
 * marks the token as EDITABLE — it renders an `<input>` bound to the mapped
 * field instead of the read-only value. Group 1 is the prefix (or undefined),
 * group 2 is the token NAME (letters/digits/underscore, not starting with a
 * digit); the name — without any prefix — is the mapping key, so `$TITLE` and
 * `$input.TITLE` map to the same column but render read-only vs. editable.
 */
const TOKEN_RE = /\$(input[.:])?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Distinct token names (without the `$` or any `input.` prefix) found across the fragments. */
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
 * Replace every `$TOKEN` in `html` with the row's value for the column mapped to
 * that token. An `$input.TOKEN` instead renders an editable control (checkbox /
 * number / text) bound to the mapped field (see {@link renderInput}). Unmapped
 * tokens (or null values) become an empty string, so a partially-mapped
 * template never shows a raw `$TOKEN`.
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
    return renderInput(field, v, row.id, opts.columns?.get(field), opts.readonly === true);
  });
}

function isEmpty(v: unknown): boolean {
  return v == null || v === '';
}

/** Apply an instance's snapshotted per-column filters (case-insensitive, AND). */
export function filterRows(rows: Row[], filters: Record<string, string>): Row[] {
  const active = Object.entries(filters).filter(([, v]) => v != null && String(v).trim() !== '');
  if (active.length === 0) return rows;
  return rows.filter((r) => active.every(([field, needle]) => matchesColumnFilter(r.data[field], needle)));
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

/** Rows a view instance shows, in order: filtered then sorted. */
export function viewRows(
  rows: Row[],
  inst: Pick<ViewInstance, 'filters' | 'sortColumn' | 'sortAsc'>,
): Row[] {
  return sortRows(filterRows(rows, inst.filters ?? {}), inst.sortColumn, inst.sortAsc ?? true);
}

/** True when a template should render as a repeated row fragment (vs. a table). */
export function hasRowHtml(rowHtml: string | undefined): boolean {
  return !!rowHtml && rowHtml.trim().length > 0;
}
