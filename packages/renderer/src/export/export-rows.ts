/**
 * The export dialog's general options, turned into the table and rows to write.
 *
 * One place, so CSV, JSON and every format after them project the same data for
 * the same answers. A serializer receives what comes out of here and must not
 * narrow again — a limit taken twice is a smaller file than the user asked for.
 *
 * This supersedes the `raw` / `visible` / `structure` scopes in `table-file.ts`
 * for the dialog's purposes. Those stay: `table-copy` and the Gist push still use
 * them, and `visible` there means filtered AND sorted AND non-hidden as one word,
 * which is exactly what the dialog splits apart.
 */

import type { ColumnSpec, DataCollection, ExportOptions, Row, Table } from '@easydb/shared';
import { activeColumnScript, arrayMembers, scriptDeclined } from '@easydb/shared';
import { readRows } from '../db/row-reader.js';
import { ROW_FETCH_CAP } from '../db/data-store-bridge.js';
import { filterRows } from '../views/view-render.js';
import { readSortSpecs, sortRowsBySpecs } from '../table/row-sort.js';
import { runColumnScript } from '../util/column-script.js';
import { formatByType } from '../util/local-datetime.js';

/** The general options a plain "everything, as stored" export would use. */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  limitRows: 0,
  columns: 'visible',
  rows: 'filtered',
  order: 'sorted',
  values: 'raw',
  runScripts: true,
};

export interface PreparedExport {
  /** The table, with its columns narrowed to what is being written. */
  table: Table;
  rows: Row[];
  /** Rows were cut short of what the options asked for — the store capped the read. */
  truncated: boolean;
}

/**
 * Read and shape one table for export.
 *
 * The order is not free. Filter and sort run BEFORE the limit is applied, or "the
 * first 500, sorted" would silently mean "sort of the first 500" — the trap
 * `applyRowRequest` documents for the grid, with the same wrong-but-plausible
 * result. A limit is therefore a cut of the finished answer, not a cheaper read,
 * unless nothing narrows the rows at all.
 */
export async function prepareExport(coll: DataCollection<Row>, table: Table, options: ExportOptions): Promise<PreparedExport> {
  const narrows = options.rows === 'filtered' && hasFilters(table);
  const reorders = options.order === 'sorted' && readSortSpecs(table).length > 0;
  const page = await readForExport(coll, options, narrows || reorders);

  let rows = page.rows;
  if (options.rows === 'filtered') rows = filterRows(rows, table.filters ?? {}, table.columns);
  if (options.order === 'sorted') rows = sortRowsBySpecs(rows, readSortSpecs(table), table.columns);
  if (options.limitRows > 0 && rows.length > options.limitRows) rows = rows.slice(0, options.limitRows);

  const columns = options.columns === 'visible' ? table.columns.filter((c) => c.hidden !== true) : table.columns;
  if (options.runScripts) rows = withScriptValues(rows, columns);
  if (options.values === 'rendered') rows = withRenderedValues(rows, columns);

  return { table: { ...table, columns }, rows, truncated: page.truncated };
}

function hasFilters(table: Table): boolean {
  return Object.values(table.filters ?? {}).some((v) => (v ?? '').trim() !== '');
}

/**
 * Fetch the rows the options need.
 *
 * An unnarrowed limited export is the one case that can be a real page — ask the
 * store for exactly those rows and nothing else, which on a 609,283-row table is
 * the difference between 300 ms and 21.6 s. Everything else has to see every row
 * before it can know which ones come first, so it reads them all, capped, and
 * reports the cap rather than looking complete.
 */
async function readForExport(coll: DataCollection<Row>, options: ExportOptions, narrowed: boolean): Promise<{ rows: Row[]; truncated: boolean }> {
  if (options.limitRows > 0 && !narrowed) {
    const page = await readRows(coll, { columns: [], limit: options.limitRows, countTotal: false }, ROW_FETCH_CAP);
    return { rows: page.rows, truncated: page.truncated === true };
  }
  // `find()` on the bridge stores (Electron IPC, and the browser's `.edb` worker)
  // caps at ROW_FETCH_CAP without saying so. Going through `readRows` is what makes
  // the cut visible, so the dialog can warn instead of writing a short file that
  // looks whole.
  const page = await readRows(coll, { columns: [], countTotal: false }, ROW_FETCH_CAP);
  return { rows: page.rows, truncated: page.truncated === true };
}

/**
 * Fill in the computed columns, so a scripted column exports its value.
 *
 * Only where the column stores nothing of its own: a script that decorates stored
 * data must not overwrite it. A script that throws leaves the cell as it was —
 * an export is not the place to surface a script error, and a half-written file
 * with an error string in one cell is worse than the value being absent.
 */
function withScriptValues(rows: Row[], columns: readonly ColumnSpec[]): Row[] {
  const scripted = columns.filter((c) => activeColumnScript(c) !== undefined);
  if (scripted.length === 0) return rows;
  return rows.map((r) => {
    const data = { ...r.data };
    for (const col of scripted) {
      if (data[col.field] != null && data[col.field] !== '') continue;
      const run = runColumnScript(activeColumnScript(col), r.data);
      // A declined script leaves the (empty) stored cell as it is — writing its
      // `null` in would export the word "null" for a blank.
      if (run.ok && !scriptDeclined(run.value)) data[col.field] = run.value as never;
    }
    return { ...r, data };
  });
}

/** Values as the grid shows them: a local datetime, an array as its members. */
function withRenderedValues(rows: Row[], columns: readonly ColumnSpec[]): Row[] {
  return rows.map((r) => {
    const data = { ...r.data };
    for (const col of columns) {
      const v = data[col.field];
      if (v == null) continue;
      if (col.type === 'array') {
        data[col.field] = arrayMembers(v).join(', ') as never;
        continue;
      }
      const formatted = formatByType(col.type, v);
      if (formatted != null) data[col.field] = formatted as never;
    }
    return { ...r, data };
  });
}
