// packages/renderer/src/plugins/datasette-common.ts
//
// What the two Datasette plugins BOTH need.
//
// `datasette-source.ts` used to be one plugin doing two unrelated jobs:
// importing snapshot tables and connecting live read-write ones. Import and
// Connect are separate buttons, separate dialogs and separate processes, so
// they are now separate plugins — `datasette-import` and `datasette-connect`.
// This module holds the handful of helpers that genuinely serve both, so
// neither plugin has to import the other.
//
// The wire protocol lives in `datasette-client.ts`; this is the layer above it.

import type { DatasetteRef, FetchFn, MetadataTablePatch, TableRef } from './datasette-client.js';
import { fetchDatabaseNames, fetchTablesForDb, probeSingleTable } from './datasette-client.js';
import { chooseTables } from '../dialogs/table-select-dialog.js';
import type { HostApi, TableInfo } from '@easydb/shared';

// One definition, in the module that owns the wire protocol.
export type { FetchFn } from './datasette-client.js';

/** Instance base without its scheme, for messages the user reads. */
export const host = (base: string): string => base.replace(/^https?:\/\//, '');

// -- Settings ---------------------------------------------------------------
//
// One shared "Datasette" settings tab for both `datasette-import` and
// `datasette-connect` — same pluginId, same keys, so either plugin's `init`
// can register it and both read the same resolved values.

/** Shared settings-tab id for both Datasette plugins. */
export const DATASETTE_SETTINGS_ID = 'datasette';

export const DEFAULT_MAX_IMPORT_ROWS = 10_000; // safety cap on a single table's import; 0 = unlimited
export const DEFAULT_PAGE_SIZE = 1000; // _size per page hop (fixed size for uniform cursor paging)
export const DEFAULT_CONNECT_MAX_ROWS = 10_000; // row cap for a single live-connected table's materialisation
export const DEFAULT_RETRY_WAIT_SECONDS = 60; // wait before auto-resuming a rate-limited import

export interface DatasetteSettings {
  /** Max rows imported per table. 0 = unlimited — see {@link importRowCap}. */
  maxImportRows: number;
  /** Rows requested per page hop; the instance clamps this to its own max_returned_rows. */
  pageSize: number;
  /** Row cap for a single live connected table's materialisation. */
  connectMaxRows: number;
  /** Wait (seconds) before auto-resuming an import paused by rate limiting. */
  retryWaitSeconds: number;
}

/**
 * Register the one shared "Datasette" settings tab. Both plugins call this
 * from `init` — `registerSettings` just overwrites the same map entry
 * (keyed by pluginId) with identical field specs, so calling it twice is a
 * harmless no-op either way, regardless of load order.
 */
export function registerDatasetteSettings(api: HostApi): void {
  api.ui.registerSettings(DATASETTE_SETTINGS_ID, 'Datasette', [
    {
      key: 'maxImportRows',
      label: 'Max import rows per table',
      type: 'number',
      default: DEFAULT_MAX_IMPORT_ROWS,
      scope: 'workspace',
      description: 'Max rows imported per table. 0 = unlimited.',
    },
    {
      key: 'pageSize',
      label: 'Page size',
      type: 'number',
      default: DEFAULT_PAGE_SIZE,
      scope: 'workspace',
      description: 'Rows requested per page hop while paging a table (the instance clamps this to its own max_returned_rows).',
    },
    {
      key: 'connectMaxRows',
      label: 'Connected table row cap',
      type: 'number',
      default: DEFAULT_CONNECT_MAX_ROWS,
      scope: 'workspace',
      description: 'Row cap for a single live connected table.',
    },
    {
      key: 'retryWaitSeconds',
      label: 'Rate-limit retry wait (seconds)',
      type: 'number',
      default: DEFAULT_RETRY_WAIT_SECONDS,
      scope: 'workspace',
      description: "Wait before resuming an import paused by the instance's rate limiting.",
    },
  ]);
}

/** `v` coerced to a finite integer `>= min`; `fallback` otherwise. */
function validatedNumber(v: unknown, fallback: number, min: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Resolve the four Datasette settings, validating each against the
 * registered defaults — a missing, non-numeric, or out-of-range stored value
 * falls back to the default rather than propagating NaN/negative values into
 * the paging math.
 */
export async function getDatasetteSettings(api: HostApi): Promise<DatasetteSettings> {
  const [maxImportRows, pageSize, connectMaxRows, retryWaitSeconds] = await Promise.all([
    api.settings.get<number>(DATASETTE_SETTINGS_ID, 'maxImportRows'),
    api.settings.get<number>(DATASETTE_SETTINGS_ID, 'pageSize'),
    api.settings.get<number>(DATASETTE_SETTINGS_ID, 'connectMaxRows'),
    api.settings.get<number>(DATASETTE_SETTINGS_ID, 'retryWaitSeconds'),
  ]);
  return {
    maxImportRows: validatedNumber(maxImportRows, DEFAULT_MAX_IMPORT_ROWS, 0),
    pageSize: validatedNumber(pageSize, DEFAULT_PAGE_SIZE, 1),
    connectMaxRows: validatedNumber(connectMaxRows, DEFAULT_CONNECT_MAX_ROWS, 1),
    retryWaitSeconds: validatedNumber(retryWaitSeconds, DEFAULT_RETRY_WAIT_SECONDS, 1),
  };
}

/**
 * Internal-arithmetic form of `maxImportRows`: 0 (unlimited) becomes a cap
 * large enough that `rowCap - fetched` in the paging loop never goes negative
 * before the instance itself runs out of rows.
 */
export function importRowCap(maxImportRows: number): number {
  return maxImportRows === 0 ? Number.MAX_SAFE_INTEGER : maxImportRows;
}

/** Human-facing Datasette table URL (`base/db/table`). */
export function datasetteTableUrl(base: string, db: string, table: string): string {
  return `${base}/${encodeURIComponent(db)}/${encodeURIComponent(table)}`;
}

/**
 * Ensure a Datasette table's metadata patch carries a `TableInfo` with at least
 * its source URL, so the titlebar (i) info button ALWAYS appears for a
 * Datasette-backed table — even when the instance publishes no description or
 * license (datasette.io, for one, publishes none). A real `source`/`sourceUrl`
 * supplied by the instance is left untouched.
 */
export function withDatasetteSourceInfo(patch: MetadataTablePatch, base: string, db: string, table: string): MetadataTablePatch {
  const info: TableInfo = { ...(patch.info ?? {}) };
  if (!info.source && !info.sourceUrl) {
    info.source = `${host(base)}/${db}/${table}`;
    info.sourceUrl = datasetteTableUrl(base, db, table);
  }
  return { ...patch, info };
}

// Datasette used to have its own `name (2)` rule. There is one workspace-wide
// policy now — the store applies it to every write — so both plugins read it
// from there and no longer produce a differently-shaped name than an import does.
export { uniqueTableName } from '../util/table-names.js';

/**
 * Resolve the tables the user wants to act on from a Datasette URL:
 *  - table URL      → that one table (no picker);
 *  - database URL   → its tables, via the table checklist;
 *  - instance URL   → pick database(s) first, then their tables.
 * Returns the chosen tables, [] if none exist, or null if cancelled.
 */
export async function resolveChosenTables(fetchFn: FetchFn, ref: DatasetteRef, verb: 'Import' | 'Connect' | 'Reference', opts: { skipPicker?: boolean | undefined } = {}): Promise<TableRef[] | null> {
  if (ref.db && ref.table) {
    // Probe the named table so a missing/typo'd table surfaces as an error
    // BEFORE any window/record is created (otherwise connect silently makes an
    // empty local table). Throws DatasetteError on 404 → connectDatasette wraps
    // it and openConnectDialog shows the alert. Bonus: real pks/count so
    // upsertLiveTable skips its own pk probe.
    return [await probeSingleTable(fetchFn, ref)];
  }

  const tables: TableRef[] = [];
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
