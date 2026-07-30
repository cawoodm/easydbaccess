// packages/renderer/src/plugins/datasette-connect.ts
//
// easyDBAccess built-in plugin — CONNECT a live, read-write Datasette table.
// Rows are fetched from the instance on demand and never stored locally: the
// table carries `source: { type: 'datasette' }` and the routed data store hands
// it the collection in `datasette-collection.ts`.
//
// This is deliberately NOT importing. Importing takes a snapshot you own and
// can edit offline; connecting points a window at somebody else's live table.
// Different button, different dialog, different process — which is why this
// plugin and `datasette-import.ts` are separate, sharing only
// `datasette-common.ts` and the wire layer in `datasette-client.ts`.

import type { ColumnSpec, HostApi, PluginModule } from '@easydb/shared';
import '../dialogs/datasette-connect-dialog.js';
import { DatasetteConnectDialog } from '../dialogs/datasette-connect-dialog.js';
import {
  applyTableMetadata,
  DatasetteError,
  fetchPrimaryKeys,
  fetchRows,
  fetchTableMeta,
  fetchTableMetadata,
  inferColumnsFromRows,
  parseDatasetteUrl,
  probeSingleTable,
  refineColumnTypes,
  testConnection,
  withAuthFetch,
  type DatasetteRef,
  type MetadataTablePatch,
  type TableRef,
} from './datasette-client.js';
import {
  host,
  resolveChosenTables,
  uniqueTableName,
  withDatasetteSourceInfo,
} from './datasette-common.js';
import { createDatasetteCollection, tokenSettingKey } from './datasette-collection.js';
import { cryptoUUID, slugTable } from '../util/ids.js';

const CONNECT_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4A3.1 3.1 0 0 1 17 15h-4v1.9h4a5 5 0 0 0 0-10z"/></svg>';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'datasette-connect',
  name: 'Datasette Connect',
  type: 'source',
  version: '0.3.0',
  description:
    'Connect a live, editable table on any Datasette instance — rows are never stored locally',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/datasette-connect.ts',
};

export function init(api: HostApi): void {
  // Register the connector FIRST, so a later failure (e.g. an older host that
  // predates `registerRowSource`) can never keep Datasette out of the Connect
  // menu. Being unreachable from the UI is exactly the "I don't see a connect
  // button" trap this plugin used to fall into.
  //
  // The header button itself belongs to `connect-menu`, which lists every
  // registered connector. This plugin no longer owns a button, so a second
  // backend does not mean a second "Connect" in the header.
  api.ui.registerConnector({
    id: 'datasette',
    label: 'Datasette',
    icon: CONNECT_ICON_SVG,
    order: 10,
    description: 'A live, editable table on any Datasette instance',
    connect: (a) => openConnectDialog(a),
  });

  // Refresh for LIVE tables only. An imported snapshot has its own Refresh in
  // `datasette-import`, which re-fetches and merges rather than re-reading a
  // cache — the two are different operations, so they are different buttons.
  // The predicates are mutually exclusive, so no table shows both.
  api.ui.registerTableButton({
    id: 'datasette:refresh-live',
    label: 'Refresh',
    icon: 'refresh',
    tooltip: 'Re-read this live table from its Datasette instance',
    visible: (table) => table.source?.type === 'datasette',
    onClick: (a, { tableId }) => refreshLiveTable(a, tableId),
  });

  // Tables carrying `source: { type: 'datasette', … }` are backed by a live
  // read-write collection instead of Dexie. Snapshot imports are unaffected —
  // they create plain local tables with no `source`. Guarded so a host without
  // this seam still lists the connector above.
  if (typeof api.registerRowSource === 'function') {
    api.registerRowSource({ type: 'datasette', create: createDatasetteCollection });
  }
}

/**
 * Re-read a live table from its instance. `find()` alone would return the
 * collection's cache, so force a refresh — which also notifies the grid and
 * footer subscribers.
 */
async function refreshLiveTable(api: HostApi, tableId: string): Promise<void> {
  const t = await api.store.tables.findOne(tableId);
  if (t?.source?.type !== 'datasette') return;
  try {
    const coll = api.store.rows(tableId);
    if (typeof coll.refresh === 'function') await coll.refresh();
    const rows = await coll.find();
    api.ui.dialogs.toast(`Reloaded ${rows.length} rows from Datasette.`, {
      kind: 'success',
      title: 'Refresh',
    });
  } catch (err) {
    const msg =
      err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    api.ui.dialogs.toast(`Refresh failed: ${msg}`, { kind: 'error', title: 'Refresh' });
  }
}

