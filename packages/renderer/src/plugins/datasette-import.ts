// packages/renderer/src/plugins/datasette-import.ts
//
// easyDBAccess built-in plugin — IMPORT snapshot tables from any online
// Datasette instance. A URL may point at:
//   - a single table      (.../<db>/<table>)  → imported directly;
//   - a whole database     (.../<db>)          → pick tables from a checklist;
//   - an entire instance   (https://host)      → pick tables across all databases.
//
// What lands is a plain local table you own: rows are stored, synced and
// editable, and Refresh re-fetches them. That is the opposite of
// `datasette-connect.ts`, which points a window at somebody else's live table
// and stores nothing. Import and Connect are separate buttons, separate dialogs
// and separate processes — see .claude/plans/2026-07-28-importer-architecture.md.
//
// Registers a URL source and a (table-only) drop handler. Not yet on the import
// kernel: it still owns its paging, its interactive rate-limit resume and its
// per-window progress bar, none of which the kernel can express yet (phase F).

import type { ColumnSpec, HostApi, ImportResume, PluginModule, Row, Table } from '@easydb/shared';
import { reconcileColumns, rowRekeyer } from '../table/column-merge.js';
import { mergeRefreshedRows } from '../table/refresh-merge.js';
import { setTableLoading } from '../table/data-table.js';
import {
  applyPrimaryKeyFlags,
  applyTableMetadata,
  DatasetteError,
  fetchRows,
  fetchTableCount,
  fetchTableMeta,
  fetchTableMetadata,
  inferColumnsFromRows,
  parseDatasetteUrl,
  refineColumnTypes,
  type DatasetteRef,
  type MetadataTablePatch,
} from './datasette-client.js';
import { askViewImportMode, findViews, offerViewImport, runViewImport } from './datasette-views.js';
import { type DatasetteSettings, getDatasetteSettings, importRowCap, registerDatasetteSettings, resolveChosenTables, uniqueTableName, withDatasetteSourceInfo } from './datasette-common.js';
import { cryptoUUID, slugTable } from '../util/ids.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before auto-resuming a rate-limited import — the settings
 * tab's `retryWaitSeconds` (60s by default), matching the "resume delayed"
 * prompt. A test seam (`window.__eda_resumeDelayMs`) overrides it so e2e
 * doesn't stall a real minute.
 */
function resumeDelayMs(retryWaitSeconds: number): number {
  const o = (globalThis as { __eda_resumeDelayMs?: number }).__eda_resumeDelayMs;
  return typeof o === 'number' && o >= 0 ? o : retryWaitSeconds * 1000;
}

/**
 * The resume state to persist after a fetch. Only an INTERRUPTION (an `error`
 * with a resume cursor) is resumable — the deliberate row cap is not. Returns
 * `undefined` for a clean/complete fetch, which clears any prior resume marker.
 */
function resumeStateFor(error: string | undefined, nextUrl: string | undefined, loadedRows: number, count: number | null): ImportResume | undefined {
  if (!error || !nextUrl) return undefined;
  return { nextUrl, loadedRows, ...(count != null ? { totalCount: count } : {}) };
}

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'datasette-import',
  name: 'Datasette Import',
  type: 'importer',
  version: '0.3.0',
  description: 'Import snapshot tables from any online Datasette instance, database, or single table by URL',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/datasette-import.ts',
};

const EXAMPLE = 'https://latest.datasette.io/fixtures/facetable';

