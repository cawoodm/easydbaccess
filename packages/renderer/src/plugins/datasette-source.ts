// packages/renderer/src/plugins/datasette-source.ts
//
// easyDBAccess built-in plugin — import from any online Datasette instance as
// local eda tables (read-only snapshots). A URL may point at:
//   - a single table      (.../<db>/<table>)  → imported directly;
//   - a whole database     (.../<db>)          → pick tables from a checklist;
//   - an entire instance   (https://host)      → pick tables across all databases.
// Registers a URL source and a (table-only) drop handler. The Phase-2 live
// read-write connector builds on the same datasette-client core.

import type {
  ColumnSpec,
  HostApi,
  ImportResume,
  PluginModule,
  Row,
  Table,
  TableInfo,
} from '@easydb/shared';
import {
  parseDatasetteUrl,
  fetchDatabaseNames,
  fetchTablesForDb,
  fetchTableMeta,
  fetchTableCount,
  fetchRows,
  fetchPrimaryKeys,
  fetchTableMetadata,
  applyTableMetadata,
  inferColumnsFromRows,
  refineColumnTypes,
  testConnection,
  withAuthFetch,
  DatasetteError,
  type DatasetteRef,
  type TableRef,
  type MetadataTablePatch,
} from './datasette-client.js';

type FetchFn = (url: string, opts?: unknown) => Promise<Response>;

