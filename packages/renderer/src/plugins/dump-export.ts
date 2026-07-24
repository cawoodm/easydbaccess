import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'dump-export',
  version: '0.1.0',
  description: 'Export the current workspace as a single .db.json dump file.',
  author: 'easyDBAccess built-ins',
};

export function init(api: HostApi): void {
  api.ui.registerFooterButton({
    id: 'dump-export:dump',
    label: 'Dump',
    icon: 'archive',
    tooltip: 'Export the current workspace as a JSON dump file',
    onClick: async () => {
      const wsId = api.workspaceId();
      if (!wsId) return;
      const text = await serializeWorkspace(api);
      await api.backend.saveFile(`workspace-${wsId}.db.json`, text, 'application/json');
    },
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
  const out: { workspaceId: string; exportedAt: number; tables: unknown[] } = {
    workspaceId: wsId,
    exportedAt: Date.now(),
    tables: [],
  };

  for (const t of tables) {
    const rows = await api.store.rows(t.id).find();
    out.tables.push({
      name: t.name,
      columns: t.columns,
      rows: rows.map((r) => r.data),
      ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
      ...(t.sortColumn ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true } : {}),
      // Carry the backing info so the dump reconstructs a live/refreshable
      // table on another device: `source` = live remote (rows re-pulled from
      // the provider), `origin` = snapshot with a URL it can be refreshed from.
      ...(t.source ? { source: t.source } : {}),
      ...(t.origin ? { origin: t.origin } : {}),
    });
  }

  return JSON.stringify(out, null, 2);
}
