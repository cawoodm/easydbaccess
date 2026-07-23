// packages/renderer/src/plugins/datasette-source.ts
//
// easyDBAccess built-in plugin — import from any online Datasette instance as
// local eda tables (read-only snapshots). A URL may point at:
//   - a single table      (.../<db>/<table>)  → imported directly;
//   - a whole database     (.../<db>)          → pick tables from a checklist;
//   - an entire instance   (https://host)      → pick tables across all databases.
// Registers a URL source and a (table-only) drop handler. The Phase-2 live
// read-write connector builds on the same datasette-client core.

import type { ColumnSpec, HostApi, PluginModule, Row } from '@easydb/shared';
import {
  parseDatasetteUrl,
  discoverTables,
  fetchTableMeta,
  fetchRows,
  inferColumnsFromRows,
  refineColumnTypes,
  DatasetteError,
  type DatasetteRef,
} from './datasette-client.js';
import { chooseTables } from '../dialogs/table-select-dialog.js';
import { createDatasetteCollection } from './datasette-collection.js';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'datasette-source',
  version: '0.2.0',
  description: 'Import tables from any online Datasette instance, database, or single table by URL',
  author: 'easyDBAccess built-ins',
  optional: true,
};

const SETTINGS = {
  maxImportRows: 10_000, // safety cap on a single table's import
  pageSize: 1000, // _size per page hop (fixed size for uniform cursor paging)
};

const EXAMPLE = 'https://latest.datasette.io/fixtures/facetable';

export function init(api: HostApi): void {
  // Phase 2c: tables carrying `source: { type: 'datasette', ... }` are backed
  // by a live read-write Datasette collection instead of Dexie (routed by the
  // Phase-2a seam). Snapshot imports above are unaffected — they create plain
  // local tables with no `source`.
  api.registerRowSource({ type: 'datasette', create: createDatasetteCollection });

  api.ui.registerUrlSource({
    id: 'datasette',
    label: 'Datasette (table or instance)…',
    async run(api, { url }) {
      const input =
        url ||
        (await api.ui.dialogs.prompt(
          `Datasette URL — a single table, a database, or an instance root.\n\ne.g. ${EXAMPLE}`,
          '',
          'Import from Datasette',
        ));
      if (!input) return;
      await runImport(api, input);
    },
  });

  api.ui.registerDropHandler(async (event, api) => {
    const text = event.dataTransfer?.getData('text/plain') || '';
    if (!isDatasetteTableUrl(text)) return false;
    event.preventDefault();
    await runImport(api, text);
    return true;
  });
}

async function runImport(api: HostApi, input: string): Promise<void> {
  try {
    await importDatasette(api, input);
  } catch (err) {
    let msg: string;
    if (err instanceof DatasetteError) {
      // Only prefix with a status when there's a real HTTP one (network
      // failures carry status 0 and a self-explanatory message).
      msg = err.status ? `Datasette error (${err.status}): ${err.message}` : err.message;
    } else {
      msg = `Could not import: ${(err as Error)?.message ?? err}`;
    }
    await api.ui.dialogs.alert(msg, 'Datasette import failed');
  }
}

function isDatasetteTableUrl(text: string): boolean {
  try {
    const ref = parseDatasetteUrl(text);
    return !!(ref.db && ref.table);
  } catch {
    return false;
  }
}

interface OneResult {
  name: string;
  rowCount: number;
  hasMore: boolean;
  truncated: boolean;
  pages: number;
  count: number | null;
}

/**
 * Smart entry point. Resolves a Datasette URL to one or many tables and imports
 * them. A single-table URL imports straight away; a database/instance URL
 * discovers its tables and opens a checklist (all pre-selected) so the user
 * chooses what to pull in.
 */