const host = (base: string): string => base.replace(/^https?:\/\//, '');

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before auto-resuming a rate-limited import — 60s in
 * production, matching the "resume delayed" prompt. A test seam
 * (`window.__eda_resumeDelayMs`) shortens it so e2e doesn't stall a real minute.
 */
function resumeDelayMs(): number {
  const o = (globalThis as { __eda_resumeDelayMs?: number }).__eda_resumeDelayMs;
  return typeof o === 'number' && o >= 0 ? o : 60_000;
}

/** Human-facing Datasette table URL (`base/db/table`). */
function datasetteTableUrl(base: string, db: string, table: string): string {
  return `${base}/${encodeURIComponent(db)}/${encodeURIComponent(table)}`;
}

/**
 * Ensure a Datasette table's metadata patch carries a `TableInfo` with at least
 * its source URL, so the titlebar (i) info button ALWAYS appears for a
 * Datasette-backed table — even when the instance publishes no description or
 * license (datasette.io, for one, publishes none). A real `source`/`sourceUrl`
 * supplied by the instance is left untouched.
 */
function withDatasetteSourceInfo(
  patch: MetadataTablePatch,
  base: string,
  db: string,
  table: string,
): MetadataTablePatch {
  const info: TableInfo = { ...(patch.info ?? {}) };
  if (!info.source && !info.sourceUrl) {
    info.source = `${host(base)}/${db}/${table}`;
    info.sourceUrl = datasetteTableUrl(base, db, table);
  }
  return { ...patch, info };
}

/**
 * The resume state to persist after a fetch. Only an INTERRUPTION (an `error`
 * with a resume cursor) is resumable — the deliberate row cap is not. Returns
 * `undefined` for a clean/complete fetch, which clears any prior resume marker.
 */
function resumeStateFor(
  error: string | undefined,
  nextUrl: string | undefined,
  loadedRows: number,
  count: number | null,
): ImportResume | undefined {
  if (!error || !nextUrl) return undefined;
  return { nextUrl, loadedRows, ...(count != null ? { totalCount: count } : {}) };
}

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
  opts: { skipPicker?: boolean | undefined } = {},
): Promise<TableRef[] | null> {
  if (ref.db && ref.table) {
    return [{ db: ref.db, table: ref.table, count: null, hidden: false, pks: [] }];
  }

  let tables: TableRef[] = [];
  if (ref.db) {
    // Include hidden tables so the picker can show + offer them; only the
    // no-picker fast path (db chosen upstream) auto-excludes them.
    tables.push(...(await fetchTablesForDb(fetchFn, ref.base, ref.db)));
    // The db was already chosen upstream (e.g. picked in the Import dialog):
    // import all its (non-hidden) tables directly, skipping the table checklist.
    // An empty result (db has no tables / doesn't exist) falls through to the
    // caller's "nothing found" handling.
    if (opts.skipPicker) return tables.filter((t) => !t.hidden);
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
        tables.push(...(await fetchTablesForDb(fetchFn, ref.base, db)));
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
      hidden: t.hidden,
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
import { setTableLoading } from '../table/data-table.js';
import { reconcileColumns } from '../table/column-merge.js';
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

  // Shown (in red) only while a snapshot import was interrupted part-way — the
  // table carries a persisted resume cursor. Clicking continues from that page.
  api.ui.registerTableButton({
    id: 'datasette:resume',
    label: 'Resume import',
    icon: 'sync_problem',
    tooltip: 'Import was interrupted — click to resume from where it stopped',
    danger: true,
    visible: (table) => table.origin?.type === 'datasette' && table.importResume != null,
    onClick: (a, { tableId }) => resumeImport(a, tableId),
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
  /** Set when paging stopped early on a failure (e.g. rate limiting) but some
   * rows were still salvaged — the table imported partially, not fully. */
  error?: string | undefined;
}

/** First "name", "name (2)", "name (3)"… not already used by a table in the set. */
function uniqueTableName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Smart entry point. Resolves a Datasette URL to one or many tables and imports
 * them. A single-table URL imports straight away; a database/instance URL
 * discovers its tables and opens a checklist (all pre-selected) so the user
 * chooses what to pull in.
 */
export async function importDatasette(
  api: HostApi,
  input: string,
  opts: { skipTablePicker?: boolean | undefined } = {},
): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-source: no active workspace');

  const ref = parseDatasetteUrl(input);
  const fetchFn = (u: string) => api.backend.fetch(u);

  const chosen = await resolveChosenTables(fetchFn, ref, 'Import', {
    skipPicker: opts.skipTablePicker,
  });
  if (chosen === null) return; // cancelled
  if (chosen.length === 0) {
    await api.ui.dialogs.alert('No tables found at that Datasette URL.', 'Datasette import');
    return;
  }

  // Window-first, two phases so all windows appear (with progress bars) before
  // any rows are fetched:
  //   1. resolve name collisions and CREATE every table record (empty shell),
  //   2. fetch + fill each in turn, its window showing a progress bar.
  // (The generic per-table import toast is suppressed for datasette in
  // app-context, so summariseBatch is the single message.)
  const plans: Array<{
    tableId: string;
    ref: DatasetteRef;
    overwrite: boolean;
    knownCount: number | null;
  }> = [];
  let skipped = 0;
  for (const c of chosen) {
    const cref: DatasetteRef = { base: ref.base, db: c.db, table: c.table, query: {} };
    const prep = await prepareImportTable(api, workspaceId, cref);
    if (prep.skipped) {
      skipped += 1;
      continue;
    }
    // Carry the row count from the table listing (whole-db imports have it) so
    // the progress bar is proportional from the first page.
    plans.push({
      tableId: prep.tableId,
      ref: cref,
      overwrite: prep.overwrite,
      knownCount: c.count,
    });
  }

  let imported = 0;
  let totalRows = 0;
  const capped: string[] = [];
  const partial: string[] = [];
  const failed: string[] = [];
  for (const p of plans) {
    try {
      const r = await fillImportTable(api, p.tableId, p.ref, p.overwrite, p.knownCount);
      imported += 1;
      totalRows += r.rowCount;
      // A partial import (paging stopped on a failure, e.g. rate limiting) still
      // landed its salvaged rows — report it as partial, not merely "capped".
      if (r.error) partial.push(`${p.ref.db}/${p.ref.table} (${r.error})`);
      else if (r.hasMore || r.truncated) capped.push(`${p.ref.db}/${p.ref.table}`);
    } catch (err) {
      failed.push(`${p.ref.db}/${p.ref.table}: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  summariseBatch(api, {
    imported,
    skipped,
    totalRows,
    capped,
    partial,
    failed,
    requested: chosen.length,
  });
}

/**
 * Phase 1 of an import: resolve a name collision (Overwrite / Rename / Skip) and
 * create the destination table as an EMPTY shell so its window appears right
 * away. No rows are fetched here. Returns the target table id, or `skipped`.
 */
async function prepareImportTable(
  api: HostApi,
  workspaceId: string,
  ref: DatasetteRef,
): Promise<{ tableId: string; overwrite: boolean; skipped?: boolean }> {
  const name = `${ref.db}/${ref.table}`;
  const origin = {
    type: 'datasette',
    url: `${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}`,
  } as const;

  const workspaceTables = (await api.store.tables.find()).filter(
    (t) => t.workspaceId === workspaceId,
  );
  const existing = workspaceTables.find((t) => t.name === name);
  let targetName = name;
  if (existing) {
    const choice = await api.ui.dialogs.choice(
      `A table named "${name}" already exists in this workspace.`,
      ['Overwrite', 'Rename', 'Skip'],
      'Import — table already exists',
    );
    if (!choice || choice === 'Skip') return { tableId: '', overwrite: false, skipped: true };
    if (choice === 'Overwrite') {
      // Reuse the existing table/window; keep its columns visible until the new
      // rows land. Just stamp the origin now.
      await api.store.tables.patch(existing.id, { origin, updatedAt: Date.now() });
      return { tableId: existing.id, overwrite: true };
    }
    targetName = uniqueTableName(new Set(workspaceTables.map((t) => t.name)), name);
  }

  const tableId = cryptoUUID();
  await api.store.tables.insert({
    id: tableId,
    workspaceId,
    name: targetName,
    code: slug(`${ref.db}-${ref.table}`),
    columns: [], // filled by fillImportTable once rows arrive
    view: 'table',
    // Where this snapshot came from, for later refresh. NOT a live `source`.
    origin,
    updatedAt: Date.now(),
  });
  return { tableId, overwrite: false };
}

/**
 * Phase 2 of an import: fetch schema + rows for one already-created table and
 * populate it, driving the window's progress bar for the duration.
 */
async function fillImportTable(
  api: HostApi,
  tableId: string,
  ref: DatasetteRef,
  overwrite: boolean,
  knownCount: number | null = null,
): Promise<OneResult> {
  const name = `${ref.db}/${ref.table}`;
  const fetchFn = (u: string) => api.backend.fetch(u);
  setTableLoading(tableId, true);
  try {
    // Schema discovery via ?_extra=… is best-effort: older instances give no
    // columns (inferred from rows below); a hard failure is tolerated too — the
    // row fetch surfaces any real problem.
    let metaColumns: ColumnSpec[] = [];
    let count: number | null = knownCount;
    let typed = false;
    try {
      const meta = await fetchTableMeta(fetchFn, ref);
      metaColumns = meta.columns;
      count = count ?? meta.count;
      typed = meta.typed;
    } catch {
      // fall back to row inference
    }
    // Datasette.io's schema responses omit `count`, so a single-table import had
    // no denominator and only ever showed the indeterminate bar. Fetch the count
    // directly (cheap `?_extra=count`, WAF-safe) so the bar is proportional.
    // Best-effort: fetchTableCount returns null (never throws) on failure.
    if (count == null) count = await fetchTableCount(fetchFn, ref);

    // The row count gives a denominator for a proportional progress bar; without
    // it the bar stays indeterminate. Cap the denominator at the import limit so
    // the fraction reflects what we'll actually pull.
    const target = count && count > 0 ? Math.min(count, SETTINGS.maxImportRows) : 0;

    // Page through with an interactive resume. If a page hop fails (commonly the
    // instance rate-limiting a large import), keep the rows fetched so far and
    // PROMPT the user: wait 60s and resume from that exact page, or cancel and
    // keep the partial. Cancelling leaves the `importResume` marker set below, so
    // the footer's red "Resume import" button remains as a manual fallback. The
    // loop lets repeated rate-limit hits each be waited out.
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    let hasMore = false;
    let pages = 0;
    let error: string | undefined;
    let nextUrl: string | undefined;
    let startUrl: string | undefined;
    for (;;) {
      const seg = await fetchRows(fetchFn, ref, {
        maxRows: Math.max(0, SETTINGS.maxImportRows - rows.length),
        pageSize: SETTINGS.pageSize,
        ...(startUrl ? { startUrl } : {}),
        onProgress: (n) => {
          if (target > 0) setTableLoading(tableId, true, Math.min(1, (rows.length + n) / target));
        },
      });
      rows.push(...seg.rows);
      truncated = truncated || seg.truncated;
      pages += seg.pages;
      hasMore = seg.hasMore;
      error = seg.error;
      nextUrl = seg.nextUrl;
      // Stop unless we were genuinely interrupted (an error WITH a resume cursor)
      // and still have room under the cap. A clean read or a cap-hit ends here.
      if (!seg.error || !seg.nextUrl || rows.length >= SETTINGS.maxImportRows) break;

      const choice = await api.ui.dialogs.choice(
        `Import of "${name}" paused after ${rows.length.toLocaleString()} rows (${seg.error}). ` +
          `Datasette may be rate-limiting a large import. Wait 60 seconds and resume from ` +
          `where it stopped, or cancel and keep the rows imported so far (you can resume ` +
          `later from the table's footer)?`,
        ['Resume in 60s', 'Cancel'],
        'Import paused — rate limited?',
      );
      // Cancel / dismiss → keep the partial; the importResume marker persisted
      // below drives the footer's manual resume button.
      if (choice !== 'Resume in 60s') break;

      // Indeterminate bar + a heads-up toast during the wait, then resume.
      setTableLoading(tableId, true);
      api.ui.dialogs.toast(`Resuming "${name}" in 60s…`, { kind: 'info', title: 'Import paused' });
      await delay(resumeDelayMs());
      startUrl = seg.nextUrl;
      error = undefined; // re-set if the resumed segment fails again
      nextUrl = undefined;
    }

    // Prefer the schema's columns; infer from rows if none; refine types when
    // only bare names came back (e.g. datasette.io's `?_extra=columns`).
    const columns =
      metaColumns.length === 0
        ? inferColumnsFromRows(rows)
        : typed
          ? metaColumns
          : refineColumnTypes(metaColumns, rows);

    // Apply the table's Datasette metadata (default sort, …) onto columns +
    // table fields. Best-effort: no metadata endpoint ⇒ no-op.
    let cols = columns;
    let metaPatch: MetadataTablePatch = {};
    try {
      const md = await fetchTableMetadata(fetchFn, ref);
      const applied = applyTableMetadata(md, cols);
      cols = applied.columns;
      metaPatch = applied.patch;
    } catch {
      /* metadata is optional */
    }
    // Always record where the table came from so the (i) info button shows.
    metaPatch = withDatasetteSourceInfo(metaPatch, ref.base, ref.db!, ref.table!);

    // Preserve the user's column arrangement on an overwrite re-import (order,
    // hidden, widths …) and never re-add a column they deleted. A brand-new
    // table (empty columns) takes the discovered schema wholesale.
    const current = await api.store.tables.findOne(tableId);
    const existingCols = current?.columns ?? [];
    const isInitial = existingCols.length === 0;
    const { columns: mergedCols } = reconcileColumns(existingCols, cols, current?.deletedColumns);

    const now = Date.now();
    api.events.emit('import:before', { source: 'datasette', tableId });
    // Initial population applies the full metadata (default sort, label, info);
    // a re-import only refreshes the (i) info so the user's sort/label survive.
    // An interruption stores a resume cursor (footer shows a red resume button);
    // a clean import clears any prior one.
    const resume = resumeStateFor(error, nextUrl, rows.length, count);
    const patch = isInitial
      ? { columns: mergedCols, ...metaPatch, importResume: resume, updatedAt: now }
      : {
          columns: mergedCols,
          ...(metaPatch.info ? { info: metaPatch.info } : {}),
          importResume: resume,
          updatedAt: now,
        };
    await api.store.tables.patch(tableId, patch);

    const rowColl = api.store.rows(tableId);
    if (overwrite) {
      const old = await rowColl.find();
      await rowColl.bulkRemove(old.map((r) => r.id));
    }
    const docs: Row[] = rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: now }));
    await rowColl.bulkInsert(docs);

    api.events.emit('import:after', { source: 'datasette', tableId, rowCount: rows.length });
    return { name, rowCount: rows.length, hasMore, truncated, pages, count, error };
  } finally {
    setTableLoading(tableId, false);
  }
}

