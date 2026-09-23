// The **Run** button in each table's footer — a ▶ with a menu.
//
// It was two buttons: this one (`</>`) and Validate's ✓. They are the same kind
// of act — a deliberate, whole-table pass the user asks for, that takes a while
// and reports what it did — so they are one button with two items now:
//
//   Run scripts       write every chosen column's render script into its cells
//   Run validations   check every chosen column's rules and mark what is wrong
//
// This plugin owns the button; each half registers its own item through
// `table/run-actions.ts`, so switching `validate` off in the Plugin Manager
// takes its item off the menu rather than leaving one that answers nothing.
//
// One dialog asks both questions — WHICH columns (ticked individually, or All)
// and WHICH rows (what the grid shows, or the whole table). It used to be two
// `choice()`s offering three canned sets, which could not express "that column,
// not the other five" and asked about rows a dialog after the user had stopped
// thinking about columns. See `dialogs/run-picker-dialog.ts`.
//
// A run never deletes a script. It may, at the user's word, switch one OFF —
// see `askActive` — because an enabled script recomputes on every draw and
// materializing it is usually the moment that stops being worth paying for.

import type { ColumnSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { AnchoredMenu } from '@marccawood/lit-menu';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { RunPickerDialog } from '../dialogs/run-picker-dialog.js';
import { setTableLoading } from '../table/table-loading.js';
import { requestVisibleRows } from '../table/visible-rows.js';
import { KEEP_ENABLED_HINT, RUN_AND_DISABLE, RUN_AND_KEEP, materializeColumnScript, type MaterializeTally } from '../table/materialize-script.js';
import { isErrorField } from '../table/row-errors.js';
import { registerRunAction, runActionsFor } from '../table/run-actions.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'run-scripts',
  name: 'Run',
  type: 'ui',
  version: '0.2.0',
  description: 'Table footer ▶ button that runs a table’s column scripts — and hosts the menu the other run actions, such as Validate, appear in.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/run-scripts.ts',
};

/** Does this column have a render script at all? `_error` is Validate's, never ours. */
function hasScript(c: ColumnSpec): boolean {
  return !isErrorField(c.field) && !!c.script?.trim();
}

/** A script is ON unless `scriptActive` says otherwise — absent means on. */
export function isScriptEnabled(c: ColumnSpec): boolean {
  return c.scriptActive !== false;
}

/** Every column a run could write, in column order. */
export function scriptedColumns(columns: readonly ColumnSpec[]): ColumnSpec[] {
  return columns.filter(hasScript);
}

/** One line for the toast: what every column did, added up. */
export function runSummary(per: ReadonlyArray<{ field: string; result: MaterializeTally }>): string {
  const written = per.reduce((n, p) => n + p.result.written, 0);
  const failed = per.reduce((n, p) => n + p.result.failed, 0);
  const cols = per.length;
  const head = `${written.toLocaleString()} ${written === 1 ? 'cell' : 'cells'} written across ${cols} ${cols === 1 ? 'column' : 'columns'}`;
  const first = per.find((p) => p.result.firstError)?.result.firstError;
  return failed > 0 ? `${head}, ${failed.toLocaleString()} failed — ${first ?? 'the script threw'}.` : `${head}.`;
}

export function init(api: HostApi): void {
  registerRunAction({
    id: 'run-scripts:scripts',
    label: 'Run scripts',
    icon: 'code',
    order: 10,
    // Nowhere to write: a source-backed table's rows are derived or remote (a
    // projection computes them, Datasette owns them), and one the user marked
    // read-only is not ours to rewrite.
    available: (table) => !table.source && !table.readonly,
    run: runTableScripts,
  });

  api.ui.registerTableButton({
    id: 'run-scripts:run',
    label: 'Run',
    icon: 'play_arrow',
    tooltip: 'Run this table’s column scripts, or check it against its rules',
    onClick: async (hostApi, ctx) => {
      const table = await hostApi.store.tables.findOne(ctx.tableId);
      if (!table) return;
      await openRunMenu(hostApi, table, ctx.anchor);
    },
  });
}

/**
 * Offer the registered runs, then do the one picked.
 *
 * A single registered action runs straight away rather than showing a menu of
 * one — that menu would be a click that only ever has one answer.
 */
async function openRunMenu(api: HostApi, table: Table, anchor?: HTMLElement | undefined): Promise<void> {
  const actions = runActionsFor(table);
  if (actions.length === 0) {
    await api.ui.dialogs.alert('Nothing is registered to run. The Run scripts and Validate plugins both add an item here — check the Plugin Manager.', 'Run');
    return;
  }
  const only = actions[0];
  if (actions.length === 1 && only) {
    await only.run(api, table);
    return;
  }

  const rect = anchor?.getBoundingClientRect();
  const picked = rect
    ? await AnchoredMenu.open(
        rect,
        actions.map((a) => ({ id: a.id, label: a.label, ...(a.icon ? { icon: a.icon } : {}) })),
      )
    : // No anchor (the command palette, say) — fall back to a modal list.
      await api.ui.dialogs.choice(
        `What should “${table.name}” run?`,
        actions.map((a) => a.label),
        'Run',
      );
  if (picked === null) return;
  const chosen = actions.find((a) => a.id === picked) ?? actions.find((a) => a.label === picked);
  if (chosen) await chosen.run(api, table);
}

