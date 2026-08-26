// packages/renderer/src/views/view-columns.ts
//
// A view's own column presentation: which columns it shows, and what draws them.
//
// A view is a view OF a table, and the table owns what a column IS — its field,
// its type, its constraints. What a view owns is how it LOOKS, and that has
// always been stored on the instance rather than the table: `visibleColumns`,
// `columnWidths`, the sort and the filters. `columnRenderers` joins them.
//
// The renderer is the one that was missing and the one users asked for. A column
// of markdown is a one-line preview in the grid you edit in and full prose in the
// view you read; a URL is a link in one place and the raw text in another. Before
// this, changing that meant changing the TABLE's column, which every other view
// and the grid itself then followed.
//
// Pure, and it is the whole rule: `data-table`'s `applyView` and `view-window`'s
// template path both build their columns here, so a view cannot look one way
// through the grid and another through its template.

import type { ColumnSpec } from '@easydb/shared';

/** What a view stores about its columns. All optional — an older instance has none. */
export interface ViewColumnPrefs {
  widths?: Record<string, number> | undefined;
  renderers?: Record<string, string> | undefined;
}

/**
 * The renderer a view draws this column with.
 *
 * An override of `''` means **the table's** — the empty option in the picker —
 * rather than "no renderer at all", because a view has no way to mean the second
 * and every reason to mean the first. Trimmed, so a stored blank behaves the same.
 */
export function viewRenderer(col: ColumnSpec, renderers: Record<string, string> | undefined): string | undefined {
  const override = renderers?.[col.field]?.trim();
  return override ? override : col.renderer;
}

/**
 * One column as a view draws it: the table's definition, the view's presentation.
 *
 * `width` and `renderer` are replaced rather than merged into, and everything else
 * is left exactly as the table has it. A view must not be able to change what a
 * column IS — its type, its `notnull`, its `unique` — because the grid writes
 * through a view (template-off mode is editable) and those are what keep a write
 * honest. See `data-table`'s `commitCell`.
 */
export function viewColumnSpec(col: ColumnSpec, prefs: ViewColumnPrefs): ColumnSpec {
  const width = prefs.widths?.[col.field];
  const renderer = viewRenderer(col, prefs.renderers);
  const out: ColumnSpec = { ...col };
  if (typeof width === 'number') out.width = width;
  if (renderer === undefined) delete out.renderer;
  else out.renderer = renderer;
  return out;
}

/**
 * Every column this view shows, in its own order.
 *
 * A field in `visibleColumns` that the table no longer has is dropped rather than
 * faked: the column is gone, and inventing a `{ field, label, type: 'string' }` for
 * it would show an empty column nobody can explain or remove. Views bind to tables
 * by name and survive a delete-and-reimport, so this happens whenever the new copy
 * has fewer columns.
 */
export function viewColumnSpecs(tableColumns: readonly ColumnSpec[], visibleColumns: readonly string[], prefs: ViewColumnPrefs = {}): ColumnSpec[] {
  const byField = new Map(tableColumns.map((c) => [c.field, c]));
  return visibleColumns
    .map((f) => byField.get(f))
    .filter((c): c is ColumnSpec => !!c)
    .map((c) => viewColumnSpec(c, prefs));
}

/**
 * Show or hide one column, keeping the TABLE's order.
 *
 * Order matters twice over. `visibleColumns` is also the column ORDER, so the old
 * toggle — which appended — moved a column to the far right the moment you hid it
 * and showed it again, which reads as the grid rearranging itself for no reason.
 * And a column editor lists columns in the table's order, so a checkbox there must
 * put the column back where the list says it is.
 *
 * Returns null when the answer would be no columns at all. A grid with no columns
 * shows nothing and offers no way back, so the last one cannot be hidden — the
 * caller keeps what it had rather than writing an empty list.
 */
export function toggleViewColumn(visibleColumns: readonly string[], tableOrder: readonly string[], field: string): string[] | null {
  const showing = new Set(visibleColumns);
  if (showing.has(field)) {
    if (showing.size <= 1) return null;
    showing.delete(field);
  } else {
    showing.add(field);
  }
  // The table's order for everything it knows, then anything left over in the
  // order the view had it — a field the table has since dropped keeps its place
  // instead of jumping to the front.
  const ordered = tableOrder.filter((f) => showing.has(f));
  const rest = visibleColumns.filter((f) => showing.has(f) && !tableOrder.includes(f));
  return [...ordered, ...rest];
}

/**
 * The renderer map after one change, with the default written as an ABSENCE.
 *
 * Storing `''` would work for the grid and be wrong everywhere else: "follow the
 * table" is the absence of an opinion, and a view that records one for every
 * column can never be told from a view that has none.
 */
export function setViewRenderer(renderers: Record<string, string> | undefined, field: string, renderer: string): Record<string, string> {
  const next = { ...(renderers ?? {}) };
  const wanted = renderer.trim();
  if (wanted) next[field] = wanted;
  else delete next[field];
  return next;
}
