import type {
  ColumnSpec,
  ColumnType,
  HostApi,
  ImporterSpec,
  PluginModule,
  WindowGeometry,
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
  await importJsonText(api, await file.text(), file.name);
}

/**
 * Imports a JSON dump given its text body and a source filename. Used by both
 * the drag-and-drop path and the sample-data plugin's URL fetch path. Behavior
 * is identical: parse → detect shape → prompt user on collisions → write.
 */
export async function importJsonText(
  api: HostApi,
  text: string,
  filename: string,
): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('json-import: no active workspace');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    api.events.emit('plugin:error', {
      url: 'json-import',
      phase: 'runtime',
      error: new Error(`Invalid JSON in ${filename}: ${(err as Error).message}`),
    });
    return;
  }

  const baseName = filename.replace(/\.db\.json$/i, '').replace(/\.json$/i, '') || 'imported';
  const tables = parsedToTables(parsed, baseName);
  if (tables.length === 0) return;

  // If any imported table name overlaps an existing one OR this is clearly a
  // multi-table dump, ask the user how to resolve. Single-table imports with
  // no name collision skip the prompt.
  const existing = (await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId);
  const incomingNames = new Set(tables.map((t) => t.name));
  const collisions = existing.filter((t) => incomingNames.has(t.name));

  let mode: 'overwrite-matching' | 'replace-workspace' | 'append-new';
  if (collisions.length === 0 && tables.length === 1) {
    mode = 'append-new';
  } else {
    const opts = collisions.length > 0
      ? [
          `Overwrite matching (${collisions.length})`,
          'Replace entire workspace',
          'Add as new tables',
        ]
      : ['Add to current workspace', 'Replace entire workspace'];
    const choice = await api.ui.dialogs.choice(
      `Importing ${tables.length} table${tables.length === 1 ? '' : 's'} from "${filename}".${
        collisions.length > 0
          ? `\n\n${collisions.length} table${collisions.length === 1 ? '' : 's'} share a name with existing data.`
          : ''
      }`,
      opts,
      'JSON import',
    );
    if (!choice) return; // cancelled
    if (choice.startsWith('Overwrite matching')) mode = 'overwrite-matching';
    else if (choice === 'Replace entire workspace') mode = 'replace-workspace';
    else mode = 'append-new';
  }

  if (mode === 'replace-workspace') {
    for (const t of existing) {
      const rs = await api.store.rows(t.id).find();
      for (const r of rs) await api.store.rows(t.id).remove(r.id);
      await api.store.tables.remove(t.id);
    }
  }

  const existingByName = new Map(existing.map((t) => [t.name, t] as const));
  for (const t of tables) {
    let tableId: string;
    const match = mode === 'overwrite-matching' ? existingByName.get(t.name) : undefined;
    if (match) {
      // Overwrite: keep the id (and thus its panel position) but wipe rows
      // and replace columns + sort + geometry from the import.
      tableId = match.id;
      const oldRows = await api.store.rows(tableId).find();
      for (const r of oldRows) await api.store.rows(tableId).remove(r.id);
      await api.store.tables.patch(tableId, {
        columns: t.columns,
        ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
        ...(t.sortColumn
          ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true }
          : { sortColumn: undefined, sortAsc: undefined }),
        updatedAt: Date.now(),
      });
    } else {
      tableId = cryptoUUID();
      api.events.emit('import:before', { source: 'json', tableId });
      await api.store.tables.insert({
        id: tableId,
        workspaceId,
        name: t.name,
        code: slug(t.name),
        columns: t.columns,
        view: 'table',
        ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
        ...(t.sortColumn ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true } : {}),
        updatedAt: Date.now(),
      });
    }

    const rowColl = api.store.rows(tableId);
    const docs = t.rows.map((row) => ({
      id: cryptoUUID(),
      tableId,
      data: row,
      updatedAt: Date.now(),
    }));
    await rowColl.bulkInsert(docs);

    api.events.emit('import:after', {
      source: 'json',
      tableId,
      rowCount: t.rows.length,
    });
  }
}

// -- Shape detection ----------------------------------------------------------

interface NormalizedTable {
  name: string;
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
  windowGeometry?: WindowGeometry;
  sortColumn?: string;
  sortAsc?: boolean;
}

