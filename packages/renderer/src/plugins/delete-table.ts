import type { HostApi, PluginModule, Table } from '@easydb/shared';
import { deleteTable } from '../window-mgr/table-window-manager.js';
import { visibleCountOf } from '../window-mgr/panel-title.js';
import { deleteAllRows, deleteVisibleRows } from '../table/delete-rows.js';
import { forgetRowCount } from '../table/row-count-cache.js';
import { narrowsRows, rowRequestOf } from '../table/visible-request.js';
import { TopProgress } from '../chrome/top-progress.js';

// Closing a table window now only HIDES it (the record and rows are kept, and
// it's reopened from the command palette). This plugin provides the explicit,
// confirmed way to delete PERMANENTLY — a trash button in each table window's
// button bar.
//
// The button asks WHAT should go, because "delete" means three different things
// on a table and only the user knows which one:
//
//   Delete All Data      the rows, keeping the table and its columns
//   Delete Visible Data  the rows a filter or a search has left on screen
//   Delete Table         the table itself, rows included
//
// The choice IS the confirmation. Each option names the action and how many rows
// it takes, and cancelling is one button away — so a second yes/no dialog would
// only add a click to every delete. A live (source-backed) table is the exception:
// its data is on the server, so there is nothing to choose and it keeps the plain
// confirm it always had.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'delete-table',
  name: 'Delete Table',
  type: 'ui',
  version: '0.2.0',
  description: 'Adds a trash button to each table window that deletes all its rows, the rows a filter left visible, or the table itself.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/delete-table.ts',
};

const DELETE_TABLE = 'Delete Table';

export function init(api: HostApi): void {
  api.ui.registerTableButton({
    id: 'delete-table:delete',
    label: 'Delete',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#7f1d1d" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    tooltip: 'Delete this table, or its data',
    onClick: async (api, ctx) => {
      const table = await api.store.tables.findOne(ctx.tableId);
      if (!table) return;
      if (table.source) {
        await disconnectLiveTable(api, table);
        return;
      }
      await askAndDelete(api, table);
    },
  });
}

/**
 * A live table holds no local rows, so the data options would delete nothing.
 * Removing it disconnects: the rows stay on the server.
 */
async function disconnectLiveTable(api: HostApi, table: Table): Promise<void> {
  const yes = await api.ui.dialogs.confirm(`Delete the live table "${table.name}"? Its data stays on the server — only the local connection is removed.`, 'Delete table');
  if (!yes) return;
  await deleteTable(table.id);
  api.ui.dialogs.toast(`Deleted "${table.name}".`, { kind: 'success', title: 'Delete table' });
}

/** `" (1,234 rows)"`, or nothing when the size is not known yet. */
function rowsSuffix(n: number): string {
  if (n < 0) return '';
  return ` (${n.toLocaleString()} row${n === 1 ? '' : 's'})`;
}

/**
 * Offer the three deletes, then carry out the one that was picked.
 *
 * The counts come from what the grid already published for the titlebar, so
 * opening this dialog costs no read. A big table still counting shows `-1`, and
 * the option then carries no number rather than a wrong one.
 */
async function askAndDelete(api: HostApi, table: Table): Promise<void> {
  const seen = visibleCountOf(table.id);
  const req = rowRequestOf(table.id);
  const total = seen?.total ?? -1;
  const visible = seen?.count ?? -1;

  const allLabel = `Delete All Data${rowsSuffix(total)}`;
  const visibleLabel = `Delete Visible Data${rowsSuffix(visible)}`;
  const options: string[] = [];
  // A table known to be empty is offered no data options: both would delete
  // nothing, and an option that does nothing still reads as a threat.
  if (total !== 0) options.push(allLabel);
  if (narrowsRows(req) && visible !== 0) options.push(visibleLabel);
  options.push(DELETE_TABLE);

  const pick = await api.ui.dialogs.choice(
    `"${table.name}" — what should go? This cannot be undone.\n\nThe two data options keep the table and its columns. Delete Table takes the table with them.`,
    options,
    'Delete',
  );
  if (!pick) return;

  if (pick === DELETE_TABLE) {
    await deleteTable(table.id);
    api.ui.dialogs.toast(`Deleted "${table.name}".`, { kind: 'success', title: 'Delete table' });
    return;
  }

  const bar = TopProgress.begin(pick === visibleLabel ? 'Deleting visible rows' : 'Deleting rows');
  try {
    const coll = api.store.rows(table.id);
    const onProgress = (done: number, of: number) => bar.fraction(of > 0 ? done / of : null);
    const gone = pick === visibleLabel && req ? await deleteVisibleRows(coll, req, onProgress) : await deleteAllRows(coll, onProgress);
    // The remembered size describes a table that no longer holds those rows. The
    // grid re-counts on the write, and a stale total in the meantime would show in
    // the titlebar of the next window to open this table.
    forgetRowCount(table.id);
    api.ui.dialogs.toast(`Deleted ${gone.toLocaleString()} row${gone === 1 ? '' : 's'} from "${table.name}".`, { kind: 'success', title: 'Delete rows' });
  } catch (err) {
    api.ui.dialogs.toast(`Could not delete the rows: ${(err as Error)?.message ?? String(err)}`, { kind: 'error', title: 'Delete rows' });
  } finally {
    bar.done();
  }
}
