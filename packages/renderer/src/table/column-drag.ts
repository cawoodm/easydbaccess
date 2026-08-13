// packages/renderer/src/table/column-drag.ts
//
// The payload a dragged column header carries, and how to recognise one.
//
// A column drag already existed for REORDERING within one grid: it writes
// `text/x-easydb-col` (the field name, nothing else) and is read by the same
// grid, which knows its own table. Dropping a column on ANOTHER table means
// crossing that boundary, so the drop side has to be told which table the
// column came from — hence a second, richer type on the same drag rather than a
// second drag gesture.
//
// A tiny module of its own because three layers need it and none should import
// the others: the grid writes it, `app-shell` decides whether a drag is worth
// preventing the default for, and the `projection` plugin reads it.

/** DataTransfer type for a column dragged out of a grid. */
export const COLUMN_DRAG_MIME = 'application/x-easydb-column';

export interface ColumnDragPayload {
  /** The table the column belongs to. */
  tableId: string;
  /** Its stored field name. */
  field: string;
  /** Its label, for wording a prompt without a second lookup. */
  label: string;
  /** The grid's active per-column filters when the drag started. */
  filters: Record<string, string>;
}

/**
 * Is this drag carrying a column?
 *
 * Read from `types`, not from `getData` — during `dragover` the data itself is
 * protected and `getData` returns an empty string, so `types` is the only thing
 * a handler can decide on while the drag is still in the air.
 */
export function hasColumnDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(COLUMN_DRAG_MIME);
}

/** Write the payload onto a drag that has just started. */
export function writeColumnDrag(e: DragEvent, payload: ColumnDragPayload): void {
  e.dataTransfer?.setData(COLUMN_DRAG_MIME, JSON.stringify(payload));
}

/** The payload of a dropped column, or null when this drag is not carrying one. */
export function readColumnDrag(e: DragEvent): ColumnDragPayload | null {
  const raw = e.dataTransfer?.getData(COLUMN_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<ColumnDragPayload>;
    if (typeof p.tableId !== 'string' || typeof p.field !== 'string') return null;
    return {
      tableId: p.tableId,
      field: p.field,
      label: typeof p.label === 'string' ? p.label : p.field,
      filters: p.filters && typeof p.filters === 'object' ? (p.filters as Record<string, string>) : {},
    };
  } catch {
    // Someone else's drag using the same type name, or a truncated payload.
    return null;
  }
}