/** Recognize known shapes; fall back to single-row import for unknown objects. */
export function parsedToTables(parsed: unknown, fallbackName: string): NormalizedTable[] {
  // Shape: { "<Name>.table.json": { dataArray, columns, elementRect, ... } }
  // — minniDBMax v1 / legacy dump format. Detected first because it overlaps
  // structurally with the generic-object fallback below.
  if (isObject(parsed) && looksLikeV1Dump(parsed as Record<string, unknown>)) {
    return convertV1Dump(parsed as Record<string, unknown>);
  }

  // Shape: { tables: [{ name, columns, rows }, ...] }  — native dump.
  // Entries may also be v1-shaped wrappers ({ "<name>.table.json": { dataArray, columns } })
  // — happens when a v1 file was Dumped through us before v1 detection landed.
  if (
    isObject(parsed) &&
    Array.isArray((parsed as { tables?: unknown }).tables)
  ) {
    const dump = parsed as { tables: unknown[] };
    const out: NormalizedTable[] = [];
    for (const entry of dump.tables) {
      if (isNativeTable(entry)) {
        const e = entry as Record<string, unknown>;
        const geom = isObject(e.windowGeometry)
          ? (e.windowGeometry as WindowGeometry)
          : undefined;
        const sortColumn = typeof e.sortColumn === 'string' ? e.sortColumn : undefined;
        const sortAsc = typeof e.sortAsc === 'boolean' ? e.sortAsc : undefined;
        out.push({
          name: String(entry.name),
          columns: entry.columns.map(normalizeColumn),
          rows: Array.isArray(entry.rows)
            ? (entry.rows.filter(isObject) as Array<Record<string, unknown>>)
            : [],
          ...(geom ? { windowGeometry: geom } : {}),
          ...(sortColumn ? { sortColumn, sortAsc: sortAsc ?? true } : {}),
        });
        continue;
      }
      if (isObject(entry) && looksLikeV1Dump(entry as Record<string, unknown>)) {
        out.push(...convertV1Dump(entry as Record<string, unknown>));
      }
    }
    return out;
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

// -- v1 / legacy minniDBMax dump format --------------------------------------

interface V1Column {
  field: string;
  name?: string; // v1 calls the label "name"
  type?: string;
  isUnique?: boolean;
  isNotNull?: boolean;
}

interface V1Table {
  dataArray: unknown[][]; // positional rows aligned with `columns`
  columns: V1Column[];
  elementRect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    zIndex?: number;
    minimized?: boolean;
    maximized?: boolean;
  };
  sortColumn?: number; // index into columns, or -1 for none
  sortDirection?: 'asc' | 'desc';
}

function looksLikeV1Dump(obj: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (!/\.table\.json$/.test(k)) continue;
    if (!isObject(v)) continue;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.dataArray) && Array.isArray(o.columns)) return true;
  }
  return false;
}

function convertV1Dump(obj: Record<string, unknown>): NormalizedTable[] {
  const out: NormalizedTable[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (!/\.table\.json$/.test(key)) continue;
    if (!isObject(raw)) continue;
    const t = raw as unknown as V1Table;
    if (!Array.isArray(t.dataArray) || !Array.isArray(t.columns)) continue;

    const name = key.replace(/\.table\.json$/, '');
    const columns: ColumnSpec[] = t.columns.map((c) => normalizeV1Column(c));
    const fields = columns.map((c) => c.field);

    // dataArray rows are positional arrays aligned with the columns array.
    // Translate each into a field-keyed row object.
    const rows: Array<Record<string, unknown>> = t.dataArray
      .filter((r) => Array.isArray(r))
      .map((r) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < fields.length; i++) {
          obj[fields[i]!] = (r as unknown[])[i];
        }
        return obj;
      });

    const nt: NormalizedTable = { name, columns, rows };
    if (t.elementRect && typeof t.elementRect.x === 'number' && typeof t.elementRect.y === 'number') {
      // Only honor the saved geometry when both x/y are present. Without an
      // actual position from the dump, leave windowGeometry unset so the
      // window manager cascades the new panel instead of stacking it at 0,0.
      const r = t.elementRect as { x: number; y: number; width?: number; height?: number; zIndex?: number; minimized?: boolean; maximized?: boolean };
      nt.windowGeometry = {
        x: r.x,
        y: r.y,
        w: r.width ?? 600,
        h: r.height ?? 400,
        z: r.zIndex ?? 100,
        minimized: !!r.minimized,
        maximized: !!r.maximized,
      };
    }
    if (typeof t.sortColumn === 'number' && t.sortColumn >= 0 && t.sortColumn < fields.length) {
      nt.sortColumn = fields[t.sortColumn]!;
      nt.sortAsc = (t.sortDirection ?? 'asc') !== 'desc';
    }
    out.push(nt);
  }
  return out;
}

function normalizeV1Column(c: V1Column): ColumnSpec {
  const field = String(c.field ?? 'col');
  const label = String(c.name ?? field);
  const t = (typeof c.type === 'string' ? c.type : 'string') as ColumnType;
  const spec: ColumnSpec = { field, label, type: t };
  if (c.isUnique) spec.unique = true;
  if (c.isNotNull) spec.notnull = true;
  return spec;
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
  let type: ColumnType = (typeof o.type === 'string' ? o.type : 'string') as ColumnType;
  let renderer = typeof o.renderer === 'string' ? o.renderer : undefined;
  // Pre-v3 dumps stored color/image as column types rather than renderers.
  // Rewrite on the way in so newly-imported tables match today's shape.
  if ((type as string) === 'color' || (type as string) === 'image') {
    renderer = renderer ?? (type as string);
    type = 'string';
  }
  const spec: ColumnSpec = {
    field,
    label: String(o.label ?? field),
    type,
  };
  if (renderer) spec.renderer = renderer;
  return spec;
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
