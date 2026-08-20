import type { HostApi, PluginModule, Table } from '@easydb/shared';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { summarizeIssues } from '../table/validate-rules.js';
import { scanTable } from '../table/validate-scan.js';
import { clearRowErrors, ERROR_FIELD, errorColumnSpec, rowErrorsFrom, setRowErrors, type RowProblems } from '../table/row-errors.js';
import { focusTableWindow } from '../window-mgr/table-window-manager.js';

// A ✓ button in each table's footer that checks every row against its columns'
// rules — `notnull`, `max`, `unique` and a `validate` script — and hands what it
// finds back to the table's own grid.
//
// A run leaves three things behind:
//
//  1. **A mark on every cell that is wrong**, pink like an empty one, with the
//     reason in its tooltip. This is what the user reads.
//  2. **The grid narrowed** to the rows with something wrong, so a big table shows
//     the work and nothing else.
//  3. **A `_error` column** holding each row's whole verdict as text — created
//     hidden, because (1) already says it in place. It is an ordinary column: the
//     columns editor shows it, and renaming it hands the messages over as data.
//
// This was a second TABLE of issues at first (`Pets issues`), on the grounds that
// filtering, sorting and exporting are things this app already does — for tables.
// It was the wrong place to work: a copy of a problem cannot be repaired, and it
// is stale the moment the real row is. See `table/row-errors.ts`.
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

    const errors = rowErrorsFrom(result.issues);
    // A run that stopped early, or that hit a per-column cap, did not speak for
    // every row: a row past the cap is still wrong and this run said nothing about
    // it. Such a run may add messages but must not take any back, or pressing ✓ on
    // a table with 600 broken rows would erase the verdict on 100 of them.
    const spokeForEveryRow = !result.cancelled && result.capped.size === 0;
    // The messages go into the table's own `_error` column BEFORE anything is
    // reported — including on a clean run, which has stale messages to clear.
    await writeMessages(api, table, errors, spokeForEveryRow ? result.stale : []);
    // Publishing marks the offending cells and narrows the grid to their rows. So
    // the rows are already waiting behind the dialog, which is why the choice
    // below only has to bring the window forward.
    setRowErrors(table.id, errors);

    if (result.issues.length === 0) {
      const how = result.cancelled ? `the first ${result.scanned.toLocaleString()} rows` : `all ${result.scanned.toLocaleString()} rows`;
      api.ui.dialogs.toast(`No issues in ${how} of "${table.name}".`, { kind: 'success', title: 'Validate' });
      return;
    }

    const lines = summarizeIssues(result.issues, result.capped, table.columns);
    // Both numbers, because they answer different questions: how much is wrong, and
    // how much of the table it is wrong in.
    const head = `${result.issues.length.toLocaleString()} issue${result.issues.length === 1 ? '' : 's'} in ${errors.size.toLocaleString()} of ${result.scanned.toLocaleString()} rows of "${table.name}"${
      result.cancelled ? ', before you stopped it' : ''
    }.`;
    const pick = await api.ui.dialogs.choice(
      `${head}\n\n${lines.join('\n')}\n\n"${table.name}" now shows those rows only. Each cell that is wrong is marked, with the reason in its tooltip. Fix them, then press ✓ again.`,
      ['Show me', 'Close'],
      'Validate',
    );
    if (pick === 'Show me') focusTableWindow(table.id);
  } finally {
    document.removeEventListener('keydown', onKey);
    clearAppProgress();
  }
}

/**
 * Write each row's verdict into the table's own `_error` column, and clear the
 * ones a previous run left on rows that are clean now.
 *
 * Why write at all, when the grid could hold the messages in memory: because a
 * column the columns editor can show has to BE a column, and a column whose cells
 * are empty in the store is a trap — it exports as blank, and renaming it (which
 * is how a user keeps a copy — a rename re-keys every row) would hand over
 * nothing. So `_error` is ordinary data that Validate owns and rewrites.
 *
 * Bounded by the rows involved, never the table: the flagged rows plus the ones
 * carrying a message that is no longer true. A clean 600,000-row table is not
 * written to at all.
 */
async function writeMessages(api: HostApi, table: Table, errors: ReadonlyMap<string, RowProblems>, stale: readonly string[]): Promise<void> {
  // A source-backed table's rows are derived or remote — a projection computes
  // them, Datasette owns them — and one the user marked read-only must be left
  // alone. The cell marks and the tooltips still work there; only the column does
  // not, because there is nowhere to put it.
  if (table.source || table.readonly) return;
  const coll = api.store.rows(table.id);

  // Re-read, rather than trusting the record the scan started from: a scan of a big
  // table runs for a minute, and a columns editor saved during it would be undone
  // by patching the older array back.
  const fresh = (await api.store.tables.findOne(table.id)) ?? table;
  if (errors.size > 0 && !fresh.columns.some((c) => c.field === ERROR_FIELD)) {
    // Created hidden, once. A later run must not re-hide a column the user chose
    // to unhide, so an existing one is never patched — and a RENAMED one is not
    // found here at all, which is what makes it theirs and this a fresh column.
    await api.store.tables.patch(table.id, { columns: [...fresh.columns, errorColumnSpec()], updatedAt: Date.now() });
  }

  const writes: Array<[string, string]> = [...[...errors].map(([id, p]) => [id, p.message] as [string, string]), ...stale.map((id) => [id, ''] as [string, string])];
  let done = 0;
  for (const [rowId, text] of writes) {
    const row = await coll.findOne(rowId);
    // Deleted since the scan read it. The problem went with it.
    if (row) {
      // Unchanged rows are left alone: a write would bump `updatedAt` and give
      // sync a row to carry for no reason.
      const had = String(row.data[ERROR_FIELD] ?? '');
      if (had !== text) await coll.patch(rowId, { data: { ...row.data, [ERROR_FIELD]: text }, updatedAt: Date.now() });
    }
    done++;
    if (writes.length > 50) setAppProgress({ label: `Marking rows in ${table.name}`, fraction: done / writes.length, detail: `${done.toLocaleString()} of ${writes.length.toLocaleString()}` });
  }
}
