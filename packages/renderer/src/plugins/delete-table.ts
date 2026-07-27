import type { HostApi, PluginModule } from '@easydb/shared';
import { deleteTable } from '../window-mgr/jspanel-manager.js';

// Closing a table window now only HIDES it (the record and rows are kept, and
// it's reopened from the command palette). This plugin provides the explicit,
// confirmed way to PERMANENTLY delete a table — a trash button in each table
// window's button bar.

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'delete-table',
  name: 'Delete Table',
  type: 'ui',
  version: '0.1.0',
  description:
    'Adds a trash button to each table window that permanently deletes the table and its rows (with confirmation).',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/delete-table.ts',
};

export function init(api: HostApi): void {
  api.ui.registerTableButton({
    id: 'delete-table:delete',
    label: 'Delete',
    icon: 'delete',
    tooltip: 'Delete this table permanently',
    onClick: async (api, ctx) => {
      const table = await api.store.tables.findOne(ctx.tableId);
      if (!table) return;
      const yes = await api.ui.dialogs.confirm(
        table.source
          ? `Delete the live table "${table.name}"? Its data stays on the server — only the local connection is removed.`
          : `Permanently delete table "${table.name}" and all its rows? This can't be undone.`,
        'Delete table',
      );
      if (!yes) return;
      await deleteTable(ctx.tableId);
      api.ui.dialogs.toast(`Deleted "${table.name}".`, { kind: 'success', title: 'Delete table' });
    },
  });
}
