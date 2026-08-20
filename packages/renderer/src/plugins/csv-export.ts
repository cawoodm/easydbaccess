import type { ColumnSpec, ExportContext, ExporterSpec, HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { CSV_EXPORT_DEFAULTS, type CsvExportPanelValue } from './csv-export-options.js';
import './csv-export-options.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'csv-export',
  name: 'CSV Export',
  type: 'exporter',
  version: '0.2.0',
  description: 'CSV serializer and its options panel for the export dialog: separator, header row, byte-order mark, typed header, line ends.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/csv-export.ts',
};

const exporterSpec: ExporterSpec = {
  id: 'csv',
  label: 'CSV',
  extension: '.csv',
  mimeType: 'text/csv',
  icon: 'table_chart',
  order: 10,
  panel: 'csv-export-options',
  serialize(table, rows, ctx) {
    return serializeCsv(table, rows, panelOf(ctx));
  },
};

export function init(api: HostApi): void {
  api.ui.registerExporter(exporterSpec);
  // No button of its own: the export dialog lists every registered format, and
  // the buttons that open it live in `dump-export.ts`.
}

function panelOf(ctx: ExportContext | undefined): CsvExportPanelValue {
  const raw = (ctx?.panel ?? {}) as Partial<CsvExportPanelValue>;
  return { ...CSV_EXPORT_DEFAULTS, ...raw };
}

/**
 * RFC-4180-ish writer that mirrors the parser shipped by the csv-import plugin:
 * double-quote escaping for any cell holding the separator, a quote or a newline.
 *
 * `opts` is optional so the callers that predate the export dialog — and any
 * plugin holding the two-argument shape — still get the original defaults: comma,
 * CRLF, a plain header row, no byte-order mark.
 */
export function serializeCsv(table: Table, rows: Row[], opts?: Partial<CsvExportPanelValue>): string {
  const o = { ...CSV_EXPORT_DEFAULTS, ...(opts ?? {}) };
  const sep = o.separator || ',';
  const eol = o.crlf ? '\r\n' : '\n';
  const fields = table.columns.map((c) => c.field);
  const lines: string[] = [];
  if (o.header) {
    const cells = table.columns.map((c) => (o.typedHeader ? typedHeaderCell(c) : (c.label ?? c.field)));
    lines.push(cells.map((c) => quoteIfNeeded(c, sep)).join(sep));
  }
  for (const r of rows) {
    lines.push(fields.map((f) => quoteIfNeeded(stringify(r.data[f]), sep)).join(sep));
  }
  return (o.bom ? '﻿' : '') + lines.join(eol);
}

/**
 * One header cell in csv-import's header mini-language, so a re-import restores
 * the column instead of inferring it: `field:label:type:default:max:flags`.
 *
 * Trailing empty parts are dropped — `name:Name:string` reads better than
 * `name:Name:string:::` and parses identically. A label holding a colon would
 * break the grammar on the way back in, so such a label is left out and the
 * field name carries the column.
 */
export function typedHeaderCell(c: ColumnSpec): string {
  const flags = `${c.unique ? 'u' : ''}${c.notnull ? 'n' : ''}${c.hidden ? 'h' : ''}`;
  const label = (c.label ?? '').includes(':') ? '' : (c.label ?? '');
  const parts = [c.field, label, c.type ?? '', c.default == null ? '' : String(c.default), c.max == null ? '' : String(c.max), flags];
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.join(':');
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return JSON.stringify(v);
}

function quoteIfNeeded(s: string, sep: string): string {
  if (s === '') return '';
  // The separator is part of the test, not a hard-coded comma: with `;` chosen, a
  // cell holding a comma needs no quotes, and one holding a semicolon does.
  if (s.includes(sep) || /["\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