/** Ask which columns and which rows, then write. */
async function runTableScripts(api: HostApi, table: Table): Promise<void> {
  const dialogs = api.ui.dialogs;
  const picker = RunPickerDialog.instance;
  const scripted = scriptedColumns(table.columns);
  if (scripted.length === 0) {
    await dialogs.alert(`No column of “${table.name}” carries a script. Add one with the pencil left of Max in the columns editor.`, 'Run scripts');
    return;
  }
  if (!picker) return;

  const coll = api.store.rows(table.id);
  const all = await coll.find();
  const shown = requestVisibleRows(table.id)?.rows ?? null;

  const answer = await picker.open({
    title: `Run scripts — ${table.name}`,
    intro: 'Each ticked column’s script runs and what it returns is written into its cells. The stored values are replaced and this cannot be undone; the scripts themselves are kept.',
    items: scripted.map((c) => ({
      field: c.field,
      label: c.label || c.field,
      note: isScriptEnabled(c) ? 'enabled' : 'disabled',
    })),
    visibleRows: shown?.length ?? all.length,
    totalRows: all.length,
    runLabel: 'Run',
  });
  if (!answer) return;

  const columns = scripted.filter((c) => answer.fields.includes(c.field));
  if (columns.length === 0) return;
  const targets: readonly Row[] = answer.rows === 'visible' ? (shown ?? all) : all;

  const disable = await askActive(api, columns);
  if (disable === null) return;

  await writeAll(api, table, columns, coll, targets);
  if (disable) await parkScripts(api, table, columns);
}

/**
 * "You are about to materialize a script that is still live — should it stay
 * live?"
 *
 * Asked only when at least one chosen column's script is ENABLED, because that
 * is the only case where the answer changes anything: a parked script already
 * costs nothing per draw, and asking about it would be a dialog with one real
 * option.
 *
 * Returns true to switch those scripts off after the run, false to leave them
 * on, and null when the user backs out — in which case nothing is written
 * either. This is the confirmation step as well as the question; a second
 * "are you sure" on top of it would be two dialogs saying the same thing.
 */
async function askActive(api: HostApi, columns: readonly ColumnSpec[]): Promise<boolean | null> {
  const live = columns.filter(isScriptEnabled);
  if (live.length === 0) return false;
  const what = live.length === 1 ? `“${live[0]?.label || live[0]?.field}” is enabled` : `${live.length} of the chosen scripts are enabled`;
  const picked = await api.ui.dialogs.choice(`${what}.\n\n${KEEP_ENABLED_HINT}`, [RUN_AND_DISABLE, RUN_AND_KEEP], 'Run scripts');
  if (picked === null) return null;
  return picked === RUN_AND_DISABLE;
}

/**
 * Switch the given columns' scripts off, keeping the source.
 *
 * Re-reads the table first: a run over a big table takes a while, and a columns
 * editor saved during it would be undone by patching the older array back —
 * the same reason `validate.ts` re-reads before it writes `_error`.
 */
async function parkScripts(api: HostApi, table: Table, columns: readonly ColumnSpec[]): Promise<void> {
  const fields = new Set(columns.filter(isScriptEnabled).map((c) => c.field));
  if (fields.size === 0) return;
  const fresh = (await api.store.tables.findOne(table.id)) ?? table;
  const next = fresh.columns.map((c) => (fields.has(c.field) && hasScript(c) ? { ...c, scriptActive: false } : c));
  await api.store.tables.patch(table.id, { columns: next, updatedAt: Date.now() });
}

/**
 * Run each column in turn, reporting across the WHOLE job rather than per
 * column — a table with six scripted columns would otherwise show six bars
 * filling and resetting, which says nothing about how long the thing takes.
 *
 * Each column is fed the rows the LAST one produced, not the snapshot the run
 * started from. A write replaces the whole row document, so running every
 * column from one snapshot made the last column undo all the ones before it:
 * two scripted columns came out with only the second one written.
 */
async function writeAll(
  api: HostApi,
  table: Table,
  columns: readonly ColumnSpec[],
  coll: ReturnType<HostApi['store']['rows']>,
  targets: readonly Row[],
): Promise<void> {
  const per: Array<{ field: string; result: MaterializeTally }> = [];
  const totalCells = columns.length * targets.length;
  let before = 0;
  let current: readonly Row[] = targets;
  try {
    for (const col of columns) {
      const label = `Running “${col.label || col.field}” in ${table.name}`;
      setAppProgress({ label, fraction: totalCells > 0 ? before / totalCells : undefined });
      const result = await materializeColumnScript(coll, col.script ?? '', col.field, current, (done) => {
        const fraction = totalCells > 0 ? (before + done) / totalCells : undefined;
        setAppProgress({ label, ...(fraction === undefined ? {} : { fraction }), detail: `${(before + done).toLocaleString()} of ${totalCells.toLocaleString()} cells` });
        setTableLoading(table.id, true, fraction);
      });
      before += targets.length;
      current = result.rows;
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
