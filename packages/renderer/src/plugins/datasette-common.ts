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

import type { DatasetteRef, MetadataTablePatch, TableRef } from './datasette-client.js';
import { fetchDatabaseNames, fetchTablesForDb, probeSingleTable } from './datasette-client.js';
import { chooseTables } from '../dialogs/table-select-dialog.js';
import type { TableInfo } from '@easydb/shared';

export type FetchFn = (url: string, opts?: unknown) => Promise<Response>;

/** Instance base without its scheme, for messages the user reads. */
export const host = (base: string): string => base.replace(/^https?:\/\//, '');

export const SETTINGS = {
  maxImportRows: 10_000, // safety cap on a single table's import
  pageSize: 1000, // _size per page hop (fixed size for uniform cursor paging)
};

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
export function withDatasetteSourceInfo(
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

/** First "name", "name (2)", "name (3)"… not already used by a table in the set. */
export function uniqueTableName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Resolve the tables the user wants to act on from a Datasette URL:
 *  - table URL      → that one table (no picker);
 *  - database URL   → its tables, via the table checklist;
 *  - instance URL   → pick database(s) first, then their tables.
 * Returns the chosen tables, [] if none exist, or null if cancelled.
 */
export async function resolveChosenTables(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  verb: 'Import' | 'Connect',
  opts: { skipPicker?: boolean | undefined } = {},
): Promise<TableRef[] | null> {
  if (ref.db && ref.table) {
    // Probe the named table so a missing/typo'd table surfaces as an error
    // BEFORE any window/record is created (otherwise connect silently makes an
    // empty local table). Throws DatasetteError on 404 → connectDatasette wraps
    // it and openConnectDialog shows the alert. Bonus: real pks/count so
    // upsertLiveTable skips its own pk probe.
    return [await probeSingleTable(fetchFn, ref)];
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
