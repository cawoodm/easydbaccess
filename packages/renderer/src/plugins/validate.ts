import type { ColumnSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { summarizeIssues, type RowIssue } from '../table/validate-rules.js';
import { scanTable } from '../table/validate-scan.js';
import { focusTableWindow } from '../window-mgr/table-window-manager.js';
import { slugTable } from '../util/ids.js';

// A ✓ button in each table's footer that checks every row against its columns'
// rules — `notnull`, `max`, `unique` and a `validate` script — and writes what it
// finds into a table of its own.
//
// Why a TABLE of issues and not a list in a dialog: "let me filter and fix these"
// is a request for filtering, sorting, exporting and clicking through, and this
// app already has all four — for tables. A dialog would need its own copy of each.
// The dialog that appears is the summary, one line per column, and the table is
// what the user works from.
//
// The scan is the only thing in the app that runs a column script over more than
// one row, so it gets a progress bar, it yields between pages, and Esc stops it.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'validate',
  name: 'Validate',
  type: 'ui',
  version: '0.1.0',
  description: 'Checks every row against its columns’ rules — required, maximum, unique, validation script — and collects what it finds in an issues table.',
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

    const issuesTable = await writeIssuesTable(api, table, result.issues);
    const lines = summarizeIssues(result.issues, result.capped, table.columns);
    const head = `${result.issues.length.toLocaleString()} issue${result.issues.length === 1 ? '' : 's'} in ${result.scanned.toLocaleString()} row${result.scanned === 1 ? '' : 's'} of "${table.name}"${
      result.cancelled ? ', before you stopped it' : ''
    }.`;
    const pick = await api.ui.dialogs.choice(
      `${head}\n\n${lines.join('\n')}\n\nThe list is in the table "${issuesTable.name}", where it can be filtered, sorted and exported.`,
      ['Show me', 'Close'],
      'Validate',
    );
    if (pick === 'Show me') focusTableWindow(issuesTable.id);
  } finally {
    document.removeEventListener('keydown', onKey);
    clearAppProgress();
  }
}

/** The columns of the issues table. `key` is dropped when rows have no name. */
function issueColumns(named: boolean): ColumnSpec[] {
  return [
    { field: 'row', label: 'Row', type: 'number' },
    ...(named ? [{ field: 'key', label: 'Which row', type: 'string' } satisfies ColumnSpec] : []),
    { field: 'column', label: 'Column', type: 'string' },
    { field: 'value', label: 'Value', type: 'string' },
    { field: 'problem', label: 'Problem', type: 'string' },
  ];
}

/** A cell of the issues table: a value the user can read and filter on. */
function showValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Write the issues into `<table> issues`, replacing what a previous run left.
 *
 * Replacing rather than adding, and re-using the table by NAME: a second run
 * would otherwise land in `Pets issues-2` (the store uniques a colliding name),
 * and the user would be reading last week's problems in the window they had open.
 */
async function writeIssuesTable(api: HostApi, table: Table, issues: readonly RowIssue[]): Promise<Table> {
  const name = `${table.name} issues`;
  // The table being validated is IN a workspace, so this side of the contract's
  // `string | null` cannot be null by the time a footer button was clicked.
  const wsId = api.workspaceId() ?? table.workspaceId;
  const existing = (await api.store.tables.find()).find((t) => t.workspaceId === wsId && t.name === name);
  const named = !!table.labelColumn;
  const columns = issueColumns(named);
  const info = { description: `What Validate found in "${table.name}". Re-run it to refresh this table; fix the rows in "${table.name}" itself.` };

  let target: Table;
  if (existing) {
    target = await api.store.tables.patch(existing.id, { columns, info, readonly: true, updatedAt: Date.now() });
    const old = await api.store.rows(existing.id).find();
    await api.store.rows(existing.id).bulkRemove(old.map((r) => r.id));
  } else {
    target = await api.store.tables.insert({
      id: crypto.randomUUID(),
      workspaceId: wsId,
      name,
      code: slugTable(name),
      columns,
      view: 'table',
      // Read-only because every row here is derived. Editing a copy of a problem
      // does not fix the row it came from, and this table is rewritten on the next
      // run anyway.
      readonly: true,
      info,
      updatedAt: Date.now(),
    });
  }

  const rows: Row[] = issues.map((i) => ({
    id: crypto.randomUUID(),
    tableId: target.id,
    data: {
      row: i.row,
      ...(named ? { key: i.key } : {}),
      column: i.label,
      value: showValue(i.value),
      problem: i.reason,
    },
    updatedAt: Date.now(),
  }));
  await api.store.rows(target.id).bulkInsert(rows);
  return target;
}
