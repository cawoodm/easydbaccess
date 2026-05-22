import type {
  ColumnSpec,
  ColumnType,
  HostApi,
  ImporterSpec,
  PluginModule,
} from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'csv-import',
  version: '0.1.0',
  description: 'Drag-and-drop CSV files to create typed tables.',
  author: 'easyDBAccess built-ins',
};

export function init(api: HostApi): void {
  api.ui.registerImporter(importerSpec);
  api.ui.registerHeaderButton({
    id: 'csv-import:paste',
    label: 'Paste CSV',
    icon: 'content_paste',
    tooltip: 'Paste CSV text to create a new table',
    onClick: () => api.ui.openCsvPasteDialog(),
  });
  api.ui.registerDropHandler(async (event) => {
    const files = filesFrom(event);
    const csvs = files.filter(isCsv);
    if (csvs.length === 0) return false;

    event.preventDefault();
    for (const file of csvs) {
      await importCsvFile(api, file);
    }
    return true;
  });
}

// -- Importer spec (for non-drop call sites: future Import dialog, URL sources) --

const importerSpec: ImporterSpec = {
  id: 'csv',
  label: 'CSV',
  accept: ['.csv', 'text/csv'],
  async parse(input) {
    const text = typeof input === 'string' ? input : await input.text();
    return parseCsv(text);
  },
};

// -- Core: turn one File into a Table + Rows ----------------------------------

async function importCsvFile(api: HostApi, file: File): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('csv-import: no active workspace');

  const text = await file.text();
  const parsed = parseCsv(text);
  const baseName = file.name.replace(/\.csv$/i, '') || 'imported';

  // If a table with this name already exists in the workspace, ask the user
  // what to do: append rows, overwrite (clear + insert), or create a new
  // table under a unique name.
  const existing = (await api.store.tables.find()).find(
    (t) => t.workspaceId === workspaceId && t.name === baseName,
  );

  let targetId: string;
  let mode: 'new' | 'append' | 'overwrite';

  if (existing) {
    const choice = await api.ui.dialogs.choice(
      `A table named "${baseName}" already exists in this workspace.`,
      ['Append rows', 'Overwrite rows', 'Create as new table'],
      'CSV import',
    );
    if (!choice) return; // cancelled
    if (choice === 'Append rows') {
      mode = 'append';
      targetId = existing.id;
    } else if (choice === 'Overwrite rows') {
      mode = 'overwrite';
      targetId = existing.id;
    } else {
      mode = 'new';
      targetId = cryptoUUID();
    }
  } else {
    mode = 'new';
    targetId = cryptoUUID();
  }

  api.events.emit('import:before', { source: 'csv', tableId: targetId });

  if (mode === 'new') {
    const uniqueName =
      mode === 'new' && existing ? `${baseName} (${Date.now().toString(36)})` : baseName;
    await api.store.tables.insert({
      id: targetId,
      workspaceId,
      name: uniqueName,
      code: slug(uniqueName),
      columns: parsed.columns,
      view: 'table',
      updatedAt: Date.now(),
    });
  } else if (mode === 'overwrite') {
    // Wipe existing rows; keep the table id so its panel position is preserved.
    const old = await api.store.rows(targetId).find();
    for (const r of old) await api.store.rows(targetId).remove(r.id);
    // Replace columns with the imported shape so types match the new data.
    await api.store.tables.patch(targetId, {
      columns: parsed.columns,
      updatedAt: Date.now(),
    });
  }
  // mode === 'append' just adds rows; existing columns kept.

  const rowColl = api.store.rows(targetId);
  const docs = parsed.rows.map((row) => ({
    id: cryptoUUID(),
    tableId: targetId,
    data: row,
    updatedAt: Date.now(),
  }));
  await rowColl.bulkInsert(docs);

  api.events.emit('import:after', {
    source: 'csv',
    tableId: targetId,
    rowCount: parsed.rows.length,
  });
}

// -- Parser -------------------------------------------------------------------

interface ParseResult {
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
}

export function parseCsv(text: string): ParseResult {
  const normalized = text.replace(/﻿/, ''); // strip BOM
  const sep = detectSeparator(normalized);
  const rows = parseLines(normalized, sep);
  if (rows.length === 0) return { columns: [], rows: [] };

  const header = rows[0]!;
  const dataRows = rows.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));

  const fields = header.map((h, i) => slug(h || `col_${i + 1}`));
  const labels = header.map((h, i) => h || `Column ${i + 1}`);

  // Build raw rows keyed by field, then infer types from raw string values.
  const rawRows: Array<Record<string, string>> = dataRows.map((cells) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i++) {
      obj[fields[i]!] = cells[i] ?? '';
    }
    return obj;
  });

  const types: ColumnType[] = fields.map((f) =>
    inferType(rawRows.map((r) => r[f] ?? '').filter((v) => v.length > 0)),
  );

  const columns: ColumnSpec[] = fields.map((field, i) => ({
    field,
    label: labels[i] ?? field,
    type: types[i] ?? 'string',
  }));

  const coercedRows: Array<Record<string, unknown>> = rawRows.map((raw) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const type = types[i] ?? 'string';
      out[field] = coerce(raw[field] ?? '', type);
    }
    return out;
  });

  return { columns, rows: coercedRows };
}

function detectSeparator(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 } as Record<string, number>;
  for (const ch of sample) {
    if (ch in counts) counts[ch]! += 1;
  }
  let best: string = ',';
  let bestCount = -1;
  for (const sep of [',', ';', '\t']) {
    if ((counts[sep] ?? 0) > bestCount) {
      best = sep;
      bestCount = counts[sep] ?? 0;
    }
  }
  return best;
}

/** RFC-4180-ish line tokenizer. Returns array of rows; each row is an array of cells. */
function parseLines(text: string, sep: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        out.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

// -- Type inference + coercion ------------------------------------------------

function inferType(samples: string[]): ColumnType {
  if (samples.length === 0) return 'string';
  if (samples.every(isBool)) return 'boolean';
  if (samples.every(isNumber)) return 'number';
  if (samples.every(isDate)) return 'date';
  return 'string';
}

const BOOL_RE = /^(true|false|yes|no|0|1)$/i;
function isBool(s: string): boolean {
  return BOOL_RE.test(s.trim());
}

function isNumber(s: string): boolean {
  const t = s.trim();
  if (t === '') return false;
  const n = Number(t);
  return Number.isFinite(n);
}

function isDate(s: string): boolean {
  const t = s.trim();
  if (t === '' || /^\d+$/.test(t)) return false; // bare integers are not dates
  const d = new Date(t);
  return !Number.isNaN(d.getTime());
}

function coerce(raw: string, type: ColumnType): unknown {
  const s = raw.trim();
  switch (type) {
    case 'number': {
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    case 'boolean':
      if (s === '') return null;
      return /^(true|yes|1)$/i.test(s);
    case 'date':
      return s;
    default:
      return raw;
  }
}

// -- helpers ------------------------------------------------------------------

function filesFrom(event: DragEvent): File[] {
  const dt = event.dataTransfer;
  if (!dt) return [];
  if (dt.files && dt.files.length > 0) return Array.from(dt.files);
  if (dt.items) {
    const out: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }
  return [];
}

function isCsv(file: File): boolean {
  if (/\.csv$/i.test(file.name)) return true;
  if (file.type === 'text/csv' || file.type === 'application/csv') return true;
  return false;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_') || 'col';
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
