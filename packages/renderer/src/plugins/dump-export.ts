import type { HostApi, PluginModule } from '@easydb/shared';
import { serializeWorkspaceAsSql } from './sql-export.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'dump-export',
  name: 'Dump Export',
  type: 'exporter',
  version: '0.1.0',
  description: 'Export the current workspace as a single .db.json dump file.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/dump-export.ts',
};

export function init(api: HostApi): void {
  api.ui.registerFooterButton({
    id: 'export:menu',
    label: 'Export',
    icon: 'download',
    tooltip: 'Export the current workspace (JSON or SQL)',
    onClick: async (api, ctx) => {
      const wsId = api.workspaceId();
      if (!wsId) return;
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect =
        ctx?.anchor?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'json', label: 'JSON dump (.db.json)', icon: 'data_object' },
        { id: 'sql', label: 'SQL script (.sql)', icon: 'storage' },
      ]);
      if (!choice) return;
      try {
        if (choice === 'json') {
          const text = await serializeWorkspace(api);
          await api.backend.saveFile(`workspace-${wsId}.db.json`, text, 'application/json');
        } else if (choice === 'sql') {
          const text = await serializeWorkspaceAsSql(api);
          await api.backend.saveFile(`workspace-${wsId}.sql`, text, 'application/sql');
        }
      } catch (err) {
        api.ui.dialogs.toast(`Export failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Export',
        });
      }
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
