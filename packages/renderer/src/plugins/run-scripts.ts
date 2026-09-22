// A `</>` button in each table's footer that runs every column's render script
// over the rows and WRITES what each returns into its cells — the whole-table
// counterpart of the script editor's **Run…**, which does one column.
//
// It sits beside Validate's ✓ because the two are the same kind of act: a
// deliberate, whole-table pass the user asks for, that takes a while and reports
// what it did. Neither happens on its own.
//
// Two questions before it writes, in this order, because the first changes what
// the second is being asked about:
//
//  1. **Which scripts** — enabled only, all, or the disabled ones only. A parked
//     script is the interesting case: it is parked precisely BECAUSE it should
//     not compute on every draw, and running it on demand is the reason to park
//     rather than delete it (see `dialogs/script-editor-dialog.ts`).
//  2. **Which rows** — what the grid is showing, or the whole table.
//
// No script is ever changed: a run writes cells and stops there. The Enable
// switch in the column editor is the only thing that turns a script on or off.

import type { ColumnSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { setTableLoading } from '../table/table-loading.js';
import { requestVisibleRows } from '../table/visible-rows.js';
import { materializeColumnScript, type MaterializeResult } from '../table/materialize-script.js';
import { isErrorField } from '../table/row-errors.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'run-scripts',
  name: 'Run scripts',
  type: 'ui',
  version: '0.1.0',
  description: 'Table footer button that runs every column’s render script and writes what it returns into the cells.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/run-scripts.ts',
};

/** Which of a table's scripted columns a run covers. */
type Which = 'enabled' | 'all' | 'disabled';

const WHICH_LABELS: Record<Which, string> = {
  enabled: 'Only enabled scripts',
  all: 'All scripts',
  disabled: 'Only disabled scripts',
};

const VISIBLE_ROWS = 'Visible rows';
const ALL_ROWS = 'All rows';

/** Does this column have a render script at all? `_error` is Validate's, never ours. */
function hasScript(c: ColumnSpec): boolean {
  return !isErrorField(c.field) && !!c.script?.trim();
}

/** A script is ON unless `scriptActive` says otherwise — absent means on. */
function isEnabled(c: ColumnSpec): boolean {
  return c.scriptActive !== false;
}

/** The columns a given answer selects, in column order. */
export function columnsFor(columns: readonly ColumnSpec[], which: Which): ColumnSpec[] {
  return columns.filter((c) => hasScript(c) && (which === 'all' || (which === 'enabled') === isEnabled(c)));
}

/** One line for the toast: what every column did, added up. */
export function runSummary(per: ReadonlyArray<{ field: string; result: MaterializeResult }>): string {
  const written = per.reduce((n, p) => n + p.result.written, 0);
  const failed = per.reduce((n, p) => n + p.result.failed, 0);
  const cols = per.length;
  const head = `${written.toLocaleString()} ${written === 1 ? 'cell' : 'cells'} written across ${cols} ${cols === 1 ? 'column' : 'columns'}`;
  const first = per.find((p) => p.result.firstError)?.result.firstError;
  return failed > 0 ? `${head}, ${failed.toLocaleString()} failed — ${first ?? 'the script threw'}.` : `${head}.`;
}

export function init(api: HostApi): void {
  api.ui.registerTableButton({
    id: 'run-scripts:run',
    label: 'Run scripts',
    icon: 'code',
    tooltip: 'Run this table’s column scripts and write what they return into the cells',
    // Nowhere to write: a source-backed table's rows are derived or remote (a
    // projection computes them, Datasette owns them), and one the user marked
    // read-only is not ours to rewrite. Same rule Validate uses for `_error`.
    visible: (table) => !table.source && !table.readonly,
    onClick: async (hostApi, ctx) => {
      const table = await hostApi.store.tables.findOne(ctx.tableId);
      if (!table) return;
      await runTableScripts(hostApi, table);
    },
  });
}

