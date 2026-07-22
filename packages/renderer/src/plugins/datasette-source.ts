// packages/renderer/src/plugins/datasette-source.ts
//
// easyDBAccess built-in plugin — Phase 1: import a table from any online Datasette
// instance by URL as a local eda table (read-only snapshot). Registers a URL source
// and a drop handler. The Phase-2 live read-write connector builds on the same
// datasette-client core.
//
// Wire-up: add `import * as datasetteSource from '../plugins/datasette-source.js';`
// and include `datasetteSource` in the `builtins` array in
// packages/renderer/src/plugin-host/loader.ts.

import type { HostApi, PluginModule, Row } from '@easydb/shared';
import {
  parseDatasetteUrl,
  fetchTableMeta,
  fetchRows,
  extractTableNames,
  inferColumnsFromRows,
  DatasetteError,
  type DatasetteRef,
} from './datasette-client.js';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'datasette-source',
  version: '0.1.0',
  description: 'Import a table from any online Datasette instance by URL',
  author: 'easyDBAccess built-ins',
  optional: true,
};

const SETTINGS = {
  maxImportRows: 10_000, // safety cap on a single import
  pageSize: 'max' as const, // _size per page hop
};

const EXAMPLE = 'https://latest.datasette.io/fixtures/facetable';

export function init(api: HostApi): void {
  api.ui.registerUrlSource({
    id: 'datasette',
    label: 'Datasette table or database…',
    async run(api, { url }) {
      const input =
        url ||
        (await api.ui.dialogs.prompt(
          `Datasette table or database URL\n\ne.g. ${EXAMPLE}`,
          '',
          'Import from Datasette',
        ));
      if (!input) return;
      await runImport(api, input);
    },
  });

  api.ui.registerDropHandler(async (event, api) => {
    const text = event.dataTransfer?.getData('text/plain') || '';
    if (!isDatasetteUrl(text)) return false;
    event.preventDefault();
    await runImport(api, text);
    return true;
  });
}

async function runImport(api: HostApi, input: string): Promise<void> {
  try {
    await importDatasette(api, input);
  } catch (err) {
    const msg =
      err instanceof DatasetteError
        ? `Datasette error (${err.status ?? '?'}): ${err.message}`
        : `Could not import: ${(err as Error)?.message ?? err}`;
    await api.ui.dialogs.alert(msg, 'Datasette import failed');
  }
}

/** A database or table URL both qualify for drag-drop import. */
function isDatasetteUrl(text: string): boolean {
  try {
    return !!parseDatasetteUrl(text).db;
  } catch {
    return false;
  }
}

/**
 * Import from any Datasette URL. Whether the URL names a single table or a
 * whole database is decided from the JSON *response* — a database page returns
 * a `tables` list; a table returns `rows` — rather than from the path shape,
 * which is fragile (mount prefixes, `.json` suffixes, etc.). A database imports
 * every non-hidden table; a table imports just itself.
 */
export async function importDatasette(api: HostApi, input: string): Promise<void> {
  const ref = parseDatasetteUrl(input);
  if (!ref.db) {
    throw new Error('URL must point to a Datasette database or table, e.g. .../<database>[/<table>]');
  }
  const fetchFn = (u: string, o?: any) => api.backend.fetch(u, o);

  const probe = await probeDatasette(fetchFn, input);
  if (probe.kind === 'database') {
    await importDatabaseRef(api, ref, probe.tables);
    return;
  }
  if (!ref.table) {
    throw new Error('That URL responds like a Datasette table but has no table name in its path.');
  }
  await importTableRef(api, ref, { announce: true });
}

/**
 * Fetch the URL's `.json` once and classify it: a database page carries a
 * `tables` list; a table carries `rows`. Returns the discovered table names
 * for the database case so the caller needn't re-fetch the page.
 */
async function probeDatasette(
  fetchFn: (url: string, opts?: any) => Promise<Response>,
  input: string,
): Promise<{ kind: 'table' | 'database'; tables: string[] }> {
  const u = new URL(input);
  u.pathname = u.pathname.replace(/\.(json|csv)$/i, '') + '.json';
  const res = await fetchFn(u.toString());
  const json: any = await res.json();
  if (json && json.ok === false) throw new DatasetteError(json, res.status);

  const tables = extractTableNames(json);
  const looksDatabase = Array.isArray(json?.tables);
  const looksTable = Array.isArray(json?.rows) || Array.isArray(json?.columns);
  if (looksDatabase && !looksTable) return { kind: 'database', tables };
  if (looksTable) return { kind: 'table', tables: [] };
  // Ambiguous response — fall back to the URL shape.
  return { kind: tables.length > 0 ? 'database' : 'table', tables };
}

