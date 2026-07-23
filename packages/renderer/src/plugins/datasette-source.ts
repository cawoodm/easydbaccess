// packages/renderer/src/plugins/datasette-source.ts
//
// easyDBAccess built-in plugin — import from any online Datasette instance as
// local eda tables (read-only snapshots). A URL may point at:
//   - a single table      (.../<db>/<table>)  → imported directly;
//   - a whole database     (.../<db>)          → pick tables from a checklist;
//   - an entire instance   (https://host)      → pick tables across all databases.
// Registers a URL source and a (table-only) drop handler. The Phase-2 live
// read-write connector builds on the same datasette-client core.

import type { ColumnSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import {
  parseDatasetteUrl,
  fetchDatabaseNames,
  fetchTablesForDb,
  fetchTableMeta,
  fetchRows,
  fetchPrimaryKeys,
  inferColumnsFromRows,
  refineColumnTypes,
  testConnection,
  withAuthFetch,
  DatasetteError,
  type DatasetteRef,
  type TableRef,
} from './datasette-client.js';

type FetchFn = (url: string, opts?: unknown) => Promise<Response>;

const host = (base: string): string => base.replace(/^https?:\/\//, '');

/**
 * Resolve the tables the user wants to act on from a Datasette URL:
 *  - table URL      → that one table (no picker);
 *  - database URL   → its tables, via the table checklist;
 *  - instance URL   → pick database(s) first, then their tables.
 * Returns the chosen tables, [] if none exist, or null if cancelled.
 */
async function resolveChosenTables(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  verb: 'Import' | 'Connect',
): Promise<TableRef[] | null> {
  if (ref.db && ref.table) {
    return [{ db: ref.db, table: ref.table, count: null, hidden: false, pks: [] }];
  }

  let tables: TableRef[] = [];
  if (ref.db) {
    for (const t of await fetchTablesForDb(fetchFn, ref.base, ref.db)) if (!t.hidden) tables.push(t);
  } else {
    // Instance URL: list databases and let the user choose which to pull from.
    const dbs = await fetchDatabaseNames(fetchFn, ref.base);
    if (dbs.length === 0) return [];
    let chosenDbs = dbs;
    if (dbs.length > 1) {
      const picked = await chooseTables(
        dbs.map((d) => ({ name: d, size: null })),
        {
          title: `${verb} from Datasette`,
          message: `Choose databases on ${host(ref.base)}, then their tables.`,
          confirmLabel: 'Next: choose tables',
        },
      );
      if (!picked) return null;
      chosenDbs = picked.map((i) => dbs[i]!);
    }
    for (const db of chosenDbs) {
      // Skip a database we can't list (permissions, odd route) rather than
      // aborting the whole instance.
      try {
        for (const t of await fetchTablesForDb(fetchFn, ref.base, db)) if (!t.hidden) tables.push(t);
      } catch {
        /* skip */
      }
    }
  }

  if (tables.length === 0) return [];
  const multiDb = new Set(tables.map((t) => t.db)).size > 1;
  const picked = await chooseTables(
    tables.map((t) => ({
      name: multiDb ? `${t.db}/${t.table}` : t.table,
      size: t.count,
      detail: multiDb ? undefined : t.db,
    })),
    {
      title: `${verb} from Datasette`,
      message: `Choose tables to ${verb.toLowerCase()} from ${host(ref.base)}.`,
      confirmLabel: verb,
    },
  );
  if (!picked) return null;
  return picked.map((i) => tables[i]!);
}
import { chooseTables } from '../dialogs/table-select-dialog.js';
import { createDatasetteCollection, tokenSettingKey } from './datasette-collection.js';
import '../dialogs/datasette-connect-dialog.js';
import { DatasetteConnectDialog } from '../dialogs/datasette-connect-dialog.js';

const CONNECT_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4A3.1 3.1 0 0 1 17 15h-4v1.9h4a5 5 0 0 0 0-10z"/></svg>';

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
  // Register the visible UI first, so a later failure (e.g. an older host that
  // predates `registerRowSource`) can never prevent the Connect button from
  // appearing. The button is this plugin's only discoverable entry point;
  // losing it silently is exactly the "I don't see a connect button" trap.

  // "Connect Datasette (live)" — opens a live read-write table (vs the Import
  // button, which snapshots rows into a plain local table).
  api.ui.registerHeaderButton({
    id: 'datasette:connect',
    label: 'Connect',
    icon: CONNECT_ICON_SVG,
    tooltip: 'Connect a live, editable Datasette table',
    onClick: () => openConnectDialog(api),
  });

  // Phase 2c: tables carrying `source: { type: 'datasette', ... }` are backed
  // by a live read-write Datasette collection instead of Dexie (routed by the
  // Phase-2a seam). Snapshot imports are unaffected — they create plain local
  // tables with no `source`. Guarded so a host without this seam still shows
  // the Connect button above (live routing just won't be available).
  // A per-table Refresh button, shown only on Datasette-backed tables (live
  // connections and imported snapshots). Live tables re-pull from the remote;
  // snapshots re-fetch and replace their local rows.
  api.ui.registerTableButton({
    id: 'datasette:refresh',
    label: 'Refresh',
    icon: 'refresh',
    tooltip: 'Reload this table from its Datasette backend',
    visible: (table) => table.source?.type === 'datasette' || table.origin?.type === 'datasette',
    onClick: (a, { tableId }) => refreshDatasetteTable(a, tableId),
  });

  if (typeof api.registerRowSource === 'function') {
    api.registerRowSource({ type: 'datasette', create: createDatasetteCollection });
  }

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

  const chosen = await resolveChosenTables(fetchFn, ref, 'Import');
  if (chosen === null) return; // cancelled
  if (chosen.length === 0) {
    await api.ui.dialogs.alert('No tables found at that Datasette URL.', 'Datasette import');
    return;
  }

  // Single explicit table (from a table URL) keeps its per-table toast.
  if (ref.db && ref.table && chosen.length === 1) {
    const r = await importOneTable(api, workspaceId, ref);
    if (r.hasMore || r.truncated) toastCapped(api, r);
    return;
  }

  let imported = 0;
  let totalRows = 0;
  const capped: string[] = [];
  const failed: string[] = [];
  for (const c of chosen) {
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

  summariseBatch(api, { imported, totalRows, capped, failed, requested: chosen.length });
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
    // Record where this snapshot came from so it can be refreshed later. This
    // is NOT a live `source` — rows stay local; `origin` only says how to
    // re-pull them.
    origin: {
      type: 'datasette',
      url: `${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}`,
    },
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

// -- Live connect (Phase 2b) -------------------------------------------------

async function openConnectDialog(api: HostApi): Promise<void> {
  const dlg = DatasetteConnectDialog.instance ?? mountConnectDialog();
  const fetchFn = (u: string, o?: unknown) => api.backend.fetch(u, o as never);
  const result = await dlg.open({
    initialUrl: 'https://datasette.io',
    async onTest(url, token) {
      const ref = parseDatasetteUrl(url);
      const status = await testConnection(fetchFn, ref.base, { token: token || undefined });
      if (!status.reachable) return `Unreachable: ${status.error ?? 'no response'}`;
      const v = status.version ? ` (Datasette ${status.version})` : '';
      return status.writable
        ? `Reachable${v} — signed in, read-write.`
        : `Reachable${v} — read-only (no token / not authenticated).`;
    },
  });
  if (!result) return;
  try {
    await connectDatasette(api, result.url, result.token);
  } catch (err) {
    const msg = err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    await api.ui.dialogs.alert(msg, 'Connect Datasette failed');
  }
}

function mountConnectDialog(): DatasetteConnectDialog {
  const el = document.createElement('datasette-connect-dialog') as DatasetteConnectDialog;
  document.body.appendChild(el);
  return el;
}

/** Open live read-write table(s) for a Datasette URL (table, database, or instance). */
export async function connectDatasette(api: HostApi, input: string, token: string): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-source: no active workspace');

  const ref = parseDatasetteUrl(input);
  const baseFetch = (u: string, o?: unknown) => api.backend.fetch(u, o as never);
  // Authenticated reads so discovery/metadata work on private instances too.
  const fetchFn = withAuthFetch(baseFetch, token || undefined);

  // The /-/versions.json + /-/actor.json probe only tells us the version and
  // whether the token authenticates (→ writability). It's advisory: some hosts
  // (e.g. datasette.io behind Cloudflare) challenge those endpoints even though
  // table pages read fine. So don't hard-fail on it — let table discovery below
  // be the real reachability gate.
  const status = await testConnection(baseFetch, ref.base, { token: token || undefined });
  // Store the token device-local (per instance base). Settings are not synced,
  // so the token never leaves this device or lands in a workspace export.
  if (token) await api.store.settings.upsert({ key: tokenSettingKey(ref.base), value: token });

  let chosen: TableRef[] | null;
  try {
    chosen = await resolveChosenTables(fetchFn, ref, 'Connect');
  } catch (err) {
    const detail = err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    throw new Error(`Couldn't read tables from ${host(ref.base)}: ${detail}`);
  }
  if (chosen === null) return; // cancelled
  if (chosen.length === 0) {
    await api.ui.dialogs.alert('No tables found at that URL.', 'Connect Datasette');
    return;
  }

  let connected = 0;
  for (const c of chosen) {
    await createLiveTable(api, workspaceId, ref.base, c, status.writable, token);
    connected += 1;
  }
  const mode = status.writable ? 'read-write' : 'read-only';
  api.ui.dialogs.toast(
    `Connected ${connected} live table${connected === 1 ? '' : 's'} from Datasette (${mode}).`,
    { kind: 'success', title: 'Connect Datasette' },
  );
}

/** Create a Table with a live `datasette` source (columns discovered; no local rows). */
async function createLiveTable(
  api: HostApi,
  workspaceId: string,
  base: string,
  c: TableRef,
  writable: boolean,
  token: string,
): Promise<string> {
  const ref: DatasetteRef = { base, db: c.db, table: c.table, query: {} };
  const fetchFn = withAuthFetch((u: string, o?: unknown) => api.backend.fetch(u, o as never), token || undefined);

  // Columns: schema names refined from a small sample (see importOneTable).
  let metaColumns: ColumnSpec[] = [];
  let typed = false;
  try {
    const meta = await fetchTableMeta(fetchFn, ref);
    metaColumns = meta.columns;
    typed = meta.typed;
  } catch {
    /* fall back to row inference */
  }
  const { rows: sample } = await fetchRows(fetchFn, ref, { maxRows: 50, pageSize: 50 });
  const baseColumns =
    metaColumns.length === 0
      ? inferColumnsFromRows(sample)
      : typed
        ? metaColumns
        : refineColumnTypes(metaColumns, sample);

  // PKs from the database listing, else a dedicated probe. Needed to address
  // rows for update/delete.
  let pks = c.pks;
  if (!pks || pks.length === 0) {
    try {
      pks = await fetchPrimaryKeys(fetchFn, ref);
    } catch {
      pks = [];
    }
  }
  const columns = baseColumns.map((col) =>
    pks.includes(col.field) ? { ...col, unique: true, notnull: true } : col,
  );

  // Reuse an existing live table for the same (base, db, table) rather than
  // piling up duplicates on every reconnect. When found, refresh its columns +
  // source in place (keeping window geometry, sort, filters) instead of
  // inserting a new record.
  const existing = (await api.store.tables.find()).find((t) => {
    const cfg = t.source?.config as { base?: string; db?: string; table?: string } | undefined;
    return (
      t.workspaceId === workspaceId &&
      t.source?.type === 'datasette' &&
      cfg?.base === base &&
      cfg?.db === c.db &&
      cfg?.table === c.table
    );
  });

  const tableId = existing?.id ?? cryptoUUID();
  const record = {
    ...(existing ?? {}),
    id: tableId,
    workspaceId,
    name: `${c.db}/${c.table}`,
    code: slug(`${c.db}-${c.table}`),
    columns,
    view: existing?.view ?? 'table',
    source: { type: 'datasette', writable, config: { base, db: c.db, table: c.table, pks } },
    updatedAt: Date.now(),
  };
  if (existing) await api.store.tables.upsert(record);
  else await api.store.tables.insert(record);
  return tableId;
}

/**
 * Refresh a Datasette-backed table. Live (`source`) tables re-pull from the
 * shared remote collection (find() reloads its cache and notifies the grid).
 * Snapshot (`origin`) tables re-fetch their rows and replace the local copy.
 */
async function refreshDatasetteTable(api: HostApi, tableId: string): Promise<void> {
  const t = await api.store.tables.findOne(tableId);
  if (!t) return;
  try {
    if (t.source?.type === 'datasette') {
      // Live table: force the shared collection to re-read (find() alone would
      // return its cache), which also notifies the grid + footer subscribers.
      const coll = api.store.rows(tableId);
      if (typeof coll.refresh === 'function') await coll.refresh();
      const rows = await coll.find();
      api.ui.dialogs.toast(`Reloaded ${rows.length} rows from Datasette.`, {
        kind: 'success',
        title: 'Refresh',
      });
    } else if (t.origin?.type === 'datasette') {
      await refreshSnapshot(api, t);
    }
  } catch (err) {
    const msg = err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    api.ui.dialogs.toast(`Refresh failed: ${msg}`, { kind: 'error', title: 'Refresh' });
  }
}

/** Re-fetch a snapshot table's rows from its origin URL and replace them locally. */
async function refreshSnapshot(api: HostApi, t: Table): Promise<void> {
  const ref = parseDatasetteUrl(t.origin!.url);
  const fetchFn = (u: string) => api.backend.fetch(u);
  const { rows, hasMore, truncated } = await fetchRows(fetchFn, ref, {
    maxRows: SETTINGS.maxImportRows,
    pageSize: SETTINGS.pageSize,
  });
  const now = Date.now();
  const rowColl = api.store.rows(t.id);
  const old = await rowColl.find();
  await rowColl.bulkRemove(old.map((r) => r.id));
  await rowColl.bulkInsert(
    rows.map((data) => ({ id: cryptoUUID(), tableId: t.id, data, updatedAt: now })),
  );
  await api.store.tables.patch(t.id, { updatedAt: now });
  const capped = hasMore || truncated ? ` (capped at ${SETTINGS.maxImportRows})` : '';
  api.ui.dialogs.toast(`Refreshed ${rows.length} rows from ${ref.db}/${ref.table}${capped}.`, {
    kind: hasMore || truncated ? 'warning' : 'success',
    title: 'Refresh',
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
