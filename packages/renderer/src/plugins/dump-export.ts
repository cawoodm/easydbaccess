import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'dump-export',
  name: 'Dump Export',
  type: 'exporter',
  version: '0.1.0',
  description: 'The two buttons that open the export dialog — one for the workspace, one per table — plus the .db.json workspace dump the sync plugins share.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/dump-export.ts',
};

export function init(api: HostApi): void {
  // Both buttons now open ONE dialog. They used to open an anchored format menu
  // each, and the table one then asked Raw / Visible / Structure in a second
  // prompt — a shape with nowhere to put a third question, and one that had
  // already forgotten the answer to the first by the time it asked the second.
  api.ui.registerFooterButton({
    id: 'export:menu',
    label: 'Export',
    icon: 'download',
    tooltip: 'Export tables of this workspace',
    onClick: (api) => api.ui.openExportDialog(),
  });

  api.ui.registerTableButton({
    id: 'table-export:menu',
    label: 'Export',
    icon: 'file_download',
    tooltip: 'Export this table',
    onClick: (api, ctx) => api.ui.openExportDialog(ctx.tableId ? [ctx.tableId] : []),
  });
}

/**
 * Serializes all tables (and their rows) in the current workspace to the same
 * shape the json-import plugin recognizes as a "native dump". Exported as a
 * side function so tests / future Import dialogs can call it without going
 * through the footer button.
 */
export async function serializeWorkspace(api: HostApi): Promise<string> {
  const wsId = api.workspaceId();
  if (!wsId) throw new Error('dump-export: no active workspace');

  const tables = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  // View templates are workspace-global; instances are per-table. Both travel
  // with the dump so a re-import restores the view windows (not just tables) —
  // matching what the gist sync already carries.
  const viewTemplates = (await api.store.viewTemplates.find()).filter((v) => v.workspaceId === wsId);
  const viewInstances = (await api.store.viewInstances.find()).filter((v) => v.workspaceId === wsId);
  const out: {
    workspaceId: string;
    exportedAt: number;
    tables: unknown[];
    viewTemplates: unknown[];
    viewInstances: unknown[];
  } = {
    workspaceId: wsId,
    exportedAt: Date.now(),
    tables: [],
    viewTemplates,
    viewInstances,
  };

  for (const t of tables) {
    const rows = await api.store.rows(t.id).find();
    out.tables.push({
      name: t.name,
      columns: t.columns,
      rows: rows.map((r) => r.data),
      ...(t.title ? { title: t.title } : {}),
      ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
      ...(t.sortColumn ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true } : {}),
      ...(t.filters ? { filters: t.filters } : {}),
      ...(t.labelColumn ? { labelColumn: t.labelColumn } : {}),
      ...(t.info ? { info: t.info } : {}),
      ...(t.deletedColumns ? { deletedColumns: t.deletedColumns } : {}),
      ...(t.readonly ? { readonly: true } : {}),
      // Carry the backing info so the dump reconstructs a live/refreshable
      // table on another device: `source` = live remote (rows re-pulled from
      // the provider), `origin` = snapshot with a URL it can be refreshed from.
      ...(t.source ? { source: t.source } : {}),
      ...(t.origin ? { origin: t.origin } : {}),
    });
  }

  return JSON.stringify(out, null, 2);
}
