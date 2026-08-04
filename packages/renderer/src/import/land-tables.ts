// packages/renderer/src/import/land-tables.ts
//
// The ONE place an import writes a table. Before this existed there were five
// inline copies (csv-import, json-import, datasette-source twice, import-data),
// three different name-collision prompts and three different name-uniquing
// rules — so the same action behaved differently depending on the format.
//
// The kernel decides WHERE rows go before the import starts (the dialog's
// Target field), so nothing interrupts a long read with a modal.

import type { ColumnSpec, HostApi, ImportBatch, Row, Table, TableOrigin } from '@easydb/shared';
import { reconcileColumns, rowRekeyer } from '../table/column-merge.js';
import { cryptoUUID, slugTable } from '../util/ids.js';
import { uniqueTableName } from '../util/table-names.js';

/** Where an import's rows should go. Chosen up front, never mid-import. */
export type ImportTarget =
  | { kind: 'new' }
  /** Keep the existing rows and add these after them. */
  | { kind: 'append'; tableId: string }
  /** Drop the existing rows, keep the table and its column definitions. */
  | { kind: 'overwrite'; tableId: string };

export interface LandOptions {
  workspaceId: string;
  /** The importer's id, stamped as `origin.type` so Refresh can find it again. */
  importerId: string;
  target: ImportTarget;
  /** Recorded on a NEW table so it can be refreshed later. */
  origin?: TableOrigin | undefined;
  /**
   * Review/rename the inferred columns before a NEW table is created. Returning
   * null cancels. Only consulted for `new` — append/overwrite reuse the
   * existing schema, so there is nothing to edit.
   */
  editColumns?: ((columns: ColumnSpec[]) => Promise<ColumnSpec[] | null>) | undefined;
  /** Hard cap on rows written. Undefined ⇒ write them all. */
  maxRows?: number | undefined;
  /** Progress callback: rows written so far, and the total if the source knows. */
  onProgress?: ((written: number, total: number | undefined) => void) | undefined;
}

export interface LandResult {
  tableId: string;
  tableName: string;
  rowCount: number;
  /** True when a new table was created rather than an existing one reused. */
  created: boolean;
}

// The naming policy moved to `util/table-names.ts` when the STORE started to
// enforce it (`db/unique-table-names.ts`) — an importer is no longer the only
// writer that has to obey it. Re-exported here because every importer already
// reads it from this module.
export { uniqueTableName };

/** Names already used in a workspace, for {@link uniqueTableName}. */
export async function takenNames(api: HostApi, workspaceId: string): Promise<string[]> {
  return (await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId).map((t) => t.name);
}

/**
 * Drain an importer's batches into a table. Returns null if the user cancelled
 * at the column-editing step.
 *
 * The row cap is applied HERE, once, so every format honours it identically —
 * previously CSV capped while parsing, JSON sliced afterwards, and Datasette
 * ignored the setting entirely in favour of its own 10k ceiling.
 */
export async function landCandidate(api: HostApi, name: string, batches: AsyncIterable<ImportBatch>, opts: LandOptions): Promise<LandResult | null> {
  const { workspaceId, importerId, target, maxRows } = opts;

  let tableId: string;
  let tableName: string;
  let created: boolean;
  let started = false;
  let written = 0;
  let total: number | undefined;
  /**
   * Set when the column editor renamed a field. The rows arriving from the
   * importer are keyed by the ORIGINAL field names, so every batch — not just
   * the first — has to be rewritten, or the renamed columns come out empty.
   */
  let rekey: ((row: Record<string, unknown>) => Record<string, unknown>) | null = null;

  const rowsColl = (id: string) => api.store.rows(id);

  // Set up the destination lazily, on the first batch, because a NEW table
  // takes its schema from that batch's `columns`.
  const ensureTarget = async (batch: ImportBatch): Promise<boolean> => {
    if (started) return true;

    if (target.kind === 'new') {
      let cols = batch.columns ?? [];
      if (opts.editColumns) {
        const edited = await opts.editColumns(cols);
        if (edited === null) return false; // user cancelled
        rekey = rowRekeyer(cols, edited);
        cols = edited;
      }
      tableId = cryptoUUID();
      tableName = uniqueTableName(await takenNames(api, workspaceId), name);
      const table: Table = {
        id: tableId,
        workspaceId,
        name: tableName,
        code: slugTable(tableName),
        columns: cols,
        view: 'table',
        ...(opts.origin ? { origin: opts.origin } : {}),
        updatedAt: Date.now(),
      };
      await api.store.tables.insert(table);
      created = true;
    } else {
      const existing = await api.store.tables.findOne(target.tableId);
      if (!existing) throw new Error('The table to import into no longer exists.');
      tableId = existing.id;
      tableName = existing.name;
      created = false;
      if (target.kind === 'overwrite') {
        const old = await rowsColl(tableId).find();
        await rowsColl(tableId).bulkRemove(old.map((r) => r.id));
      }
      // A source may have grown columns since the table was made. Add the new
      // ones, honouring `deletedColumns` so a column the user removed does not
      // come back on every import.
      if (batch.columns?.length) {
        const merged = reconcileColumns(existing.columns, batch.columns, existing.deletedColumns ?? []);
        if (merged.newFields.length > 0) {
          await api.store.tables.patch(tableId, {
            columns: merged.columns,
            updatedAt: Date.now(),
          });
        }
      }
    }

    api.events.emit('import:before', { source: importerId, tableId });
    started = true;
    return true;
  };

  for await (const batch of batches) {
    if (maxRows != null && written >= maxRows) break;
    if (!(await ensureTarget(batch))) return null;
    if (batch.totalCount != null) total = batch.totalCount;

    let rows = batch.rows;
    if (maxRows != null && written + rows.length > maxRows) {
      rows = rows.slice(0, maxRows - written);
    }
    if (rows.length === 0) continue;
    if (rekey) rows = rows.map(rekey);

    const now = Date.now();
    const docs: Row[] = rows.map((data) => ({
      id: cryptoUUID(),
      tableId: tableId!,
      data,
      updatedAt: now,
    }));
    await rowsColl(tableId!).bulkInsert(docs);
    written += docs.length;
    opts.onProgress?.(written, total);
  }

  // An empty source still yields a table (an empty shell the user can refresh),
  // matching what a failed Datasette import already did.
  if (!started) {
    if (!(await ensureTarget({ rows: [] }))) return null;
  }

  api.events.emit('import:after', {
    source: importerId,
    tableId: tableId!,
    rowCount: written,
  });

  return { tableId: tableId!, tableName: tableName!, rowCount: written, created: created! };
}