/** Ask the two questions, then write. */
async function runTableScripts(api: HostApi, table: Table): Promise<void> {
  const dialogs = api.ui.dialogs;
  const scripted = table.columns.filter(hasScript);
  if (scripted.length === 0) {
    await dialogs.alert(`No column of “${table.name}” carries a script. Add one with the pencil left of Max in the columns editor.`, 'Run scripts');
    return;
  }

  // The counts are in the labels because "Only disabled scripts" is a real
  // answer that can select nothing, and finding that out after two dialogs and
  // a confirm is the kind of thing that makes people stop trusting a button.
  const counts: Record<Which, number> = {
    enabled: columnsFor(table.columns, 'enabled').length,
    all: scripted.length,
    disabled: columnsFor(table.columns, 'disabled').length,
  };
  const order: Which[] = ['enabled', 'all', 'disabled'];
  const labels = order.map((w) => `${WHICH_LABELS[w]} (${counts[w]})`);
  const pickedScripts = await dialogs.choice(`Which of “${table.name}”’s ${scripted.length} scripted columns should run?`, labels, 'Run scripts');
  if (pickedScripts === null) return;
  const which = order[labels.indexOf(pickedScripts)] ?? 'enabled';
  const columns = columnsFor(table.columns, which);
  if (columns.length === 0) {
    await dialogs.alert(`No column matches “${WHICH_LABELS[which]}”.`, 'Run scripts');
    return;
  }

  const coll = api.store.rows(table.id);
  const all = await coll.find();
  const shown = requestVisibleRows(table.id)?.rows ?? null;
  const pickedRows = await dialogs.choice(
    `Write into ${columns.length === 1 ? `“${columns[0]?.label || columns[0]?.field}”` : `${columns.length} columns`} of “${table.name}”? ` +
      `The stored values are replaced and this cannot be undone. The scripts themselves are not changed.`,
    [`${VISIBLE_ROWS} (${(shown?.length ?? all.length).toLocaleString()})`, `${ALL_ROWS} (${all.length.toLocaleString()})`],
    'Run scripts',
  );
  if (pickedRows === null) return;
  const targets: readonly Row[] = pickedRows.startsWith(VISIBLE_ROWS) ? (shown ?? all) : all;

  await writeAll(api, table, columns, coll, targets);
}

/**
 * Run each column in turn, reporting across the WHOLE job rather than per
 * column — a table with six scripted columns would otherwise show six bars
 * filling and resetting, which says nothing about how long the thing takes.
 */
async function writeAll(
  api: HostApi,
  table: Table,
  columns: readonly ColumnSpec[],
  coll: ReturnType<HostApi['store']['rows']>,
  targets: readonly Row[],
): Promise<void> {
  const per: Array<{ field: string; result: MaterializeResult }> = [];
  const totalCells = columns.length * targets.length;
  let before = 0;
  try {
    for (const col of columns) {
      const label = `Running “${col.label || col.field}” in ${table.name}`;
      setAppProgress({ label, fraction: totalCells > 0 ? before / totalCells : undefined });
      const result = await materializeColumnScript(coll, col.script ?? '', col.field, targets, (done) => {
        const fraction = totalCells > 0 ? (before + done) / totalCells : undefined;
        setAppProgress({ label, ...(fraction === undefined ? {} : { fraction }), detail: `${(before + done).toLocaleString()} of ${totalCells.toLocaleString()} cells` });
        setTableLoading(table.id, true, fraction);
      });
      before += targets.length;
      per.push({ field: col.field, result });
    }
    api.ui.dialogs.toast(runSummary(per), { kind: per.some((p) => p.result.failed > 0) ? 'error' : 'success', title: 'Run scripts' });
  } catch (err) {
    await api.ui.dialogs.alert(`Could not run the scripts: ${err instanceof Error ? err.message : String(err)}`, 'Run scripts');
  } finally {
    clearAppProgress();
    setTableLoading(table.id, false);
  }
}
