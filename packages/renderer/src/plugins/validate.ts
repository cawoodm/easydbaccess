import type { HostApi, PluginModule, Table } from '@easydb/shared';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { summarizeIssues } from '../table/validate-rules.js';
import { scanTable } from '../table/validate-scan.js';
import { clearRowErrors, rowErrorsFrom, setRowErrors } from '../table/row-errors.js';
import { focusTableWindow } from '../window-mgr/table-window-manager.js';

// A ✓ button in each table's footer that checks every row against its columns'
// rules — `notnull`, `max`, `unique` and a `validate` script — and hands what it
// finds back to the table's own grid.
//
// The findings arrive as a column, `_error`, and the grid filters on it — so what
// is on screen after a run is the rows with something wrong, each beside the
// reason. Fixing one is editing the cell next to the message.
//
// This was a second TABLE of issues at first (`Pets issues`), on the grounds that
// filtering, sorting and exporting are things this app already does — for tables.
// It was the wrong place to work: a copy of a problem cannot be repaired, and it
// is stale the moment the real row is. See `table/row-errors.ts` for what replaced
// it, and why nothing about it is persisted.
//
// The scan is the only thing in the app that runs a column script over more than
// one row, so it gets a progress bar, it yields between pages, and Esc stops it.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'validate',
  name: 'Validate',
  type: 'ui',
  version: '0.2.0',
  description: 'Checks every row against its columns’ rules — required, maximum, unique, validation script — and shows what it finds in an _error column.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/validate.ts',
};

/** Reported per column before the rest is counted rather than listed. */
const CAP_PER_COLUMN = 500;

export function init(api: HostApi): void {
  api.ui.registerTableButton({
    id: 'validate:run',
    label: 'Validate',
    icon: 'check',
    tooltip: 'Check every row against this table’s rules',
    onClick: async (api, ctx) => {
      const table = await api.store.tables.findOne(ctx.tableId);
      if (!table) return;
      await validateTable(api, table);
    },
  });
}

/** Scan one table, then report. */
async function validateTable(api: HostApi, table: Table): Promise<void> {
  const coll = api.store.rows(table.id);
  // Cleared BEFORE the scan, not after it. What is on screen while the scan runs
  // must not be the last run's verdict on rows the user has edited since — and the
  // grid takes the `_error` column and its filter down with it.
  clearRowErrors(table.id);
  let stop = false;
  // Esc cancels. The scan is the one operation here that can run for a minute, and
  // a key the label names is cheaper for everyone than a second progress widget.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop = true;
  };
  document.addEventListener('keydown', onKey);

  try {
    const result = await scanTable(coll, table.columns, {
      runScripts: true,
      capPerColumn: CAP_PER_COLUMN,
      ...(table.labelColumn ? { labelField: table.labelColumn } : {}),
      cancelled: () => stop,
      onProgress: (scanned, total) =>
        setAppProgress({
          label: `Checking ${table.name} — press Esc to stop`,
          ...(total > 0 ? { fraction: Math.min(1, scanned / total), detail: `${scanned.toLocaleString()} of ${total.toLocaleString()} rows` } : { detail: `${scanned.toLocaleString()} rows` }),
        }),
    });

    if (result.noRules) {
      api.ui.dialogs.toast(`No column of "${table.name}" carries a rule, so there is nothing to check. Set Required, Maximum, Unique or a validation script in the columns editor.`, {
        kind: 'info',
        title: 'Validate',
      });
      return;
    }

    if (result.issues.length === 0) {
      const how = result.cancelled ? `the first ${result.scanned.toLocaleString()} rows` : `all ${result.scanned.toLocaleString()} rows`;
      api.ui.dialogs.toast(`No issues in ${how} of "${table.name}".`, { kind: 'success', title: 'Validate' });
      return;
    }

    const errors = rowErrorsFrom(result.issues);
    // Publishing narrows the grid: it adds the `_error` column and filters on it.
    // So the rows are already waiting behind the dialog, which is why the choice
    // below only has to bring the window forward.
    setRowErrors(table.id, errors);
    const lines = summarizeIssues(result.issues, result.capped, table.columns);
    // Both numbers, because they answer different questions: how much is wrong, and
    // how much of the table it is wrong in.
    const head = `${result.issues.length.toLocaleString()} issue${result.issues.length === 1 ? '' : 's'} in ${errors.size.toLocaleString()} of ${result.scanned.toLocaleString()} rows of "${table.name}"${
      result.cancelled ? ', before you stopped it' : ''
    }.`;
    const pick = await api.ui.dialogs.choice(`${head}\n\n${lines.join('\n')}\n\n"${table.name}" now shows those rows only, with the reason in the Problem column. Fix them there, then press ✓ again.`, ['Show me', 'Close'], 'Validate');
    if (pick === 'Show me') focusTableWindow(table.id);
  } finally {
    document.removeEventListener('keydown', onKey);
    clearAppProgress();
  }
}