/** Back-compat single-table entry: parse an input URL, require a table. */
export async function importDatasetteTable(api: HostApi, input: string): Promise<string> {
  const ref = parseDatasetteUrl(input);
  if (!ref.db || !ref.table) {
    throw new Error('URL must point to a table, e.g. .../<database>/<table>');
  }
  return (await importTableRef(api, ref, { announce: true })).tableId;
}

interface TableImportResult {
  tableId: string;
  name: string;
  rowCount: number;
  count: number | null;
  hasMore: boolean;
  truncated: boolean;
}

/** Fetch schema + rows for one table (given a resolved ref) and store it locally. */
async function importTableRef(
  api: HostApi,
  ref: DatasetteRef,
  opts: { announce?: boolean } = {},
): Promise<TableImportResult> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-source: no active workspace');
  if (!ref.db || !ref.table) throw new Error('datasette-source: table ref requires db + table');

  const fetchFn = (u: string, o?: any) => api.backend.fetch(u, o);

  const { columns, pks, count } = await fetchTableMeta(fetchFn, ref);
  const { rows, truncated, hasMore, pages } = await fetchRows(fetchFn, ref, {
    maxRows: SETTINGS.maxImportRows,
    pageSize: SETTINGS.pageSize,
  });

  // Some Datasette instances/versions don't return column metadata for our
  // `_extra` request, which used to yield a table with rows but no columns.
  // Fall back to inferring columns from the rows, and union in any row keys
  // the metadata didn't cover.
  let columnSpecs = columns;
  if (columnSpecs.length === 0) {
    columnSpecs = inferColumnsFromRows(rows, pks);
  } else {
    const known = new Set(columnSpecs.map((c) => c.field));
    const extra = inferColumnsFromRows(rows, pks).filter((c) => !known.has(c.field));
    if (extra.length > 0) columnSpecs = [...columnSpecs, ...extra];
  }

  const now = Date.now();
  const tableId = cryptoUUID();
  const name = `${ref.db}/${ref.table}`;
  api.events.emit('import:before', { source: 'datasette', tableId });
  await api.store.tables.insert({
    id: tableId,
    workspaceId,
    name,
    code: slug(`${ref.db}-${ref.table}`),
    columns: columnSpecs,
    view: 'table',
    updatedAt: now,
  });

  const docs: Row[] = rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: now }));
  await api.store.rows(tableId).bulkInsert(docs);

  api.events.emit('import:after', { source: 'datasette', tableId, rowCount: rows.length });

  if (opts.announce) {
    const total = count != null ? ` of ${count}` : '';
    if (hasMore || truncated) {
      api.ui.dialogs.toast(
        `Imported first ${rows.length}${total} rows from ${ref.table} — more available ` +
          `(capped at ${SETTINGS.maxImportRows}). Live paging arrives with the Phase-2 connector.`,
        { kind: 'warning' },
      );
    } else {
      api.ui.dialogs.toast(
        `Imported ${rows.length} rows from ${ref.table} (${pages} page${pages === 1 ? '' : 's'}).`,
        { kind: 'success' },
      );
    }
  }

  return { tableId, name, rowCount: rows.length, count, hasMore, truncated };
}

/** Import every non-hidden table in a Datasette database (names from the probe). */
async function importDatabaseRef(api: HostApi, ref: DatasetteRef, names: string[]): Promise<void> {
  if (names.length === 0) throw new Error(`No tables found in database "${ref.db}".`);

  api.ui.dialogs.toast(
    `Importing ${names.length} table${names.length === 1 ? '' : 's'} from ${ref.db}…`,
    { kind: 'info' },
  );

  let imported = 0;
  let rowTotal = 0;
  let capped = 0;
  const failures: string[] = [];
  for (const table of names) {
    try {
      const res = await importTableRef(api, { ...ref, table }, { announce: false });
      imported += 1;
      rowTotal += res.rowCount;
      if (res.hasMore || res.truncated) capped += 1;
    } catch (err) {
      failures.push(`${table}: ${(err as Error)?.message ?? err}`);
    }
  }

  const cappedNote = capped > 0 ? ` (${capped} capped at ${SETTINGS.maxImportRows} rows)` : '';
  if (imported > 0) {
    api.ui.dialogs.toast(
      `Imported ${imported}/${names.length} table${names.length === 1 ? '' : 's'} ` +
        `(${rowTotal} rows) from ${ref.db}${cappedNote}.`,
      { kind: failures.length ? 'warning' : 'success' },
    );
  }
  if (failures.length > 0) {
    api.ui.dialogs.toast(
      `${failures.length} table${failures.length === 1 ? '' : 's'} failed to import:\n${failures
        .slice(0, 5)
        .join('\n')}${failures.length > 5 ? `\n…and ${failures.length - 5} more.` : ''}`,
      { kind: 'error', title: 'Datasette import' },
    );
  }
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
