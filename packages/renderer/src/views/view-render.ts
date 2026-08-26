// Pure helpers for the View system — no DOM, unit-testable.
//
// A View Template is three HTML fragments (header / row / footer). When the row
// fragment is present it's repeated per row with `$TOKEN` placeholders replaced
// by the row's mapped column values; otherwise the view falls back to a
// read-only columns table. These helpers cover token extraction, substitution,
// and the snapshotted filter/sort a view instance applies.

import type { ColumnSpec, Row, ViewInstance } from '@easydb/shared';
import { activeColumnScript, arrayMembers, composeColumnFilter, matchesColumnFilter, parseColumnFilter, scriptDeclined, type FilterToken } from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';
import { formatByType } from '../util/local-datetime.js';

/**
 * Matches a `$TOKEN` placeholder. An optional prefix decides how it renders:
 *
 *  - none — the value THROUGH the column's cell renderer, so a view shows what
 *    the grid shows (see {@link substituteRow}),
 *  - `input.` (or `input:`) — an EDITABLE control bound to the mapped field,
 *  - `filter.` — a clickable PILL,
 *  - `raw.` — the value as plain text, skipping the renderer.
 *
 * Group 1 is the prefix (or undefined), group 2 is the token NAME
 * (letters/digits/underscore, not starting with a digit); the name — without any
 * prefix — is the mapping key, so `$TITLE`, `$input.TITLE`, `$filter.TITLE` and
 * `$raw.TITLE` all map to the same column and differ only in presentation.
 */
const TOKEN_RE = /\$((?:input|filter|raw)[.:])?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Distinct token names (without the `$` or any `input.`/`filter.` prefix) found across the fragments. */
export function extractTokens(...fragments: string[]): string[] {
  const seen = new Set<string>();
  for (const frag of fragments) {
    if (!frag) continue;
    for (const m of frag.matchAll(TOKEN_RE)) seen.add(m[2]!);
  }
  return [...seen];
}

/**
 * The token names carrying the `filter.` prefix, in the order they appear.
 *
 * A `$filter.TOKEN` is a filter the template OFFERS, whether or not anything is
 * filtered on it yet — which is what lets the view window put a chip for each of
 * them in its toolbar instead of waiting for someone to find the pill in a row
 * and click it.
 */
