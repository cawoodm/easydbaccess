// packages/renderer/src/plugins/json-export.ts
//
// JSON as a format PLUGIN, so the export dialog offers it from the registry
// instead of `dump-export.ts` hard-coding it in a menu.
//
// Two shapes, and the difference is not cosmetic: one table becomes a
// `.table.json` — the shape `json-import` reads as a single table, and the shape
// the Gist sync writes — while several tables become one `.db.json` dump with the
// workspace's view templates and instances beside them. `serializeMany` is what
// says a format HAS a several-tables shape; CSV has none, so the dialog writes a
// file per table there.

import type { ExportContext, ExportItem, ExporterSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { tableToFile } from '../export/table-file.js';
import './json-export-options.js';
import { JSON_EXPORT_DEFAULTS, type JsonExportPanelValue } from './json-export-options.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'json-export',
  name: 'JSON Export',
  type: 'exporter',
  version: '0.1.0',
  description: 'JSON serializer for the export dialog: one table as .table.json, several as a .db.json dump that can carry the workspace views.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/json-export.ts',
};

const exporterSpec: ExporterSpec = {
  id: 'json',
  label: 'JSON',
  extension: '.json',
  mimeType: 'application/json',
  icon: 'data_object',
  order: 20,
  panel: 'json-export-options',
  serialize(table, rows, ctx) {
    return stringify(tableToFile(table, rows), panelOf(ctx));
  },
  async serializeMany(items, ctx) {
    return stringify(await workspaceDump(items, ctx), panelOf(ctx));
  },
  manyBaseName(_items, ctx) {
    return `workspace-${ctx.api.workspaceId()}`;
  },
};

export function init(api: HostApi): void {
  api.ui.registerExporter(exporterSpec);
}

function panelOf(ctx: ExportContext | undefined): JsonExportPanelValue {
  const raw = (ctx?.panel ?? {}) as Partial<JsonExportPanelValue>;
  return { ...JSON_EXPORT_DEFAULTS, ...raw };
}

function stringify(value: unknown, opts: JsonExportPanelValue): string {
  return opts.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * The `.db.json` dump: the chosen tables, plus the workspace's view templates and
 * instances when asked for.
 *
 * The instances are narrowed to the tables being written. A view instance names
 * the table it reads, so shipping one whose table is not in the file would restore
 * a window bound to nothing.
 */
async function workspaceDump(items: ExportItem[], ctx: ExportContext): Promise<Record<string, unknown>> {
  const opts = panelOf(ctx);
  const api = ctx.api;
  const wsId = api.workspaceId();
  const out: Record<string, unknown> = {
    workspaceId: wsId,
    exportedAt: Date.now(),
    tables: items.map((i) => dumpTable(i.table, i.rows)),
  };
  if (opts.includeViews) {
    const ids = new Set(items.map((i) => i.table.id));
    out.viewTemplates = (await api.store.viewTemplates.find()).filter((v) => v.workspaceId === wsId);
    out.viewInstances = (await api.store.viewInstances.find()).filter((v) => v.workspaceId === wsId && ids.has(v.tableId));
  }
  return out;
}

/**
 * One table in the dump. The same fields `serializeWorkspace` wrote, so an older
 * dump and a new one read identically on the way back in — `json-import` is the
 * other half of this contract and was not changed.
 */
function dumpTable(t: Table, rows: Row[]): Record<string, unknown> {
  return {
    name: t.name,
    columns: t.columns,
    rows: rows.map((r) => {
      // Projected onto the columns being exported, not the raw `data` blob: a
      // deleted column's values stay in `data` and would otherwise travel with
      // the file, which is how a 2 MB table once measured 32 MB on push.
      const projected: Record<string, unknown> = {};
      for (const c of t.columns) projected[c.field] = r.data[c.field];
      return projected;
    }),
    ...(t.title ? { title: t.title } : {}),
    ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
    ...(t.sortColumn ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true } : {}),
    ...(t.filters ? { filters: t.filters } : {}),
    ...(t.labelColumn ? { labelColumn: t.labelColumn } : {}),
    ...(t.info ? { info: t.info } : {}),
    ...(t.deletedColumns ? { deletedColumns: t.deletedColumns } : {}),
    ...(t.readonly ? { readonly: true } : {}),
    ...(t.source ? { source: t.source } : {}),
    ...(t.origin ? { origin: t.origin } : {}),
  };
}
