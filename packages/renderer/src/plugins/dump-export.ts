import type { HostApi, PluginModule } from '@easydb/shared';
import { serializeCsv } from './csv-export.js';
import { serializeWorkspaceAsSql, serializeTableAsSql } from './sql-export.js';
import { slug } from './server-sync-core.js';
import { scopedRows, scopedTable, tableToFile, type ExportScope } from '../export/table-file.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'dump-export',
  name: 'Dump Export',
  type: 'exporter',
  version: '0.1.0',
  description:
    'Export the current workspace as a single .db.json dump file, and — per table — CSV/JSON/SQL with a Raw vs. Visible Data choice.',
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

  api.ui.registerTableButton({
    id: 'table-export:menu',
    label: 'Export',
    icon: 'file_download',
    tooltip: 'Export this table as CSV, JSON, or SQL',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect =
        ctx.anchor?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 48, 0, 0);
      const format = await AnchoredMenu.open(rect, [
        { id: 'csv', label: 'CSV (.csv)', icon: 'table_chart' },
        { id: 'json', label: 'JSON (.table.json)', icon: 'data_object' },
        { id: 'sql', label: 'SQL (.sql)', icon: 'storage' },
      ]);
      if (!format) return;

      const table = await api.store.tables.findOne(ctx.tableId);
      if (!table) return;

      // 'Visible Data' is listed FIRST and is therefore the dialog's default
      // (primary/focused/Enter-activated) choice — it's the more common intent.
      const scopeChoice = await api.ui.dialogs.choice(
        `Export "${table.name}" as ${format.toUpperCase()} — which rows/columns?`,
        ['Visible Data', 'Raw Data'],
        'Export table',
      );
      if (!scopeChoice) return;
      const scope: ExportScope = scopeChoice === 'Visible Data' ? 'visible' : 'raw';

      try {
        const allRows = await api.store.rows(table.id).find();
        const t = scopedTable(table, scope);
        const rows = scopedRows(table, allRows, scope);
        const base = slug(table.code || table.name || 'table');
        const isEmptyLiveTable = table.source != null && allRows.length === 0;

        if (format === 'csv') {
          if (isEmptyLiveTable) {
            api.ui.dialogs.toast(
              `"${table.name}" is a live table with no local rows — exporting column definitions only.`,
              { kind: 'warning', title: 'Export' },
            );
          }
          await api.backend.saveFile(`${base}.csv`, serializeCsv(t, rows), 'text/csv');
        } else if (format === 'json') {
          // tableToFile itself forces rows:[] for a remote table (source != null)
          // — the file is a portable DEFINITION that reconnects/re-fetches live
          // data on pull, never a stale snapshot of it.
          const text = JSON.stringify(tableToFile(t, rows), null, 2);
          await api.backend.saveFile(`${base}.table.json`, text, 'application/json');
        } else if (format === 'sql') {
          if (isEmptyLiveTable) {
            api.ui.dialogs.toast(
              `"${table.name}" is a live table with no local rows — exporting the CREATE TABLE only.`,
              { kind: 'warning', title: 'Export' },
            );
          }
          await api.backend.saveFile(`${base}.sql`, serializeTableAsSql(t, rows), 'application/sql');
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
  // View templates are workspace-global; instances are per-table. Both travel
  // with the dump so a re-import restores the view windows (not just tables) —
  // matching what the gist sync already carries.
  const viewTemplates = (await api.store.viewTemplates.find()).filter(
    (v) => v.workspaceId === wsId,
  );
  const viewInstances = (await api.store.viewInstances.find()).filter(
    (v) => v.workspaceId === wsId,
  );
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
      // Carry the backing info so the dump reconstructs a live/refreshable
      // table on another device: `source` = live remote (rows re-pulled from
      // the provider), `origin` = snapshot with a URL it can be refreshed from.
      ...(t.source ? { source: t.source } : {}),
      ...(t.origin ? { origin: t.origin } : {}),
    });
  }

  return JSON.stringify(out, null, 2);
}
