// packages/renderer/src/import/refresh.ts
//
// One refresh for every snapshot an importer on the kernel produced.
//
// Before this, refreshing behaved differently depending on which plugin had
// made the table, which is a bug and not a feature:
//
//   `import-data.ts:refreshImported` (csv, json)  wiped every row, re-parsed the
//     body and inserted the result. Columns were never re-discovered, so a
//     source that had grown a column simply never showed it. Any column the user
//     had added locally lost its values, and any row they had edited was gone.
//
//   `datasette-import.ts:refreshSnapshot`         re-discovered the columns,
//     reconciled them against the user's arrangement, honoured
//     `deletedColumns`, and merged rows by primary key so user-added columns
//     survived.
//
// The second is simply correct, so this module gives it to every kernel
// importer. Datasette keeps its own version for now, because its refresh also
// drives a per-window progress bar and a resumable paged read that the kernel
// cannot express yet.
//
// Note on primary keys: `mergeRefreshedRows` needs `origin.pks` to match old
// rows to fresh ones. Only Datasette records them today, so a CSV/JSON refresh
// still falls back to replacing the rows — but it now re-discovers columns and
// respects `deletedColumns`, which is the part that was silently wrong.

import type { ColumnSpec, HostApi, ImporterSpec, Row, Table } from '@easydb/shared';
import { reconcileColumns } from '../table/column-merge.js';
import { mergeRefreshedRows } from '../table/refresh-merge.js';
import { cryptoUUID } from '../util/ids.js';
import { fetchImportTextWithBar } from './fetch-source.js';

export interface RefreshResult {
  rowCount: number;
  /** Columns the source has that the table did not, now appended. */
  newFields: string[];
  /** True when rows were matched by primary key rather than replaced wholesale. */
  merged: boolean;
}

/**
 * Re-read a snapshot table from its `origin.url` through the importer that made
 * it, then reconcile columns and merge rows.
 *
 * Throws when the table has no re-readable origin, when no kernel importer
 * claims its `origin.type`, or when the source no longer offers a matching
 * table — each with a message worth showing the user.
 */
export async function refreshFromOrigin(
  api: HostApi,
  table: Table,
  spec: ImporterSpec,
): Promise<RefreshResult> {
  const url = table.origin?.url;
  if (!url) throw new Error(`"${table.name}" has no source URL to reload from.`);

  const ctx = {
    api,
    // No size ceiling: the table already exists at this size, so refusing to
    // reload it would strand the user with stale rows and no way forward.
    fetchText: (u: string, label?: string) =>
      fetchImportTextWithBar(api, u, label ?? `Reading ${table.name}…`, { maxBytes: null }),
    // The panel values used at import time are not recorded on the table, so a
    // refresh re-detects instead — fine for a CSV separator (the body has not
    // changed shape), and `TableOrigin.panel` is the tidier fix when it lands.
    panel: {} as Record<string, unknown>,
  };

  const candidates = await spec.list(ctx, { kind: 'url', url });
  if (candidates.length === 0) throw new Error(`Nothing to read at ${url} any more.`);

  // A multi-table source must give back the SAME table, matched by the name it
  // proposed originally. Falling back to the only candidate covers a
  // single-table source whose name has since changed.
  const candidate =
    candidates.find((c) => c.name === table.name) ??
    (candidates.length === 1 ? candidates[0]! : undefined);
  if (!candidate) {
    throw new Error(`"${table.name}" is no longer one of the tables at ${url}.`);
  }

  let discovered: ColumnSpec[] = [];
  const freshRows: Array<Record<string, unknown>> = [];
  for await (const batch of spec.read(ctx, candidate)) {
    if (batch.columns?.length) discovered = batch.columns;
    freshRows.push(...batch.rows);
  }

  // Keep the user's arrangement (order, hidden, width, renderer, label) and
  // never re-add a column they deleted. Genuinely-new columns are appended.
  const { columns, newFields } = reconcileColumns(
    table.columns,
    discovered,
    table.deletedColumns ?? [],
  );

  const pks = table.origin?.pks ?? [];
  const remoteFields = new Set(discovered.map((c) => c.field));
  const userAddedFields = table.columns
    .map((c) => c.field)
    .filter((f) => !remoteFields.has(f) && !pks.includes(f));
  const deletedRemoteFields = (table.deletedColumns ?? []).filter((f) => remoteFields.has(f));

  const rowColl = api.store.rows(table.id);
  const old = await rowColl.find();
  const { data, merged } = mergeRefreshedRows({
    oldRows: old.map((r) => ({ data: r.data })),
    freshRows,
    pks,
    userAddedFields,
    deletedRemoteFields,
  });

  const now = Date.now();
  if (columns.length > 0) {
    await api.store.tables.patch(table.id, { columns, updatedAt: now });
  }
  await rowColl.bulkRemove(old.map((r) => r.id));
  const docs: Row[] = data.map((d) => ({
    id: cryptoUUID(),
    tableId: table.id,
    data: d,
    updatedAt: now,
  }));
  await rowColl.bulkInsert(docs);

  return { rowCount: docs.length, newFields, merged };
}
