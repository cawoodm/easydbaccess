// packages/renderer/src/plugins/table-copy.ts
//
// Copy a table — or a projection — into a new table in the same workspace.
//
// Three answers to "what should the copy contain?", the same vocabulary the
// per-table Export menu already uses (`export/table-file.ts`), so Copy and
// Export narrow data the same way:
//
//   Duplicate     — the same KIND of thing. A projection duplicates as a
//                   projection (still live, same spec); a connected table as
//                   another connection; a plain local table as a full copy of
//                   its rows.
//   Raw Data      — a plain LOCAL table: every column, every row, materialized.
//                   This is how you SNAPSHOT a projection or a live table —
//                   the copy stops tracking its sources and is yours to edit.
//   Visible Data  — the same, narrowed to what is on screen: non-hidden
//                   columns, with the table's filters and sort applied.
//
// Duplicate is what "copy" usually means; the other two are the ones that turn
// something derived into something owned. That distinction is the whole point
// of the prompt — a projection's rows are recomputed from its sources, so
// duplicating one gives you a second live view, not a record of today's data.

import type { ColumnSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { scopedColumns, scopedRows } from '../export/table-file.js';
import { takenNames, uniqueTableName } from '../import/land-tables.js';
import { cryptoUUID, slugTable } from '../util/ids.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'table-copy',
  name: 'Copy Table',
  type: 'ui',
  version: '0.1.0',
  description: 'Adds a Copy button to each table window: duplicate it as-is, or snapshot its Raw / Visible data into a new plain table. Works on projections too — that is how you freeze one.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/table-copy.ts',
};

export type CopyMode = 'duplicate' | 'raw' | 'visible';

export function init(api: HostApi): void {
  api.ui.registerTableButton({
    id: 'table-copy:copy',
    label: 'Copy',
    icon: 'content_copy',
    tooltip: 'Copy this table — as a duplicate, or as a snapshot of its data',
    onClick: (a, { tableId }) => void copyTableFlow(a, tableId),
  });
}

/** What each mode does to THIS table, so the prompt can say it plainly. */
function describeMode(table: Table, mode: CopyMode): string {
  const projection = table.source?.type === 'projection';
  if (mode === 'duplicate') {
    if (projection) return 'a second projection over the same sources (still live)';
    if (table.source) return 'another connection to the same source (still live)';
    return 'a full copy of its columns and rows';
  }
  const what = mode === 'raw' ? 'every column and row' : 'the visible columns and filtered rows';
  return table.source ? `a plain table holding ${what} as they are right now` : `a plain table holding ${what}`;
}

async function copyTableFlow(api: HostApi, tableId: string): Promise<void> {
  const table = await api.store.tables.findOne(tableId);
  if (!table) return;

  // 'Duplicate' is listed first, so it is the dialog's default — it is what
  // "copy" means when nobody is thinking about scopes.
  const choice = await api.ui.dialogs.choice(`Copy "${table.name}" — what should the copy contain?`, ['Duplicate', 'Raw Data', 'Visible Data'], 'Copy table');
  if (!choice) return;
  const mode: CopyMode = choice === 'Duplicate' ? 'duplicate' : choice === 'Raw Data' ? 'raw' : 'visible';

  try {
    const copy = await copyTable(api, table, mode);
    api.ui.dialogs.toast(`Copied "${table.name}" to "${copy.name}" — ${describeMode(table, mode)}.`, {
      kind: 'success',
      title: 'Copy table',
    });
  } catch (err) {
    api.ui.dialogs.toast(`Could not copy "${table.name}": ${(err as Error)?.message ?? String(err)}`, {
      kind: 'error',
      title: 'Copy table',
    });
  }
}

/**
 * Create the copy and return it. Exported for tests and for anything that
 * wants a copy without the prompt.
 *
 * A snapshot (`raw` / `visible`) reads the rows through the ordinary row
 * collection, so a projection's rows arrive already computed and a connected
 * table's already fetched — the copy needs no knowledge of where they came
 * from, only that it is keeping them.
 */