export function extractFilterTokens(...fragments: string[]): string[] {
  const seen = new Set<string>();
  for (const frag of fragments) {
    if (!frag) continue;
    for (const m of frag.matchAll(TOKEN_RE)) {
      if (m[1]?.startsWith('filter')) seen.add(m[2]!);
    }
  }
  return [...seen];
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
function renderInput(field: string, value: unknown, rowId: string, spec: ColumnSpec | undefined, readonly: boolean): string {
  const type = spec?.type ?? 'string';
  const caption = escapeHtml(spec?.label || field);
  const attrs = `class="eda-input" data-eda-row="${escapeAttr(rowId)}" ` + `data-eda-field="${escapeAttr(field)}" data-eda-type="${escapeAttr(type)}"`;
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

/** One clickable pill for one value of one field. */
function pillButton(field: string, text: string): string {
  const field_ = escapeAttr(field);
  const value_ = escapeAttr(text);
  return `<button type="button" class="eda-filter-pill" data-eda-filter-field="${field_}" ` + `data-eda-filter-value="${value_}" title="Filter by ${field_}: ${value_}">${escapeHtml(text)}</button>`;
}

/**
 * The members of a LIST cell, or null when the cell is one value.
 *
 * An `array` column is the declared case; a real JS array is taken apart too,
 * whatever the column says, because `String(['a','b'])` is `a,b` and a pill of
 * that text can never match anything.
 */
function listMembers(value: unknown, spec: ColumnSpec | undefined): string[] | null {
  return spec?.type === 'array' || Array.isArray(value) ? arrayMembers(value) : null;
}

/**
 * Render a `$filter.TOKEN` as a clickable pill showing the row's value for the
 * mapped field. Clicking it (wired up in the view window) OR-appends an
 * exact-match pill filter for that field/value. A null/empty value renders
 * nothing — there is no pill for an empty cell.
 *
 * An `array` field renders ONE PILL PER MEMBER, each carrying that member alone.
 * A single pill for the whole cell would have filtered on `=foo,bar`, and a list
 * cell is never exactly one value, so the view emptied itself on the click. Per
 * member it does what it looks like: the filter matches an array column per
 * member (see `search/column-filter.ts`), so a pill for one tag keeps every row
 * carrying that tag. An empty list renders nothing, like an empty cell.
 */
function renderFilterPill(field: string, value: unknown, spec: ColumnSpec | undefined): string {
  const members = listMembers(value, spec);
  if (members) return members.map((m) => pillButton(field, m)).join('');
  if (value == null || value === '') return '';
  return pillButton(field, String(value));
}

/**
 * What one token's script renders. The result goes into the template as it
 * stands — the template is raw HTML anyway — so a script may return markup, as
 * `markdownToHtml(row.body)` does.
 *
 * A script that will not compile, or that throws, renders a small error chip
 * with the message on hover, the way the grid marks a broken column script. A
 * blank result renders nothing.
 */
function renderScripted(src: string, row: Row): string {
  const run = runColumnScript(src, row.data);
  if (!run.ok) return `<span class="eda-script-error" title="${escapeAttr(run.message)}">⚠ ${escapeHtml(run.label)}</span>`;
  return run.value == null ? '' : String(run.value);
}

/** Class marking the placeholder a cell renderer is mounted into. */
export const CELL_SLOT_CLASS = 'eda-cell';

/**
 * The value a token DISPLAYS, before any renderer: the token's own script if it
 * has one, else the stored cell.
 *
 * Exported because the view window recomputes it when it mounts a renderer into
 * the slot this module emitted — one rule for what a token shows, in one place,
 * rather than the string pass and the mount pass each having their own.
 */
export function tokenValue(row: Row, field: string, script?: string | undefined): unknown {
  if (script?.trim()) {
    const run = runColumnScript(script, row.data);
    return run.ok ? run.value : `⚠ ${run.label}`;
  }
  return row.data[field];
}

/**
 * Is the offset inside an HTML tag — i.e. in an attribute value?
 *
 * `<img src="$IMAGE">` and `<a href="$URL">` are how the shipped templates are
 * written, and there a token MUST come out as text: an element spliced into an
 * attribute is not a renderer, it is a broken tag. Cheaper and more predictable
 * than parsing the fragment: the last `<` before us is still unclosed.
 */
function insideTag(html: string, offset: number): boolean {
  const lt = html.lastIndexOf('<', offset);
  return lt >= 0 && lt > html.lastIndexOf('>', offset);
}

/**
 * An empty element the view window fills with the column's cell-renderer
 * element. It cannot be filled here: a renderer takes its value, column and row
 * as PROPERTIES (see `data-table.ts`), and a property cannot be written into an
 * HTML string — only the DOM pass can set them.
 */
function cellSlot(rowId: string, field: string, token: string, tag: string): string {
  return (
    `<span class="${CELL_SLOT_CLASS}" data-eda-row="${escapeAttr(rowId)}" data-eda-field="${escapeAttr(field)}" ` + `data-eda-token="${escapeAttr(token)}" data-eda-tag="${escapeAttr(tag)}"></span>`
  );
}

/**
 * Replace every `$TOKEN` in `html` with the row's value for the column mapped to
 * that token. An `$input.TOKEN` instead renders an editable control (checkbox /
 * number / text) bound to the mapped field (see {@link renderInput}); a
 * `$filter.TOKEN` renders a clickable pill per value (see
 * {@link renderFilterPill}) — several of them for an `array` field.
 * Unmapped tokens (or null values) become an empty string, so a
 * partially-mapped template never shows a raw `$TOKEN`.
 *
 * `opts.scripts` (the instance's `tokenScripts`) gives a token its own
 * `render(row)` script, and that script's result replaces the mapped value —
 * which is how a view formats a cell it must not change in the table. It applies
 * to a plain `$TOKEN` ONLY: an `$input.` writes back to the cell and a
 * `$filter.` pill has to carry the stored text to match anything. A scripted
 * token needs no mapping, so it may compute from the whole row.
 *
 * A plain `$TOKEN` goes THROUGH the column's cell renderer, so a view shows what
 * the grid shows — a `link` column as a link, `tags` as pills. Because a renderer
 * is a custom element fed by properties, what lands in the string is an empty
 * slot the view window then mounts into ({@link cellSlot}). Four things send a
 * token back to plain text instead:
 *
 *  - the `raw.` prefix, or `opts.raw[token]` (the mapping dialog's toggle),
 *  - the column has no renderer, or none is registered under that name,
 *  - the token sits inside a tag, where an element cannot go ({@link insideTag}),
 *  - the token has its own script, which already decided what to show.
 *
 * Values are read straight from `row.data`, so pass a row that has been through
 * {@link evaluateRow} when the table has scripted columns.
 */
export function substituteRow(
  html: string,
  row: Row,
  mapping: Record<string, string>,
  opts: {
    columns?: Map<string, ColumnSpec>;
    readonly?: boolean;
    scripts?: Record<string, string> | undefined;
    /** Renderer name → custom-element tag, from `registries.cellRenderers`. */
    renderers?: Map<string, string> | undefined;
    /** Token → true when this token must stay plain text. */
    raw?: Record<string, boolean> | undefined;
  } = {},
): string {
  return html.replace(TOKEN_RE, (_full, prefix: string | undefined, token: string, offset: number, whole: string) => {
    const field = mapping[token];
    const script = opts.scripts?.[token];
    if (!prefix && script?.trim()) return renderScripted(script, row);
    if (!field) return '';
    const v = row.data[field];
    const spec = opts.columns?.get(field);
    if (!prefix || prefix.startsWith('raw')) {
      const tag = prefix ? undefined : rendererTag(spec, opts.renderers);
      if (tag && opts.raw?.[token] !== true && !insideTag(whole, offset)) return cellSlot(row.id, field, token, tag);
      if (v == null || v === '') return '';
      // With no renderer to do it, a `date` / `datetime` column is still formatted
      // for the reader — otherwise a view shows the stored `2026-06-17T10:59:56.937Z`
      // and a card is unreadable. `$raw.` keeps the stored text, which is what
      // "raw" is for.
      const typed = prefix ? null : formatByType(spec?.type, v);
      return typed ?? String(v);
    }
    if (prefix.startsWith('filter')) return renderFilterPill(field, v, spec);
    // A scripted column is computed from the rest of the row, so there is
    // nowhere to write an edit back to — the grid treats such a cell as
    // read-only, and so does an `$input.TOKEN` bound to one.
    const readonly = opts.readonly === true || activeColumnScript(spec) !== undefined;
    return renderInput(field, v, row.id, spec, readonly);
  });
}

/** The custom-element tag for a column's renderer, when one is registered. */
function rendererTag(spec: ColumnSpec | undefined, renderers: Map<string, string> | undefined): string | undefined {
  const name = spec?.renderer;
  return name ? renderers?.get(name) : undefined;
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
    const src = activeColumnScript(c);
    if (src === undefined) continue;
    const run = runColumnScript(src, row.data);
    // A script that DECLINED (null/undefined) leaves the stored value alone, so
    // the view filters, sorts and searches the same value the grid shows — see
    // `scriptDeclined`.
    if (run.ok && scriptDeclined(run.value)) continue;
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
  if (!columns.some((c) => activeColumnScript(c) !== undefined)) return rows;
  return rows.map((r) => evaluateRow(r, columns));
}

/**
 * Apply an instance's snapshotted per-column filters (case-insensitive, AND).
 *
 * `columns` is optional and only carries the column TYPES: an `array` column
 * matches per member, so a chip for one tag keeps the rows whose list contains
 * it. Without the columns every cell reads as one value, as it always did.
 */
export function filterRows(rows: Row[], filters: Record<string, string>, columns?: readonly ColumnSpec[]): Row[] {
  const active = Object.entries(filters).filter(([, v]) => v != null && String(v).trim() !== '');
  if (active.length === 0) return rows;
  const typeOf = new Map((columns ?? []).map((c) => [c.field, c.type as string | undefined]));
  return rows.filter((r) => active.every(([field, needle]) => matchesColumnFilter(r.data[field], needle, { type: typeOf.get(field) })));
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
  const others = parseColumnFilter(current ?? '').filter((t) => !isExactPillToken(t, value) && !isExcludedPillToken(t, value));
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
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * factor;
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
  columns?: readonly ColumnSpec[],
): Row[] {
  const filtered = filterRows(rows, inst.filters ?? {}, columns);
  const pilled = filterRows(filtered, inst.pillFilters ?? {}, columns);
  return sortRows(pilled, inst.sortColumn, inst.sortAsc ?? true);
}

/** True when a template should render as a repeated row fragment (vs. a table). */
export function hasRowHtml(rowHtml: string | undefined): boolean {
  return !!rowHtml && rowHtml.trim().length > 0;
}
