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
  inferColumnsFromRows,
  DatasetteError,
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
    label: 'Datasette table…',
    async run(api, { url }) {
      const input =
        url ||
        (await api.ui.dialogs.prompt(`Datasette table URL\n\ne.g. ${EXAMPLE}`, '', 'Import from Datasette'));
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
    await importDatasetteTable(api, input);
  } catch (err) {
    const msg =
      err instanceof DatasetteError
        ? `Datasette error (${err.status ?? '?'}): ${err.message}`
        : `Could not import: ${(err as Error)?.message ?? err}`;
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

/** Fetch schema + rows from Datasette and create a local eda table. */
export async function importDatasetteTable(api: HostApi, input: string): Promise<string> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-source: no active workspace');

  const ref = parseDatasetteUrl(input);
  if (!ref.db || !ref.table) {
    throw new Error('URL must point to a table, e.g. .../<database>/<table>');
  }
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
  api.events.emit('import:before', { source: 'datasette', tableId });
  await api.store.tables.insert({
    id: tableId,
    workspaceId,
    name: `${ref.db}/${ref.table}`,
    code: slug(`${ref.db}-${ref.table}`),
    columns: columnSpecs,
    view: 'table',
    updatedAt: now,
  });

  const docs: Row[] = rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: now }));
  await api.store.rows(tableId).bulkInsert(docs);

  api.events.emit('import:after', { source: 'datasette', tableId, rowCount: rows.length });

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
  return tableId;
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
