// Pure helpers for the View system — no DOM, unit-testable.
//
// A View Template is three HTML fragments (header / row / footer). When the row
// fragment is present it's repeated per row with `$TOKEN` placeholders replaced
// by the row's mapped column values; otherwise the view falls back to a
// read-only columns table. These helpers cover token extraction, substitution,
// and the snapshotted filter/sort a view instance applies.

import type { Row, ViewInstance } from '@easydb/shared';
import { matchesColumnFilter } from '../search/column-filter.js';

/** Matches a `$TOKEN` placeholder: `$` then a word (letters/digits/underscore, not starting with a digit). */
const TOKEN_RE = /\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Distinct token names (without the `$`) found across the given HTML fragments. */
export function extractTokens(...fragments: string[]): string[] {
  const seen = new Set<string>();
  for (const frag of fragments) {
    if (!frag) continue;
    for (const m of frag.matchAll(TOKEN_RE)) seen.add(m[1]!);
  }
  return [...seen];
}

/**
 * Replace every `$TOKEN` in `html` with the row's value for the column mapped to
 * that token. Unmapped tokens (or null values) become an empty string, so a
 * partially-mapped template never shows a raw `$TOKEN`.
 */
export function substituteRow(html: string, row: Row, mapping: Record<string, string>): string {
  return html.replace(TOKEN_RE, (_full, token: string) => {
    const field = mapping[token];
    if (!field) return '';
    const v = row.data[field];
    return v == null ? '' : String(v);
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