function summariseBatch(
  api: HostApi,
  s: {
    imported: number;
    skipped: number;
    totalRows: number;
    capped: string[];
    partial: string[];
    failed: string[];
    requested: number;
  },
): void {
  const rows = `${s.totalRows.toLocaleString()} row${s.totalRows === 1 ? '' : 's'}`;
  const tables = `${s.imported} table${s.imported === 1 ? '' : 's'}`;
  const skippedNote = s.skipped > 0 ? ` ${s.skipped} skipped (already existed).` : '';

  // Everything skipped and nothing imported → a plain informational message.
  if (s.imported === 0 && s.failed.length === 0 && s.skipped > 0) {
    api.ui.dialogs.toast(`Nothing imported — ${s.skipped} table(s) skipped (already existed).`, {
      kind: 'info',
      title: 'Datasette import',
    });
    return;
  }
  if (s.failed.length > 0) {
    api.ui.dialogs.toast(
      `Imported ${tables} (${rows});${skippedNote} ${s.failed.length} failed:\n${s.failed.join('\n')}`,
      { kind: 'error', title: 'Datasette import' },
    );
    return;
  }
  // Some tables loaded only partially (paging stopped early — e.g. rate
  // limiting). The rows that arrived ARE imported and shown; warn about the rest.
  if (s.partial.length > 0) {
    api.ui.dialogs.toast(
      `Imported ${tables} (${rows}).${skippedNote} ${s.partial.length} loaded partially ` +
        `(stopped early — the server may have rate-limited us): ${s.partial.join(', ')}. ` +
        `Use Refresh to fetch the rest.`,
      { kind: 'warning', title: 'Datasette import' },
    );
    return;
  }
  if (s.capped.length > 0) {
    api.ui.dialogs.toast(
      `Imported ${tables} (${rows}).${skippedNote} ${s.capped.length} capped at ${SETTINGS.maxImportRows} — ` +
        `more available: ${s.capped.join(', ')}.`,
      { kind: 'warning', title: 'Datasette import' },
    );
    return;
  }
  api.ui.dialogs.toast(`Imported ${tables} (${rows}) from Datasette.${skippedNote}`, {
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
  if (token) await api.store.settings.upsert({ key: tokenSettingKey(ref.base), value: token });

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
    created.push({ tableId, c });
  }
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
): Promise<string> {
  // Reuse an existing live table for the same (base, db, table) rather than
  // piling up duplicates on every reconnect (keeps geometry, sort, filters).
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
    name: `${c.db}/${c.table}`,
    code: slug(`${c.db}-${c.table}`),
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
    const msg =
      err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    api.ui.dialogs.toast(`Refresh failed: ${msg}`, { kind: 'error', title: 'Refresh' });
  }
}