export async function copyTable(api: HostApi, table: Table, mode: CopyMode): Promise<Table> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('table-copy: no active workspace');

  const name = uniqueTableName(await takenNames(api, workspaceId), `${table.name} copy`);
  const id = cryptoUUID();
  const now = Date.now();

  // Geometry is deliberately NOT copied: an identical rect would drop the new
  // window exactly on top of the original, looking like nothing happened. Let
  // the window manager cascade it.
  const base = {
    id,
    workspaceId,
    name,
    code: slugTable(name),
    view: table.view,
    ...(table.title ? { title: `${table.title} copy` } : {}),
    ...(table.labelColumn ? { labelColumn: table.labelColumn } : {}),
    ...(table.info ? { info: table.info } : {}),
    updatedAt: now,
  };

  if (mode === 'duplicate') {
    const copy: Table = {
      ...base,
      columns: table.columns,
      ...(table.sortBy ? { sortBy: table.sortBy } : {}),
      ...(table.sortColumn ? { sortColumn: table.sortColumn, sortAsc: table.sortAsc ?? true } : {}),
      ...(table.filters ? { filters: table.filters } : {}),
      ...(table.deletedColumns ? { deletedColumns: table.deletedColumns } : {}),
      ...(table.readonly ? { readonly: true } : {}),
      ...(table.source ? { source: table.source } : {}),
      ...(table.origin ? { origin: table.origin } : {}),
    };
    await api.store.tables.insert(copy);
    // A source-backed table derives or fetches its own rows; copying them would
    // either duplicate nothing useful (a projection recomputes them) or write to
    // the wrong place. Only a plain local table carries its rows across.
    if (!table.source) await copyRows(api, table.id, id, (rows) => rows);
    return copy;
  }

  // A snapshot is a plain, owned, editable table: no `source` (it no longer
  // tracks anything) and no `readonly`. `origin` IS kept when the original had
  // one, so the copy still records where the data came from.
  const copy: Table = {
    ...base,
    // A projection marks joined/computed columns readonly because they have no
    // unambiguous write target. Once the rows are materialized they are
    // ordinary cells, so the flag would be a lie.
    columns: scopedColumns(table, mode).map(writableColumn),
    // 'visible' has already applied the filters and sort while materializing
    // the rows, so carrying them over would filter the copy a second time.
    ...(mode === 'raw' && table.filters ? { filters: table.filters } : {}),
    ...(mode === 'raw' && table.sortBy ? { sortBy: table.sortBy } : {}),
    ...(mode === 'raw' && table.sortColumn ? { sortColumn: table.sortColumn, sortAsc: table.sortAsc ?? true } : {}),
    ...(table.origin ? { origin: table.origin } : {}),
  };
  await api.store.tables.insert(copy);
  await copyRows(api, table.id, id, (rows) => scopedRows(table, rows, mode));
  return copy;
}

/** The same column, minus a `readonly` flag that a snapshot has outgrown. */
function writableColumn(c: ColumnSpec): ColumnSpec {
  if (!c.readonly) return c;
  const copy = { ...c };
  delete copy.readonly;
  return copy;
}

/** Read the source rows, narrow them, and write them to the new table. */
async function copyRows(api: HostApi, fromId: string, toId: string, narrow: (rows: Row[]) => Row[]): Promise<void> {
  const rows = narrow(await api.store.rows(fromId).find());
  if (rows.length === 0) return;
  const now = Date.now();
  await api.store.rows(toId).bulkInsert(
    // Fresh ids: a projection's row ids encode its provenance (`baseRow#n`) and
    // would collide with the original's anyway.
    rows.map((r) => ({ id: cryptoUUID(), tableId: toId, data: { ...r.data }, updatedAt: now })),
  );
}
