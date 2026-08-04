// Shared table-export helpers. Two concerns live here:
//
// 1. `tableToFile` — the `.table.json` shape (lifted out of gist-sync.ts so
//    the Gist push/pull path and the per-table export menu share ONE
//    definition instead of two copies drifting apart).
// 2. The "scope" helpers (`scopedTable` / `scopedRows`) that back the
//    Raw Data vs. Visible Data vs. Structure Only choice offered by the
//    table-footer export menu (see plugins/dump-export.ts). CSV, JSON, and
//    SQL exports all call these first, then feed the (possibly narrowed)
//    table + rows into their own serializer — the scoping logic itself
//    lives in exactly one place.

import type { Row, Table } from '@easydb/shared';
import { viewRows } from '../views/view-render.js';

/** `raw` = every column (including hidden) and every row, unsorted/unfiltered.
 * `visible` = only non-hidden columns, in their current order, and rows
 * filtered + sorted exactly like a view window (`viewRows`).
 * `structure` = the table's DEFINITION only — every column (same full set as
 * `raw`, since "structure" means the complete schema, not what happens to be
 * on screen) and zero rows. */
export type ExportScope = 'raw' | 'visible' | 'structure';

/** Column list for the given scope — 'visible' drops `hidden === true` columns;
 * 'structure' keeps every column, same as 'raw'. */
export function scopedColumns(table: Table, scope: ExportScope): Table['columns'] {
  if (scope === 'raw' || scope === 'structure') return table.columns;
  return table.columns.filter((c) => c.hidden !== true);
}

/**
 * A copy of `table` with its columns narrowed per `scope`. Feed this (plus
 * `scopedRows(...)`) into `serializeCsv` / `tableToFile` / a per-table SQL
 * renderer so all three formats project onto the same column set for a
 * given scope — none of them need to know about scoping themselves.
 */
export function scopedTable(table: Table, scope: ExportScope): Table {
  if (scope === 'raw' || scope === 'structure') return table;
  return { ...table, columns: scopedColumns(table, scope) };
}

/** Row list for the given scope — 'visible' applies the table's snapshotted
 * filters + sort (the same rows a view window derived from this table would
 * show); 'raw' returns every row untouched; 'structure' returns none (the
 * serializers already emit a header/CREATE-only output when given `[]`). */
export function scopedRows(table: Table, rows: Row[], scope: ExportScope): Row[] {
  if (scope === 'structure') return [];
  if (scope === 'raw') return rows;
  return viewRows(
    rows,
    {
      filters: table.filters ?? {},
      sortColumn: table.sortColumn,
      sortAsc: table.sortAsc,
    },
    table.columns,
  );
}

/**
 * Serializes a table (+ its already-fetched rows) into the shape both the
 * Gist push and the per-table "JSON (.table.json)" export write: enough to
 * reconstruct the table (columns, view mode, window layout, sort, filters,
 * label column, deleted columns, info, and routing descriptors) plus its
 * row data, on another device/workspace.
 */
export function tableToFile(t: Table, rows: Row[]) {
  // Project each row onto the table's CURRENT columns — exactly like CSV export
  // and the data-table do (`r.data[c.field]`). Deleting a column removes it from
  // `t.columns` but does NOT purge its (potentially large) value from each row's
  // `data` blob (see new-table-dialog: "row data isn't migrated"). Dumping raw
  // `r.data` would therefore sync — and size-count — long-deleted columns, which
  // is why a 2 MB table (per its CSV) was warning as 32 MB on push.
  const fields = t.columns.map((c) => c.field);
  // A table backed by a live source (Datasette, or any registered backend) is
  // "remote": its rows live in the backend, not locally. Such tables sync their
  // DEFINITION only — never the (possibly huge, possibly stale) row data.
  const isRemote = t.source != null;
  return {
    name: t.name,
    title: t.title,
    columns: t.columns,
    // Full display/query state so a pull restores the table exactly, not just
    // its data: view mode, window layout, sort, filters, label column, deleted
    // columns, and info.
    view: t.view,
    windowGeometry: t.windowGeometry,
    sortColumn: t.sortColumn,
    sortAsc: t.sortAsc,
    filters: t.filters,
    labelColumn: t.labelColumn,
    deletedColumns: t.deletedColumns,
    info: t.info,
    // Routing descriptors so a pulled remote/snapshot table reconnects to its
    // backend (or remembers where a snapshot came from) instead of returning as
    // a dead, source-less local table. No secrets live here — backend tokens are
    // kept in settings, not in `source.config`.
    source: t.source,
    origin: t.origin,
    // Remote tables carry no rows; their data is re-fetched live on pull.
    rows: isRemote
      ? []
      : rows.map((r) => {
          const projected: Record<string, unknown> = {};
          for (const f of fields) projected[f] = r.data[f];
          return projected;
        }),
  };
}