/**
 * Re-fetch a snapshot table from its origin URL: replace the rows AND
 * re-discover the columns. The column set is reconciled with the user's current
 * arrangement — existing columns keep their order/hidden/width, deleted columns
 * stay gone, and genuinely-new columns are appended. If the table had NO columns
 * (a failed first import left an empty shell), refresh recreates them. When new
 * columns appear, the column editor opens so the user can arrange them. Drives
 * the window's progress bar for the duration, exactly like the initial import.
 */
async function refreshSnapshot(api: HostApi, t: Table): Promise<void> {
  const ref = parseDatasetteUrl(t.origin!.url);
  const fetchFn = (u: string) => api.backend.fetch(u);
  setTableLoading(t.id, true);
  let outcome: {
    rowCount: number;
    hasMore: boolean;
    truncated: boolean;
    error?: string | undefined;
  };
  let newFields: string[] = [];
  try {
    // Schema first (best-effort) — gives the progress-bar denominator and the
    // authoritative column names/types when the instance supports `?_extra=`.
    let metaColumns: ColumnSpec[] = [];
    let count: number | null = null;
    let typed = false;
    try {
      const meta = await fetchTableMeta(fetchFn, ref);
      metaColumns = meta.columns;
      count = meta.count;
      typed = meta.typed;
    } catch {
      /* fall back to row inference */
    }
    // Datasette.io omits `count` in schema responses; fetch it directly (cheap,
    // WAF-safe) so the refresh progress bar is proportional, not indeterminate.
    // Best-effort: fetchTableCount returns null (never throws) on failure.
    if (count == null) count = await fetchTableCount(fetchFn, ref);

    const target = count && count > 0 ? Math.min(count, SETTINGS.maxImportRows) : 0;
    const { rows, hasMore, truncated, error, nextUrl } = await fetchRows(fetchFn, ref, {
      maxRows: SETTINGS.maxImportRows,
      pageSize: SETTINGS.pageSize,
      onProgress: (n) => {
        if (target > 0) setTableLoading(t.id, true, Math.min(1, n / target));
      },
    });

    // Build the discovered columns (schema → rows → type refinement), then layer
    // on the Datasette metadata (descriptions, units, default sort, …).
    let cols =
      metaColumns.length === 0
        ? inferColumnsFromRows(rows)
        : typed
          ? metaColumns
          : refineColumnTypes(metaColumns, rows);
    let metaPatch: MetadataTablePatch = {};
    try {
      const md = await fetchTableMetadata(fetchFn, ref);
      const applied = applyTableMetadata(md, cols);
      cols = applied.columns;
      metaPatch = applied.patch;
    } catch {
      /* metadata is optional */
    }
    metaPatch = withDatasetteSourceInfo(metaPatch, ref.base, ref.db!, ref.table!);

    const isInitial = t.columns.length === 0;
    const merged = reconcileColumns(t.columns, cols, t.deletedColumns);
    newFields = merged.newFields;

    const now = Date.now();
    // Recreate the whole schema (with default sort/label) when the table had no
    // columns; otherwise keep the user's arrangement and just refresh the (i) info.
    // A partial (interrupted) refresh stores a resume cursor; a clean one clears it.
    const resume = resumeStateFor(error, nextUrl, rows.length, count);
    const patch = isInitial
      ? { columns: merged.columns, ...metaPatch, importResume: resume, updatedAt: now }
      : {
          columns: merged.columns,
          ...(metaPatch.info ? { info: metaPatch.info } : {}),
          importResume: resume,
          updatedAt: now,
        };
    await api.store.tables.patch(t.id, patch);

    const rowColl = api.store.rows(t.id);
    const old = await rowColl.find();
    await rowColl.bulkRemove(old.map((r) => r.id));
    await rowColl.bulkInsert(
      rows.map((data) => ({ id: cryptoUUID(), tableId: t.id, data, updatedAt: now })),
    );
    outcome = { rowCount: rows.length, hasMore, truncated, error };
  } finally {
    setTableLoading(t.id, false);
  }

  // A partial refresh (paging stopped early — e.g. rate limiting) still replaced
  // the rows with what loaded; note it rather than pretending it was complete.
  const parts: string[] = [];
  if (outcome.error) parts.push(`partial (${outcome.error})`);
  else if (outcome.hasMore || outcome.truncated) parts.push(`capped at ${SETTINGS.maxImportRows}`);
  if (newFields.length > 0)
    parts.push(`${newFields.length} new column${newFields.length === 1 ? '' : 's'}`);
  const note = parts.length ? ` — ${parts.join(', ')}` : '';
  api.ui.dialogs.toast(`Refreshed ${outcome.rowCount} rows from ${ref.db}/${ref.table}${note}.`, {
    kind: outcome.error || outcome.hasMore || outcome.truncated || newFields.length > 0
      ? 'warning'
      : 'success',
    title: 'Refresh',
  });

  // Surface columns we knew nothing about so the user can arrange / hide them.
  if (newFields.length > 0) openColumnEditorForNewColumns(t.id, ref, newFields);
}

