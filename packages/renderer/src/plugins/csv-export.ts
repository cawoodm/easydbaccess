import type { ExporterSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'csv-export',
  name: 'CSV Export',
  type: 'exporter',
  version: '0.1.0',
  description: 'CSV serializer for the per-table export menu (see dump-export.ts) and the importer/exporter registry.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/csv-export.ts',
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
  // The per-table footer button now lives in dump-export.ts's consolidated
  // "Export" menu (CSV / JSON / SQL, each with a Raw vs. Visible Data prompt)
  // — this plugin only supplies the CSV serializer.
}

/**
 * RFC-4180-ish writer that mirrors the parser shipped by the csv-import
 * plugin: comma delimiter, CRLF line terminators, double-quote escaping for
 * any cell that contains a comma, quote, or newline.
 */
export function serializeCsv(table: Table, rows: Row[]): string {
  const fields = table.columns.map((c) => c.field);
  const header = table.columns.map((c) => quoteIfNeeded(c.label ?? c.field));
  const body = rows.map((r) => fields.map((f) => quoteIfNeeded(stringify(r.data[f]))).join(','));
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