export function init(api: HostApi): void {
  registerDatasetteSettings(api);

  // Refresh for imported SNAPSHOTS only. A live connected table has its own
  // Refresh in `datasette-connect`, which re-reads a cache rather than
  // re-fetching and merging — different operations, so different buttons. The
  // predicates are mutually exclusive, so no table shows both.
  api.ui.registerTableButton({
    id: 'datasette:refresh-snapshot',
    label: 'Refresh',
    icon: 'refresh',
    tooltip: 'Re-fetch this snapshot from the Datasette table it came from',
    visible: (table) => table.origin?.type === 'datasette' && table.source?.type !== 'datasette',
    onClick: (a, { tableId }) => refreshSnapshotTable(a, tableId),
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

  api.ui.registerUrlSource({
    id: 'datasette',
    label: 'Datasette (table or instance)…',
    async run(api, { url }) {
      const input = url || (await api.ui.dialogs.prompt(`Datasette URL — a single table, a database, or an instance root.\n\ne.g. ${EXAMPLE}`, '', 'Import from Datasette'));
      if (!input) return;
      await runImport(api, input);
    },
  });

  // Views on their own — as live projections over tables already imported, or
  // as snapshot tables of their own.
  api.ui.registerUrlSource({
    id: 'datasette-views',
    label: 'Datasette views…',
    async run(api, { url }) {
      const input =
        url ||
        (await api.ui.dialogs.prompt(
          `Datasette database URL — its SQL views can come in as live Projections over the tables you already imported, or as snapshot tables.\n\ne.g. ${EXAMPLE}`,
          '',
          'Import Datasette views',
        ));
      if (!input) return;
      try {
        const views = await findViews(api, input);
        if (!views || views.length === 0) {
          await api.ui.dialogs.alert('That Datasette database defines no views.', 'Datasette views');
          return;
        }
        const mode = await askViewImportMode(api, views, 'This database defines');
        if (!mode) return;
        await runViewImport(api, parseDatasetteUrl(input).base, views, mode, (urls) => importViewsAsTables(api, urls, {}));
      } catch (err) {
        await api.ui.dialogs.alert((err as Error)?.message ?? String(err), 'Datasette views');
      }
    },
  });

  api.ui.registerDropHandler(async (event, api) => {
    const text = event.dataTransfer?.getData('text/plain') || '';
    if (!isDatasetteTableUrl(text)) return false;
    event.preventDefault();
    // A dropped TABLE url is a request for that one table; asking about the
    // database's views on top of it would be a non-sequitur.
    await runImport(api, text, { skipViews: true });
    return true;
  });
}

async function runImport(api: HostApi, input: string, opts: DatasetteImportOpts = {}): Promise<void> {
  try {
    await importDatasette(api, input, opts);
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

/** The common Import-dialog options this importer honours. */
export interface DatasetteImportOpts {
  /** The user already picked a database, so skip the table checklist. */
  skipTablePicker?: boolean | undefined;
  /**
   * Don't offer to import the database's views afterwards. For callers that
   * are importing one specific table and would find the question a non-sequitur
   * (a dropped table URL, a refresh).
   */
  skipViews?: boolean | undefined;
  /**
   * The dialog's "Limit rows" value, applied PER TABLE. Always further capped
   * by the "Datasette" settings tab's `maxImportRows` (0 there = unlimited, so
   * the dialog's value then wins as-is). Undefined ⇒ that setting alone applies.
   */
  maxRows?: number | undefined;
  /**
   * The dialog's "Edit columns before import" hook. Called once per table with
   * the discovered schema and the table's name, after the rows are fetched but
   * before anything is written. Return the edited columns, or `null` to leave
   * that table empty. Only for a table being populated for the FIRST time — a
   * re-import keeps the arrangement the user already has.
   */
  editColumns?: ((columns: ColumnSpec[], tableName: string) => Promise<ColumnSpec[] | null>) | undefined;
}

/**
 * Smart entry point. Resolves a Datasette URL to one or many tables and imports
 * them. A single-table URL imports straight away; a database/instance URL
 * discovers its tables and opens a checklist (all pre-selected) so the user
 * chooses what to pull in.
 */
export async function importDatasette(api: HostApi, input: string, opts: DatasetteImportOpts = {}): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-source: no active workspace');

  const settings = await getDatasetteSettings(api);
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
      const r = await fillImportTable(api, p.tableId, p.ref, p.overwrite, p.knownCount, opts, settings);
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

  // The dialog's "Limit rows" narrows the batch's cap the same way it does per
  // table in fillImportTable — mirrored here only for the "capped at N" wording.
  const settingCap = importRowCap(settings.maxImportRows);
  const effectiveCap = opts.maxRows != null ? Math.min(opts.maxRows, settingCap) : settingCap;

  summariseBatch(api, {
    imported,
    skipped,
    totalRows,
    capped,
    cap: effectiveCap,
    partial,
    failed,
    requested: chosen.length,
  });

  // A database's VIEWS are queries over the tables just imported, so this is
  // the only moment they can be resolved. Offered, never automatic, and never
  // allowed to turn a successful table import into a failure.
  if (imported > 0 && !opts.skipViews) {
    try {
      await offerViewImport(api, input, (urls) => importViewsAsTables(api, urls, opts));
    } catch {
      /* the tables landed; an optional extra must not report as a failure */
    }
  }
}

/**
 * Import each view URL as an ordinary snapshot table.
 *
 * Datasette serves a view exactly like a table, so this is just the normal
 * table import pointed at the view's endpoint — it gets the same paging,
 * progress bar, collision prompt and row cap. `skipViews` stops the recursion:
 * these ARE the views.
 */
async function importViewsAsTables(api: HostApi, urls: string[], opts: DatasetteImportOpts): Promise<void> {
  for (const url of urls) {
    // Each URL names ONE view, so the table picker never appears anyway; what
    // matters is `skipViews`, which stops the recursion — these ARE the views.
    await importDatasette(api, url, { ...opts, skipViews: true });
  }
}

/**
 * Phase 1 of an import: resolve a name collision (Overwrite / Rename / Skip) and
 * create the destination table as an EMPTY shell so its window appears right
 * away. No rows are fetched here. Returns the target table id, or `skipped`.
 */
async function prepareImportTable(api: HostApi, workspaceId: string, ref: DatasetteRef): Promise<{ tableId: string; overwrite: boolean; skipped?: boolean }> {
  const name = `${ref.db}/${ref.table}`;
  const origin = {
    type: 'datasette',
    url: `${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}`,
  } as const;

  const workspaceTables = (await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId);
  const existing = workspaceTables.find((t) => t.name.toLowerCase() === name.toLowerCase());
  let targetName = name;
  if (existing) {
    const choice = await api.ui.dialogs.choice(`A table named "${name}" already exists in this workspace.`, ['Overwrite', 'Rename', 'Skip'], 'Import — table already exists');
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
    code: slugTable(`${ref.db}-${ref.table}`),
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
  knownCount: number | null,
  opts: DatasetteImportOpts,
  settings: DatasetteSettings,
): Promise<OneResult> {
  const name = `${ref.db}/${ref.table}`;
  const fetchFn = (u: string) => api.backend.fetch(u);
  // The dialog's "Limit rows" narrows the import; the setting is the hard
  // ceiling, so the smaller of the two wins. An unlimited setting (0) never
  // narrows — the dialog's own value then wins as-is.
  const settingCap = importRowCap(settings.maxImportRows);
  const rowCap = opts.maxRows != null ? Math.min(opts.maxRows, settingCap) : settingCap;
  setTableLoading(tableId, true);
  try {
    // Schema discovery via ?_extra=… is best-effort: older instances give no
    // columns (inferred from rows below); a hard failure is tolerated too — the
    // row fetch surfaces any real problem.
    let metaColumns: ColumnSpec[] = [];
    let count: number | null = knownCount;
    let countTruncated = false;
    let typed = false;
    let pks: string[] = [];
    try {
      const meta = await fetchTableMeta(fetchFn, ref);
      metaColumns = meta.columns;
      if (count == null) {
        count = meta.count;
        countTruncated = meta.countTruncated;
      }
      typed = meta.typed;
      pks = meta.pks ?? [];
    } catch {
      // fall back to row inference
    }
    // Datasette.io's schema responses omit `count`, so a single-table import had
    // no denominator and only ever showed the indeterminate bar. Fetch the count
    // directly (cheap `?_extra=count`, WAF-safe) so the bar is proportional.
    // Best-effort: fetchTableCount never throws — count stays null on failure.
    if (count == null) {
      const c = await fetchTableCount(fetchFn, ref);
      count = c.count;
      countTruncated = c.truncated;
    }

    // The row count gives a denominator for a proportional progress bar; without
    // it the bar stays indeterminate. Cap the denominator at the import limit so
    // the fraction reflects what we'll actually pull — UNLESS the count itself
    // is a floor (`countTruncated`) and the cap exceeds it: then we genuinely
    // don't know when we'll finish, so a determinate bar would falsely read
    // 100% the moment we cross that floor. Fall back to indeterminate instead.
    const target = count && count > 0 && (!countTruncated || rowCap <= count) ? Math.min(count, rowCap) : 0;

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
        maxRows: Math.max(0, rowCap - rows.length),
        pageSize: settings.pageSize,
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
      if (!seg.error || !seg.nextUrl || rows.length >= rowCap) break;

      const waitLabel = `${settings.retryWaitSeconds}s`;
      const choice = await api.ui.dialogs.choice(
        `Import of "${name}" paused after ${rows.length.toLocaleString()} rows (${seg.error}). ` +
          `Datasette may be rate-limiting a large import. Wait ${waitLabel} and resume from ` +
          `where it stopped, or cancel and keep the rows imported so far (you can resume ` +
          `later from the table's footer)?`,
        [`Resume in ${waitLabel}`, 'Cancel'],
        'Import paused — rate limited?',
      );
      // Cancel / dismiss → keep the partial; the importResume marker persisted
      // below drives the footer's manual resume button.
      if (choice !== `Resume in ${waitLabel}`) break;

      // Indeterminate bar + a heads-up toast during the wait, then resume.
      setTableLoading(tableId, true);
      api.ui.dialogs.toast(`Resuming "${name}" in ${waitLabel}…`, {
        kind: 'info',
        title: 'Import paused',
      });
      await delay(resumeDelayMs(settings.retryWaitSeconds));
      startUrl = seg.nextUrl;
      error = undefined; // re-set if the resumed segment fails again
      nextUrl = undefined;
    }

    // Prefer the schema's columns; infer from rows if none; refine types when
    // only bare names came back (e.g. datasette.io's `?_extra=columns`).
    const discovered = metaColumns.length === 0 ? inferColumnsFromRows(rows) : typed ? metaColumns : refineColumnTypes(metaColumns, rows);
    // Carry the remote primary key across as a real constraint. Columns inferred
    // from rows know nothing about keys, so this is where a snapshot of a
    // `column_details`-less instance gets its pk marked unique + not-null.
    const columns = applyPrimaryKeyFlags(discovered, pks);

    // Apply the table's Datasette metadata (column descriptions, units, the
    // sortable-columns allowlist, default sort, …) onto columns + table fields.
    // Best-effort: an instance serving no metadata ⇒ no-op.
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
    let { columns: mergedCols } = reconcileColumns(existingCols, cols, current?.deletedColumns);

    // "Edit columns before import": review/rename the discovered schema before
    // it is written. Only on the FIRST population — a re-import must keep the
    // arrangement the user already has. Renaming rekeys the fetched rows to
    // match. Cancelling leaves the table as an empty shell rather than
    // aborting a whole batch of tables.
    let importRows = rows;
    if (opts.editColumns && isInitial) {
      const edited = await opts.editColumns(mergedCols, name);
      if (edited === null) {
        return { name, rowCount: 0, hasMore: false, truncated: false, pages, count, error };
      }
      importRows = remapRowKeys(importRows, mergedCols, edited);
      mergedCols = edited;
    }

    const now = Date.now();
    api.events.emit('import:before', { source: 'datasette', tableId });
    // Initial population applies the full metadata (default sort, label, info);
    // a re-import only refreshes the (i) info so the user's sort/label survive.
    // An interruption stores a resume cursor (footer shows a red resume button);
    // a clean import clears any prior one.
    const resume = resumeStateFor(error, nextUrl, rows.length, count);
    // Remember the remote primary key(s) on the snapshot's origin so a later
    // refresh can match rows and preserve user-added columns (see refreshSnapshot).
    const originPatch = pks.length > 0 && current?.origin ? { origin: { ...current.origin, pks } } : {};
    const patch = isInitial
      ? { columns: mergedCols, ...metaPatch, ...originPatch, importResume: resume, updatedAt: now }
      : {
          columns: mergedCols,
          ...(metaPatch.info ? { info: metaPatch.info } : {}),
          ...originPatch,
          importResume: resume,
          updatedAt: now,
        };
    await api.store.tables.patch(tableId, patch);

    const rowColl = api.store.rows(tableId);
    if (overwrite) {
      const old = await rowColl.find();
      await rowColl.bulkRemove(old.map((r) => r.id));
    }
    const docs: Row[] = importRows.map((data) => ({
      id: cryptoUUID(),
      tableId,
      data,
      updatedAt: now,
    }));
    await rowColl.bulkInsert(docs);

    api.events.emit('import:after', { source: 'datasette', tableId, rowCount: docs.length });
    return { name, rowCount: docs.length, hasMore, truncated, pages, count, error };
  } finally {
    setTableLoading(tableId, false);
  }
}

/**
 * Apply a pre-import column rename to the fetched rows.
 *
 * Renaming a Datasette column detaches it from the remote name, so a later
 * Refresh sees the remote column as new and re-adds it. That is the user's
 * choice to make — hiding a column has no such effect.
 */
function remapRowKeys(rows: Array<Record<string, unknown>>, oldCols: ColumnSpec[], newCols: ColumnSpec[]): Array<Record<string, unknown>> {
  const rekey = rowRekeyer(oldCols, newCols);
  return rekey ? rows.map(rekey) : rows;
}

function summariseBatch(
  api: HostApi,
  s: {
    imported: number;
    skipped: number;
    totalRows: number;
    capped: string[];
    /** The effective per-table row cap that produced `capped`, for the message below. */
    cap: number;
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
    api.ui.dialogs.toast(`Imported ${tables} (${rows});${skippedNote} ${s.failed.length} failed:\n${s.failed.join('\n')}`, { kind: 'error', title: 'Datasette import' });
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
    // An unlimited setting (cap === MAX_SAFE_INTEGER) still hits Datasette's own
    // truncation sometimes — show that as "capped", just without a silly number.
    const capNote = s.cap < Number.MAX_SAFE_INTEGER ? ` at ${s.cap.toLocaleString()}` : '';
    api.ui.dialogs.toast(`Imported ${tables} (${rows}).${skippedNote} ${s.capped.length} capped${capNote} — ` + `more available: ${s.capped.join(', ')}.`, {
      kind: 'warning',
      title: 'Datasette import',
    });
    return;
  }
  api.ui.dialogs.toast(`Imported ${tables} (${rows}) from Datasette.${skippedNote}`, {
    kind: 'success',
    title: 'Datasette import',
  });
}

/**
 * The Refresh button's entry point for an imported snapshot. Live connected
 * tables are `datasette-connect`'s business — this used to be one function
 * branching on `source` vs `origin`, which is exactly the conflation the split
 * removes.
 */
async function refreshSnapshotTable(api: HostApi, tableId: string): Promise<void> {
  const t = await api.store.tables.findOne(tableId);
  if (!t?.origin?.url || t.origin.type !== 'datasette') return;
  try {
    const settings = await getDatasetteSettings(api);
    await refreshSnapshot(api, t, settings);
  } catch (err) {
    const msg = err instanceof DatasetteError ? err.message : ((err as Error)?.message ?? String(err));
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
async function refreshSnapshot(api: HostApi, t: Table, settings: DatasetteSettings): Promise<void> {
  const ref = parseDatasetteUrl(t.origin!.url);
  const fetchFn = (u: string) => api.backend.fetch(u);
  const rowCap = importRowCap(settings.maxImportRows);
  setTableLoading(t.id, true);
  let outcome: {
    rowCount: number;
    hasMore: boolean;
    truncated: boolean;
    error?: string | undefined;
    /** Rows whose user-added values could not be carried across the refresh. */
    droppedUserRows: number;
  };
  // Assigned inside the try below, like `outcome`. No initializer: this block has
  // a `finally` and no `catch`, so the code that reads these only runs when the
  // try completed — an initial value would never be read.
  let newFields: string[];
  try {
    // Schema first (best-effort) — gives the progress-bar denominator and the
    // authoritative column names/types when the instance supports `?_extra=`.
    let metaColumns: ColumnSpec[] = [];
    let count: number | null = null;
    let countTruncated = false;
    let typed = false;
    let metaPks: string[] = [];
    try {
      const meta = await fetchTableMeta(fetchFn, ref);
      metaColumns = meta.columns;
      count = meta.count;
      countTruncated = meta.countTruncated;
      typed = meta.typed;
      metaPks = meta.pks ?? [];
    } catch {
      /* fall back to row inference */
    }
    // Datasette.io omits `count` in schema responses; fetch it directly (cheap,
    // WAF-safe) so the refresh progress bar is proportional, not indeterminate.
    // Best-effort: fetchTableCount never throws — count stays null on failure.
    if (count == null) {
      const c = await fetchTableCount(fetchFn, ref);
      count = c.count;
      countTruncated = c.truncated;
    }

    // See the matching comment in fillImportTable: a truncated count is only a
    // trustworthy denominator when the cap is at or below it.
    const target = count && count > 0 && (!countTruncated || rowCap <= count) ? Math.min(count, rowCap) : 0;
    const { rows, hasMore, truncated, error, nextUrl } = await fetchRows(fetchFn, ref, {
      maxRows: rowCap,
      pageSize: settings.pageSize,
      onProgress: (n) => {
        if (target > 0) setTableLoading(t.id, true, Math.min(1, n / target));
      },
    });

    // The remote key: freshly discovered when the instance will tell us, else
    // whatever the original import recorded. Drives both the pk constraint on
    // the columns and the row matching further down.
    const pks = metaPks.length > 0 ? metaPks : (t.origin?.pks ?? []);

    // Build the discovered columns (schema → rows → type refinement → pk
    // constraint), then layer on the Datasette metadata (descriptions, units,
    // the sortable-columns allowlist, default sort, …).
    let cols = applyPrimaryKeyFlags(metaColumns.length === 0 ? inferColumnsFromRows(rows) : typed ? metaColumns : refineColumnTypes(metaColumns, rows), pks);
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

    // Merge the freshly-fetched remote rows with the current local rows: remote
    // columns are clobbered with fresh values, but columns the USER added locally
    // (not part of the remote schema, and not a primary key) are carried over by
    // matching on the remote primary key. Locally-deleted rows return (they're in
    // the fresh set); data for user-deleted remote columns is dropped. With no
    // known pks this falls back to a plain replace (no per-row preservation).
    const remoteFields = new Set(cols.map((c) => c.field));
    const userAddedFields = t.columns.map((c) => c.field).filter((f) => !remoteFields.has(f) && !pks.includes(f));
    const deletedRemoteFields = (t.deletedColumns ?? []).filter((f) => remoteFields.has(f));
    const rowColl = api.store.rows(t.id);
    const old = await rowColl.find();
    const { data: mergedData, droppedUserRows } = mergeRefreshedRows({
      oldRows: old.map((r) => ({ data: r.data })),
      freshRows: rows,
      pks,
      userAddedFields,
      deletedRemoteFields,
    });
    await rowColl.bulkRemove(old.map((r) => r.id));
    await rowColl.bulkInsert(mergedData.map((data) => ({ id: cryptoUUID(), tableId: t.id, data, updatedAt: now })));
    outcome = { rowCount: mergedData.length, hasMore, truncated, error, droppedUserRows };
  } finally {
    setTableLoading(t.id, false);
  }

  // A partial refresh (paging stopped early — e.g. rate limiting) still replaced
  // the rows with what loaded; note it rather than pretending it was complete.
  const parts: string[] = [];
  if (outcome.error) parts.push(`partial (${outcome.error})`);
  else if (outcome.hasMore || outcome.truncated) {
    const capNote = rowCap < Number.MAX_SAFE_INTEGER ? ` at ${rowCap.toLocaleString()}` : '';
    parts.push(`capped${capNote}`);
  }
  if (newFields.length > 0) parts.push(`${newFields.length} new column${newFields.length === 1 ? '' : 's'}`);
  // A view (or any table Datasette reports no pk for) is matched on content, so
  // a row whose remote values changed loses the user's own column values. Say so.
  if (outcome.droppedUserRows > 0) {
    parts.push(
      `${outcome.droppedUserRows} row${outcome.droppedUserRows === 1 ? '' : 's'} changed at the source, ` +
        `so your own column values for ${outcome.droppedUserRows === 1 ? 'it' : 'them'} could not be carried over`,
    );
  }
  const note = parts.length ? ` — ${parts.join(', ')}` : '';
  api.ui.dialogs.toast(`Refreshed ${outcome.rowCount} rows from ${ref.db}/${ref.table}${note}.`, {
    kind: outcome.error || outcome.hasMore || outcome.truncated || newFields.length > 0 || outcome.droppedUserRows > 0 ? 'warning' : 'success',
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
  const settings = await getDatasetteSettings(api);
  const rowCap = importRowCap(settings.maxImportRows);
  const ref = parseDatasetteUrl(t.origin.url);
  const fetchFn = (u: string) => api.backend.fetch(u);
  const base = resumeState.loadedRows;
  // `ImportResume` doesn't persist whether `totalCount` was itself a truncated
  // floor (see the countTruncated handling in fillImportTable) — a resumed
  // import's bar can't distinguish that case and stays determinate.
  const total = resumeState.totalCount ?? null;
  const target = total && total > 0 ? Math.min(total, rowCap) : 0;

  setTableLoading(tableId, true, target > 0 ? Math.min(1, base / target) : undefined);
  let added: number;
  let outcome: { error?: string | undefined; nextUrl?: string | undefined };
  try {
    const res = await fetchRows(fetchFn, ref, {
      startUrl: resumeState.nextUrl,
      // Keep the whole import within the cap: only pull up to the remaining room.
      maxRows: Math.max(0, rowCap - base),
      pageSize: settings.pageSize,
      onProgress: (n) => {
        if (target > 0) setTableLoading(tableId, true, Math.min(1, (base + n) / target));
      },
    });
    added = res.rows.length;
    const now = Date.now();
    await api.store.rows(tableId).bulkInsert(res.rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: now })));
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
    api.ui.dialogs.toast(`Resumed ${ref.db}/${ref.table}: +${added} rows (${totalNow} total) — interrupted again (${outcome.error}). Resume to continue.`, { kind: 'warning', title: 'Resume import' });
  } else {
    api.ui.dialogs.toast(`Finished ${ref.db}/${ref.table}: +${added} rows (${totalNow} total).`, {
      kind: 'success',
      title: 'Resume import',
    });
  }
}

/** Open the column editor for a table, flagging the newly-discovered columns. */
function openColumnEditorForNewColumns(tableId: string, ref: DatasetteRef, newFields: string[]): void {
  const list = newFields.join(', ');
  const many = newFields.length !== 1;
  const notice = `Refreshing ${ref.db}/${ref.table} revealed ${newFields.length} new ` + `column${many ? 's' : ''}: ${list}. Review, reorder or hide ${many ? 'them' : 'it'} here.`;
  document.dispatchEvent(new CustomEvent('easydb:edit-columns', { detail: { tableId, notice } }));
}