async function openConnectDialog(api: HostApi): Promise<void> {
  const dlg = DatasetteConnectDialog.instance ?? mountConnectDialog();
  const fetchFn = (u: string, o?: unknown) => api.backend.fetch(u, o as never);
  const result = await dlg.open({
    initialUrl: 'https://datasette.io',
    async onTest(url, token) {
      const ref = parseDatasetteUrl(url);
      const status = await testConnection(fetchFn, ref.base, { token: token || undefined });
      if (ref.db && ref.table) {
        // Probe the ACTUAL table — instance reachability alone would wrongly
        // pass a missing/typo'd table, and datasette.io challenges /-/versions
        // anyway. Throws DatasetteError if the table isn't there → runTest shows
        // it in red.
        await probeSingleTable(withAuthFetch(fetchFn, token || undefined), ref);
        const v = status.version ? ` (Datasette ${status.version})` : '';
        return status.writable
          ? `Reachable${v} — table found, signed in, read-write.`
          : `Reachable${v} — table found, read-only (no token / not authenticated).`;
      }
      if (!status.reachable) return `Unreachable: ${status.error ?? 'no response'}`;
      const v = status.version ? ` (Datasette ${status.version})` : '';
      return status.writable
        ? `Reachable${v} — signed in, read-write.`
        : `Reachable${v} — read-only (no token / not authenticated).`;
    },
    async onConnect(url, token) {
      // Pre-flight gate: for a single-table URL, confirm the table exists BEFORE
      // the dialog closes, so a "Table not found" stays inline in the dialog
      // rather than closing and alerting. db/instance URLs aren't gated here —
      // their discovery + table picker runs in connectDatasette after close.
      const ref = parseDatasetteUrl(url);
      if (ref.db && ref.table) {
        await probeSingleTable(withAuthFetch(fetchFn, token || undefined), ref);
      }
    },
  });
  if (!result) return;
  try {
    await connectDatasette(api, result.url, result.token);
  } catch (err) {
    const msg =
      err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
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
  if (token) await api.store.settings.upsert({ name: tokenSettingKey(ref.base), value: token });

  let chosen: TableRef[] | null;
  try {
    chosen = await resolveChosenTables(fetchFn, ref, 'Connect');
  } catch (err) {
    const detail =
      err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    throw new Error(`Couldn't read tables from ${host(ref.base)}: ${detail}`);
  }
  if (chosen === null) return; // cancelled
  if (chosen.length === 0) {
    await api.ui.dialogs.alert('No tables found at that URL.', 'Connect Datasette');
    return;
  }

  // Window-first: create every live table record up front (no data fetched
  // yet) so all windows appear immediately. Each grid then loads its own rows
  // via the routed collection, showing its progress bar. Columns/pks are
  // refined in the background so the windows don't wait on a schema probe.
  const created: Array<{ tableId: string; c: TableRef }> = [];
  for (const c of chosen) {
    const tableId = await upsertLiveTable(api, workspaceId, ref.base, c, status.writable, token);
    if (tableId === null) continue; // user skipped a name collision
    created.push({ tableId, c });
  }
  if (created.length === 0) return; // every table skipped
  const mode = status.writable ? 'read-write' : 'read-only';
  api.ui.dialogs.toast(
    `Connected ${created.length} live table${created.length === 1 ? '' : 's'} from Datasette (${mode}).`,
    { kind: 'success', title: 'Connect Datasette' },
  );
  for (const { tableId, c } of created) {
    void refineLiveColumns(api, tableId, ref.base, c, token);
  }
}

/**
 * Insert (or reuse) a Table with a live `datasette` source. This creates the
 * window immediately; the only fetch is a pk probe when the caller didn't
 * already know the primary keys (a bare table URL) — needed so the `source` is
 * FINAL here. It must never change afterwards: the routed store memoises one
 * collection per table keyed on `source`, so a later `source` edit would strand
 * the grid/footer on the old collection (Refresh would act on a different one).
 * Columns are still filled in lazily by `refineLiveColumns`.
 */
async function upsertLiveTable(
  api: HostApi,
  workspaceId: string,
  base: string,
  c: TableRef,
  writable: boolean,
  token: string,
): Promise<string | null> {
  // Reconnecting to the SAME live source (base/db/table) silently reuses its
  // table so geometry/sort/filters survive — that isn't a name collision.
  const workspaceTables = (await api.store.tables.find()).filter(
    (t) => t.workspaceId === workspaceId,
  );
  let name = `${c.db}/${c.table}`;
  let existing = workspaceTables.find((t) => {
    const cfg = t.source?.config as { base?: string; db?: string; table?: string } | undefined;
    return (
      t.source?.type === 'datasette' &&
      cfg?.base === base &&
      cfg?.db === c.db &&
      cfg?.table === c.table
    );
  });

  // Otherwise, a DIFFERENT table sharing this name (e.g. an earlier import
  // snapshot) is a real collision — never resolve it silently; ask the user.
  if (!existing) {
    const clash = workspaceTables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (clash) {
      const choice = await api.ui.dialogs.choice(
        `A table named "${name}" already exists in this workspace.`,
        ['Overwrite', 'Rename', 'Skip'],
        'Connect — table already exists',
      );
      if (!choice || choice === 'Skip') return null;
      if (choice === 'Overwrite') existing = clash;
      else name = uniqueTableName(new Set(workspaceTables.map((t) => t.name)), name);
    }
  }

  // pks from the listing when available (multi-table connect → no fetch, window
  // is instant); otherwise probe once so writes address rows correctly.
  let pks = c.pks ?? [];
  if (pks.length === 0) {
    const fetchFn = withAuthFetch(
      (u: string, o?: unknown) => api.backend.fetch(u, o as never),
      token || undefined,
    );
    try {
      pks = await fetchPrimaryKeys(fetchFn, { base, db: c.db, table: c.table, query: {} });
    } catch {
      pks = [];
    }
  }

  const tableId = existing?.id ?? cryptoUUID();
  const record = {
    ...(existing ?? {}),
    id: tableId,
    workspaceId,
    name,
    code: slugTable(`${c.db}-${c.table}`),
    // Keep an existing table's columns so a reconnect shows them at once; a new
    // one starts empty and gets them from refineLiveColumns.
    columns: existing?.columns ?? [],
    view: existing?.view ?? 'table',
    source: { type: 'datasette', writable, config: { base, db: c.db, table: c.table, pks } },
    updatedAt: Date.now(),
  };
  if (existing) await api.store.tables.upsert(record);
  else await api.store.tables.insert(record);
  return tableId;
}

/**
 * Background COLUMN discovery for a live table: fetch the schema + a small
 * sample and patch ONLY the table's `columns` (pk flags read from the already-
 * final `source`). Never touches `source` — see the warning in upsertLiveTable.
 * The grid re-renders its columns when the record updates; failures are
 * swallowed (the grid's own row fetch surfaces real connection errors).
 */
async function refineLiveColumns(
  api: HostApi,
  tableId: string,
  base: string,
  c: TableRef,
  token: string,
): Promise<void> {
  const ref: DatasetteRef = { base, db: c.db, table: c.table, query: {} };
  const fetchFn = withAuthFetch(
    (u: string, o?: unknown) => api.backend.fetch(u, o as never),
    token || undefined,
  );
  try {
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
    if (baseColumns.length === 0) return; // learned nothing; leave placeholder

    // The table may have been closed while we fetched.
    const t = await api.store.tables.findOne(tableId);
    if (!t) return;
    const pks = ((t.source?.config as { pks?: string[] } | undefined)?.pks ?? []) as string[];
    let columns = baseColumns.map((col) =>
      pks.includes(col.field) ? { ...col, unique: true, notnull: true } : col,
    );
    let metaPatch: MetadataTablePatch = {};
    try {
      const md = await fetchTableMetadata(fetchFn, ref);
      const applied = applyTableMetadata(md, columns);
      columns = applied.columns;
      metaPatch = applied.patch;
    } catch {
      /* metadata is optional */
    }
    metaPatch = withDatasetteSourceInfo(metaPatch, ref.base, c.db, c.table);
    await api.store.tables.patch(tableId, { columns, ...metaPatch, updatedAt: Date.now() });
  } catch {
    /* leave the placeholder; the grid's row fetch reports real failures */
  }
}