/**
 * Resume an interrupted snapshot import from its persisted cursor: continue
 * paging from `importResume.nextUrl`, APPENDING the new rows to those already
 * imported, driving the progress bar over the combined total. If it reaches the
 * end, the resume marker is cleared (the red button disappears); if it's
 * interrupted again, the marker is updated so it can be resumed once more.
 */
async function resumeImport(api: HostApi, tableId: string): Promise<void> {
  const t = await api.store.tables.findOne(tableId);
  const resumeState = t?.importResume;
  if (!t || !t.origin?.url || !resumeState) return;
  const ref = parseDatasetteUrl(t.origin.url);
  const fetchFn = (u: string) => api.backend.fetch(u);
  const base = resumeState.loadedRows;
  const total = resumeState.totalCount ?? null;
  const target = total && total > 0 ? Math.min(total, SETTINGS.maxImportRows) : 0;

  setTableLoading(tableId, true, target > 0 ? Math.min(1, base / target) : undefined);
  let added = 0;
  let outcome: { error?: string | undefined; nextUrl?: string | undefined };
  try {
    const res = await fetchRows(fetchFn, ref, {
      startUrl: resumeState.nextUrl,
      // Keep the whole import within the cap: only pull up to the remaining room.
      maxRows: Math.max(0, SETTINGS.maxImportRows - base),
      pageSize: SETTINGS.pageSize,
      onProgress: (n) => {
        if (target > 0) setTableLoading(tableId, true, Math.min(1, (base + n) / target));
      },
    });
    added = res.rows.length;
    const now = Date.now();
    await api.store
      .rows(tableId)
      .bulkInsert(res.rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: now })));
    outcome = { error: res.error, nextUrl: res.nextUrl };
    // Update or clear the resume marker for the next round.
    const nextResume = resumeStateFor(res.error, res.nextUrl, base + added, total);
    await api.store.tables.patch(tableId, { importResume: nextResume, updatedAt: now });
  } catch (err) {
    // The resume cursor itself failed hard (still unreachable) — keep the marker
    // so the user can try again, and report why.
    const msg = err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
    api.ui.dialogs.toast(`Couldn't resume ${ref.db}/${ref.table}: ${msg}. Try again later.`, {
      kind: 'error',
      title: 'Resume import',
    });
    return;
  } finally {
    setTableLoading(tableId, false);
  }

  const totalNow = base + added;
  if (outcome.error) {
    api.ui.dialogs.toast(
      `Resumed ${ref.db}/${ref.table}: +${added} rows (${totalNow} total) — interrupted again (${outcome.error}). Resume to continue.`,
      { kind: 'warning', title: 'Resume import' },
    );
  } else {
    api.ui.dialogs.toast(
      `Finished ${ref.db}/${ref.table}: +${added} rows (${totalNow} total).`,
      { kind: 'success', title: 'Resume import' },
    );
  }
}

/** Open the column editor for a table, flagging the newly-discovered columns. */
function openColumnEditorForNewColumns(
  tableId: string,
  ref: DatasetteRef,
  newFields: string[],
): void {
  const list = newFields.join(', ');
  const many = newFields.length !== 1;
  const notice =
    `Refreshing ${ref.db}/${ref.table} revealed ${newFields.length} new ` +
    `column${many ? 's' : ''}: ${list}. Review, reorder or hide ${many ? 'them' : 'it'} here.`;
  document.dispatchEvent(
    new CustomEvent('easydb:edit-columns', { detail: { tableId, notice } }),
  );
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
