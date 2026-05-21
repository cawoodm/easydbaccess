import type {
  ColumnSpec,
  ColumnType,
  HostApi,
  ImporterSpec,
  PluginModule,
} from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'json-import',
  version: '0.1.0',
  description: 'Drag-and-drop JSON to create tables. Supports native dumps and arrays of objects.',
  author: 'easyDBAccess built-ins',
};

export function init(api: HostApi): void {
  api.ui.registerImporter(importerSpec);
  api.ui.registerDropHandler(async (event) => {
    const files = filesFrom(event);
    const jsons = files.filter(isJson);
    if (jsons.length === 0) return false;

    event.preventDefault();
    for (const file of jsons) {
      await importJsonFile(api, file);
    }
    return true;
  });
}

// -- Importer spec ------------------------------------------------------------

const importerSpec: ImporterSpec = {
  id: 'json',
  label: 'JSON',
  accept: ['.json', '.db.json', 'application/json'],
  async parse(input) {
    const text = typeof input === 'string' ? input : await input.text();
    const parsed = JSON.parse(text);
    const tables = parsedToTables(parsed, 'imported');
    const first = tables[0];
    return {
      columns: first?.columns ?? [],
      rows: first?.rows ?? [],
    };
  },
};

// -- Core: file -> Tables -----------------------------------------------------

async function importJsonFile(api: HostApi, file: File): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('json-import: no active workspace');

  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    api.events.emit('plugin:error', {
      url: 'json-import',
      phase: 'runtime',
      error: new Error(`Invalid JSON in ${file.name}: ${(err as Error).message}`),
    });
    return;
  }

  const baseName = file.name.replace(/\.db\.json$/i, '').replace(/\.json$/i, '') || 'imported';
  const tables = parsedToTables(parsed, baseName);

  for (const t of tables) {
    const tableId = cryptoUUID();
    api.events.emit('import:before', { source: 'json', tableId });

    const created = await api.store.tables.insert({
      id: tableId,
      workspaceId,
      name: t.name,
      code: slug(t.name),
      columns: t.columns,
      view: 'table',
      updatedAt: Date.now(),
    });

    const rowColl = api.store.rows(created.id);
    for (const row of t.rows) {
      await rowColl.insert({
        id: cryptoUUID(),
        tableId: created.id,
        data: row,
        updatedAt: Date.now(),
      });
    }

    api.events.emit('import:after', {
      source: 'json',
      tableId: created.id,
      rowCount: t.rows.length,
    });
  }
}

// -- Shape detection ----------------------------------------------------------

interface NormalizedTable {
  name: string;
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
}

/** Recognize known shapes; fall back to single-row import for unknown objects. */
export function parsedToTables(parsed: unknown, fallbackName: string): NormalizedTable[] {
  // Shape: { tables: [{ name, columns, rows }, ...] }  — native dump
  if (
    isObject(parsed) &&
    Array.isArray((parsed as { tables?: unknown }).tables)
  ) {
    const dump = parsed as { tables: unknown[] };
    return dump.tables
      .filter(isNativeTable)
      .map((t) => ({
        name: String(t.name),
        columns: t.columns.map(normalizeColumn),
        rows: Array.isArray(t.rows) ? t.rows.filter(isObject) as Array<Record<string, unknown>> : [],
      }));
  }

  // Shape: [{...}, {...}]  — array of objects, infer columns from union of keys
  if (Array.isArray(parsed)) {
    const rows = parsed.filter(isObject) as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];
    return [{ name: fallbackName, ...inferTableFromRows(rows) }];
  }

  // Shape: {...}  — single object, treat as one row
  if (isObject(parsed)) {
    const obj = parsed as Record<string, unknown>;
    return [{ name: fallbackName, ...inferTableFromRows([obj]) }];
  }

  return [];
}

function isNativeTable(v: unknown): v is { name: unknown; columns: unknown[]; rows?: unknown } {
  return (
    isObject(v) &&
    'name' in v &&
    'columns' in v &&
    Array.isArray((v as { columns: unknown }).columns)
  );
}

function normalizeColumn(c: unknown): ColumnSpec {
  if (!isObject(c)) return { field: 'col', label: 'Col', type: 'string' };
  const o = c as Record<string, unknown>;
  const field = String(o.field ?? 'col');
  return {
    field,
    label: String(o.label ?? field),
    type: (typeof o.type === 'string' ? o.type : 'string') as ColumnType,
  };
}

// -- Column inference for array-of-objects ------------------------------------

function inferTableFromRows(rows: Array<Record<string, unknown>>): {
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
} {
  const fields = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) fields.add(k);
  const order = Array.from(fields);

  const columns: ColumnSpec[] = order.map((field) => ({
    field,
    label: field,
    type: inferTypeFromValues(rows.map((r) => r[field])),
  }));

  return { columns, rows };
}

function inferTypeFromValues(values: unknown[]): ColumnType {
  const samples = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (samples.length === 0) return 'string';
  if (samples.every((v) => typeof v === 'boolean')) return 'boolean';
  if (samples.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'number';
  if (samples.every((v) => typeof v === 'string' && isDateString(v))) return 'date';
  return 'string';
}

function isDateString(s: string): boolean {
  if (/^\d+$/.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

// -- helpers ------------------------------------------------------------------

function isObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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

function isJson(file: File): boolean {
  if (/\.json$/i.test(file.name)) return true;
  if (file.type === 'application/json') return true;
  return false;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