export async function importDatasette(api: HostApi, input: string): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-source: no active workspace');

  const ref = parseDatasetteUrl(input);
  const fetchFn = (u: string) => api.backend.fetch(u);

  // Single explicit table → import directly (no picker).
  if (ref.db && ref.table) {
    const r = await importOneTable(api, workspaceId, ref);
    if (r.hasMore || r.truncated) toastCapped(api, r);
    // The plain success toast comes from app-context's import:after listener.
    return;
  }

  // Database or instance → discover, then let the user choose.
  const candidates = await discoverTables(fetchFn, ref);
  if (candidates.length === 0) {
    await api.ui.dialogs.alert('No tables found at that Datasette URL.', 'Datasette import');
    return;
  }

  const multiDb = new Set(candidates.map((c) => c.db)).size > 1;
  const host = ref.base.replace(/^https?:\/\//, '');
  const picked = await chooseTables(
    candidates.map((c) => ({
      name: multiDb ? `${c.db}/${c.table}` : c.table,
      size: c.count,
      detail: multiDb ? undefined : c.db,
    })),
    {
      title: 'Import from Datasette',
      message: `Choose the tables to import from ${host}.`,
      confirmLabel: 'Import',
    },
  );
  if (!picked) return;

  let imported = 0;
  let totalRows = 0;
  const capped: string[] = [];
  const failed: string[] = [];
  for (const i of picked) {
    const c = candidates[i]!;
    try {
      const r = await importOneTable(api, workspaceId, {
        base: ref.base,
        db: c.db,
        table: c.table,
        query: {},
      });
      imported += 1;
      totalRows += r.rowCount;
      if (r.hasMore || r.truncated) capped.push(`${c.db}/${c.table}`);
    } catch (err) {
      failed.push(`${c.db}/${c.table}: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  summariseBatch(api, { imported, totalRows, capped, failed, requested: picked.length });
}

/** Fetch schema + rows for one table and create the local eda table. No toast. */
async function importOneTable(
  api: HostApi,
  workspaceId: string,
  ref: DatasetteRef,
): Promise<OneResult> {
  const name = `${ref.db}/${ref.table}`;
  const fetchFn = (u: string) => api.backend.fetch(u);

  // Schema discovery via ?_extra=… is best-effort: instances that don't
  // support it (older Datasette) simply give us no columns, and we infer them
  // from the fetched rows below. A hard failure here (e.g. network) is
  // tolerated too — the row fetch will surface any real problem.
  let metaColumns: ColumnSpec[] = [];
  let count: number | null = null;
  let typed = false;
  try {
    const meta = await fetchTableMeta(fetchFn, ref);
    metaColumns = meta.columns;
    count = meta.count;
    typed = meta.typed;
  } catch {
    // fall back to row inference
  }

  const { rows, truncated, hasMore, pages } = await fetchRows(fetchFn, ref, {
    maxRows: SETTINGS.maxImportRows,
    pageSize: SETTINGS.pageSize,
  });

  // Prefer the schema's columns; if it gave no columns at all, infer from rows;
  // if it gave names but no type details (e.g. datasette.io's `?_extra=columns`
  // returns a bare name array), keep the names but refine types from the rows.
  const columns =
    metaColumns.length === 0
      ? inferColumnsFromRows(rows)
      : typed
        ? metaColumns
        : refineColumnTypes(metaColumns, rows);

  const now = Date.now();
  const tableId = cryptoUUID();
  api.events.emit('import:before', { source: 'datasette', tableId });
  await api.store.tables.insert({
    id: tableId,
    workspaceId,
    name,
    code: slug(`${ref.db}-${ref.table}`),
    columns,
    view: 'table',
    updatedAt: now,
  });

  const docs: Row[] = rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: now }));
  await api.store.rows(tableId).bulkInsert(docs);

  api.events.emit('import:after', { source: 'datasette', tableId, rowCount: rows.length });

  return { name, rowCount: rows.length, hasMore, truncated, pages, count };
}

function toastCapped(api: HostApi, r: OneResult): void {
  const total = r.count != null ? ` of ${r.count}` : '';
  const table = r.name.split('/').pop() ?? r.name;
  api.ui.dialogs.toast(
    `Imported first ${r.rowCount}${total} rows from ${table} — more available ` +
      `(capped at ${SETTINGS.maxImportRows}). Live paging arrives with the Phase-2 connector.`,
    { kind: 'warning', title: 'Datasette import' },
  );
}

function summariseBatch(
  api: HostApi,
  s: { imported: number; totalRows: number; capped: string[]; failed: string[]; requested: number },
): void {
  const rows = `${s.totalRows.toLocaleString()} row${s.totalRows === 1 ? '' : 's'}`;
  const tables = `${s.imported} table${s.imported === 1 ? '' : 's'}`;
  if (s.failed.length > 0) {
    api.ui.dialogs.toast(
      `Imported ${tables} (${rows}); ${s.failed.length} failed:\n${s.failed.join('\n')}`,
      { kind: 'error', title: 'Datasette import' },
    );
    return;
  }
  if (s.capped.length > 0) {
    api.ui.dialogs.toast(
      `Imported ${tables} (${rows}). ${s.capped.length} capped at ${SETTINGS.maxImportRows} — ` +
        `more available: ${s.capped.join(', ')}.`,
      { kind: 'warning', title: 'Datasette import' },
    );
    return;
  }
  api.ui.dialogs.toast(`Imported ${tables} (${rows}) from Datasette.`, {
    kind: 'success',
    title: 'Datasette import',
  });
}

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'table';
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
