import type { ExporterSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'csv-export',
  version: '0.1.0',
  description: 'Export a single table as a .csv file via a per-table button.',
  author: 'easyDBAccess built-ins',
};

const exporterSpec: ExporterSpec = {
  id: 'csv',
  label: 'CSV',
  extension: '.csv',
  async serialize(table, rows) {
    return serializeCsv(table, rows);
  },
};

export function init(api: HostApi): void {
  api.ui.registerExporter(exporterSpec);
  api.ui.registerTableButton({
    id: 'csv-export:download',
    label: 'CSV',
    tooltip: 'Download this table as a .csv file',
    onClick: async (host, ctx) => {
      const t = await host.store.tables.findOne(ctx.tableId);
      if (!t) return;
      const rows = await host.store.rows(t.id).find();
      const text = serializeCsv(t, rows);
      await host.backend.saveFile(`${t.code || t.name || 'table'}.csv`, text, 'text/csv');
    },
  });
}

/**
 * RFC-4180-ish writer that mirrors the parser shipped by the csv-import
 * plugin: comma delimiter, CRLF line terminators, double-quote escaping for
 * any cell that contains a comma, quote, or newline.
 */
export function serializeCsv(table: Table, rows: Row[]): string {
  const fields = table.columns.map((c) => c.field);
  const header = table.columns.map((c) => quoteIfNeeded(c.label ?? c.field));
  const body = rows.map((r) =>
    fields.map((f) => quoteIfNeeded(stringify(r.data[f]))).join(','),
  );
  return [header.join(','), ...body].join('\r\n');
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return JSON.stringify(v);
}

function quoteIfNeeded(s: string): string {
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
