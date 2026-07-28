import type {
  ColumnSpec,
  ColumnType,
  HostApi,
  ImporterSpec,
  ImportSourceInput,
  PluginModule,
  TableInfo,
  TableOrigin,
  TableSource,
  ViewInstance,
  ViewTemplate,
  WindowGeometry,
} from '@easydb/shared';
import { chooseTables } from '../dialogs/table-select-dialog.js';
import { filenameFromUrl } from '../import/fetch-source.js';
import { cryptoUUID, slugTable } from '../util/ids.js';
// Type-only: erased at compile time, so importing this module for its type
// never pulls in `lit`/`top-progress.js` at runtime (that module registers a
// custom element on import, which would blow up under Vitest's default
// Node environment). The actual class is loaded lazily via dynamic import()
// only on the large-import path below, once we're past unit-test territory.
import type { ProgressHandle } from '../chrome/top-progress.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'json-import',
  name: 'JSON Import',
  type: 'importer',
  version: '0.1.0',
  description: 'Drag-and-drop JSON to create tables. Supports native dumps and arrays of objects.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2"/><path d="M16 3a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/json-import.ts',
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

// A JSON dump can hold MANY tables, so `list` parses once and returns one
// candidate per table, carrying the parsed table as the opaque handle. `read`
// then just hands back what `list` already produced — no second parse.

const importerSpec: ImporterSpec = {
  id: 'json',
  label: 'JSON dump',
  icon: 'data_object',
  order: 20,
  accept: ['.json', '.db.json', 'application/json'],
  samples: [
    {
      label: 'Northwind — sample database (JSON dump)',
      url: 'https://raw.githubusercontent.com/cawoodm/easydbaccess/main/data/northwind.db.json',
    },
  ],
  supports: { url: true, file: true, text: true, reference: true, multiTable: true },

  detect(input) {
    const name = input.kind === 'file' ? (input.file?.name ?? '') : (input.url ?? '');
    if (/\.db\.json$/i.test(name)) return 1; // our own dump format
    if (/\.json$/i.test(name)) return 0.95;
    if (input.file?.type === 'application/json') return 0.9;
    const body = (input.text ?? '').trimStart();
    return body.startsWith('{') || body.startsWith('[') ? 0.3 : 0;
  },

  async list(ctx, input) {
    let text: string;
    if (input.kind === 'file' && input.file) text = await input.file.text();
    else if (input.kind === 'url' && input.url) {
      text = await ctx.fetchText(input.url, `Reading ${filenameFromUrl(input.url)}…`);
    } else text = input.text ?? '';

    const fallback =
      input.kind === 'file' && input.file
        ? stripJsonExt(input.file.name)
        : input.kind === 'url' && input.url
          ? stripJsonExt(filenameFromUrl(input.url))
          : 'imported';

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Invalid JSON in ${fallback}: ${(err as Error).message}`);
    }
    const tables = parsedToTables(parsed, fallback);
    return tables.map((t) => ({
      name: t.name,
      rowCount: t.rows.length,
      handle: { table: t, input, single: tables.length === 1 } satisfies JsonHandle,
    }));
  },

  async *read(_ctx, candidate) {
    const { table } = candidate.handle as JsonHandle;
    yield { columns: table.columns, rows: table.rows };
  },

  reference(_ctx, candidate) {
    const { input, single } = candidate.handle as JsonHandle;
    if (input.kind !== 'url' || !input.url) {
      throw new Error('A reference needs a re-fetchable URL — an upload cannot be referenced.');
    }
    // The `url` row-source re-fetches the WHOLE document and reads the first
    // array of objects out of it. That is only the right table when the
    // document held exactly one, so refuse a multi-table dump rather than
    // silently referencing the wrong rows.
    if (!single) {
      throw new Error(
        'That URL holds several tables, so a reference would be ambiguous. Import a copy instead.',
      );
    }
    return { type: 'url', config: { url: input.url, format: 'json' } };
  },
};

/** What json-import passes to itself between `list` and `read`/`reference`. */
interface JsonHandle {
  table: NormalizedTable;
  input: ImportSourceInput;
  /** The document held exactly one table, so a `url` reference is unambiguous. */
  single: boolean;
}

/** Strip `.db.json` / `.json` so a dump names its table without the extension. */
function stripJsonExt(name: string): string {
  return name.replace(/\.db\.json$/i, '').replace(/\.json$/i, '') || 'imported';
}

// -- Core: file -> Tables -----------------------------------------------------

async function importJsonFile(api: HostApi, file: File): Promise<void> {
  await importJsonText(api, await file.text(), file.name);
}

/**
 * Imports a JSON dump given its text body and a source filename. Used by both
 * the drag-and-drop path and the import-data plugin's URL fetch path. Behavior
 * is identical: parse → detect shape → prompt user on collisions → write.
 */
export async function importJsonText(
  api: HostApi,
  text: string,
  filename: string,
  opts: { originUrl?: string | undefined; maxRows?: number | undefined } = {},
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
  const allTables = parsedToTables(parsed, baseName);
  if (allTables.length === 0) return;

  // Multi-table dumps: let the user pick which tables to import (all selected
  // by default). Single-table dumps skip the picker.
  let tables = allTables;
  if (allTables.length > 1) {
    const picked = await chooseTables(
      allTables.map((t) => ({ name: t.name, size: t.rows.length })),
      {
        title: 'Import tables',
        message: `"${filename}" contains ${allTables.length} tables. Choose which to import.`,
        confirmLabel: 'Import',
      },
    );
    if (!picked) return; // cancelled
    tables = picked.map((i) => allTables[i]!);
  }

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
    const opts =
      collisions.length > 0
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

  // The slow phase for large dumps (e.g. Northwind's ~10s) is what's left:
  // optional replace-workspace cleanup, then the per-table bulkInsert loop.
  // Gate the top progress bar on total row count rather than a timer — unlike
  // a network fetch we have no "in progress, taking a while" signal to hook a
  // slow-threshold off before the work is already done, but we do know the
  // row counts up front, and they're a fair proxy for how long bulkInsert
  // will take. Small imports skip the bar entirely rather than flashing it.
  const ROW_THRESHOLD = 2000;
  const totalRows = tables.reduce(
    (sum, t) => sum + (t.source ? 0 : Math.min(t.rows.length, opts.maxRows ?? Infinity)),
    0,
  );
  let handle: ProgressHandle | null = null;
  if (totalRows >= ROW_THRESHOLD) {
    const { TopProgress } = await import('../chrome/top-progress.js');
    handle = TopProgress.begin(`Importing ${filename}…`);
  }

  try {
    if (mode === 'replace-workspace') {
      for (const t of existing) {
        const rowColl = api.store.rows(t.id);
        const rs = await rowColl.find();
        await rowColl.bulkRemove(rs.map((r) => r.id));
        await api.store.tables.remove(t.id);
      }
    }

    const existingByName = new Map(existing.map((t) => [t.name, t] as const));
    // Maps each imported table's name → its (new or matched) id, so view
    // instances in the dump can be re-pointed at the freshly-minted table ids.
    const nameToId = new Map<string, string>();
    let rowsDone = 0;
    for (const t of tables) {
      // Prefer backing info embedded in the dump (another device's export); else,
      // if we fetched this dump from a URL, record a snapshot origin so the table
      // can be refreshed/reloaded later.
      const source = t.source;
      const origin =
        t.origin ??
        (!source && opts.originUrl
          ? ({ type: 'json', url: opts.originUrl } as TableOrigin)
          : undefined);

      let tableId: string;
      const match = mode === 'overwrite-matching' ? existingByName.get(t.name) : undefined;
      if (match) {
        // Overwrite: keep the id (and thus its panel position) but wipe rows
        // and replace columns + sort + geometry + backing info from the import.
        tableId = match.id;
        // Only clear LOCAL rows. A matched table that's already live (`source`)
        // routes rows to its remote provider — we must not issue remote deletes.
        if (!match.source) {
          const rowColl = api.store.rows(tableId);
          const oldRows = await rowColl.find();
          await rowColl.bulkRemove(oldRows.map((r) => r.id));
        }
        await api.store.tables.patch(tableId, {
          columns: t.columns,
          ...(t.title ? { title: t.title } : {}),
          ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
          ...(t.sortColumn
            ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true }
            : { sortColumn: undefined, sortAsc: undefined }),
          ...(t.filters ? { filters: t.filters } : {}),
          ...(t.labelColumn ? { labelColumn: t.labelColumn } : {}),
          ...(t.info ? { info: t.info } : {}),
          ...(t.deletedColumns ? { deletedColumns: t.deletedColumns } : {}),
          source: source ?? undefined,
          origin: origin ?? undefined,
          updatedAt: Date.now(),
        });
      } else {
        tableId = cryptoUUID();
        api.events.emit('import:before', { source: 'json', tableId });
        await api.store.tables.insert({
          id: tableId,
          workspaceId,
          name: t.name,
          code: slugTable(t.name),
          columns: t.columns,
          view: 'table',
          ...(t.title ? { title: t.title } : {}),
          ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
          ...(t.sortColumn ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true } : {}),
          ...(t.filters ? { filters: t.filters } : {}),
          ...(t.labelColumn ? { labelColumn: t.labelColumn } : {}),
          ...(t.info ? { info: t.info } : {}),
          ...(t.deletedColumns ? { deletedColumns: t.deletedColumns } : {}),
          ...(source ? { source } : {}),
          ...(origin ? { origin } : {}),
          updatedAt: Date.now(),
        });
      }
      nameToId.set(t.name, tableId);

      // Snapshot rows are stored locally; a live (`source`) table pulls its own
      // rows from the provider, so we do NOT insert them here (that would write
      // to the remote). Its routed collection loads them on render.
      let inserted = 0;
      if (!source) {
        const rowColl = api.store.rows(tableId);
        // Apply the Import dialog's "Limit rows" cap per table (undefined ⇒ all).
        const rowsToInsert = opts.maxRows != null ? t.rows.slice(0, opts.maxRows) : t.rows;
        const docs = rowsToInsert.map((row) => ({
          id: cryptoUUID(),
          tableId,
          data: row,
          updatedAt: Date.now(),
        }));
        await rowColl.bulkInsert(docs);
        inserted = docs.length;
        rowsDone += inserted;
        // Weight progress by row count rather than table count, so a dump with
        // one huge table and several tiny ones doesn't jump straight to 90%.
        handle?.fraction(totalRows > 0 ? rowsDone / totalRows : 1);
      }

      api.events.emit('import:after', { source: 'json', tableId, rowCount: inserted });
    }

    // Restore view templates (workspace-global) and view instances (per-table),
    // re-pointing each instance at the freshly-imported table id by name. Only
    // native dumps carry these; other JSON shapes leave them undefined.
    await restoreViews(api, parsed, workspaceId, nameToId, mode === 'replace-workspace');
  } finally {
    handle?.done();
  }

  // Windows were opened one-per-insert (liveQuery fires per write), so their
  // saved z-order / geometry wasn't applied as a batch. Ask the window manager
  // to restack by saved z — mirrors the gist pull path.
  document.dispatchEvent(new CustomEvent('easydb:restack-windows'));
}

/**
 * Re-creates `ViewTemplate`s and `ViewInstance`s carried in a native dump.
 * Templates are upserted (merged, never cleared — that would drop built-ins the
 * dump omits). In replace-workspace mode the old instances are cleared first
 * (their tables were just wiped); otherwise instances are upserted. Each
 * instance's `tableId` is remapped via `nameToId` (falling back to its stored
 * id) so it binds to the table that was actually imported.
 */
async function restoreViews(
  api: HostApi,
  parsed: unknown,
  workspaceId: string,
  nameToId: Map<string, string>,
  replaceWorkspace: boolean,
): Promise<void> {
  if (!isObject(parsed)) return;
  const p = parsed as { viewTemplates?: unknown; viewInstances?: unknown };
  const templates = Array.isArray(p.viewTemplates) ? (p.viewTemplates as ViewTemplate[]) : [];
  const instances = Array.isArray(p.viewInstances) ? (p.viewInstances as ViewInstance[]) : [];
  if (templates.length === 0 && instances.length === 0) return;

  if (replaceWorkspace) {
    const stale = (await api.store.viewInstances.find()).filter(
      (v) => v.workspaceId === workspaceId,
    );
    await api.store.viewInstances.bulkRemove(stale.map((v) => v.id));
  }

  for (const vt of templates) {
    if (!isObject(vt) || typeof vt.id !== 'string') continue;
    await api.store.viewTemplates.upsert({ ...vt, workspaceId });
  }

  for (const inst of instances) {
    if (!isObject(inst) || typeof inst.id !== 'string') continue;
    const tableId = (inst.tableName ? nameToId.get(inst.tableName) : undefined) ?? inst.tableId;
    if (!tableId) continue;
    await api.store.viewInstances.upsert({ ...inst, workspaceId, tableId });
  }
}

// -- Shape detection ----------------------------------------------------------

interface NormalizedTable {
  name: string;
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
  title?: string;
  windowGeometry?: WindowGeometry;
  sortColumn?: string;
  sortAsc?: boolean;
  filters?: Record<string, string>;
  labelColumn?: string;
  info?: TableInfo;
  deletedColumns?: string[];
  /** Live remote backing carried in the dump (rows re-pulled from the provider). */
  source?: TableSource;
  /** Snapshot origin URL carried in the dump (refreshable). */
  origin?: TableOrigin;
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
  if (isObject(parsed) && Array.isArray((parsed as { tables?: unknown }).tables)) {
    const dump = parsed as { tables: unknown[] };
    const out: NormalizedTable[] = [];
    for (const entry of dump.tables) {
      if (isNativeTable(entry)) {
        const e = entry as Record<string, unknown>;
        const geom = isObject(e.windowGeometry) ? (e.windowGeometry as WindowGeometry) : undefined;
        const sortColumn = typeof e.sortColumn === 'string' ? e.sortColumn : undefined;
        const sortAsc = typeof e.sortAsc === 'boolean' ? e.sortAsc : undefined;
        const title = typeof e.title === 'string' ? e.title : undefined;
        const filters = isObject(e.filters) ? (e.filters as Record<string, string>) : undefined;
        const labelColumn = typeof e.labelColumn === 'string' ? e.labelColumn : undefined;
        const info = isObject(e.info) ? (e.info as TableInfo) : undefined;
        const deletedColumns = Array.isArray(e.deletedColumns)
          ? (e.deletedColumns.filter((c) => typeof c === 'string') as string[])
          : undefined;
        // Carry a live `source` or snapshot `origin` if the dump recorded one.
        const source =
          isObject(e.source) && typeof (e.source as { type?: unknown }).type === 'string'
            ? (e.source as unknown as TableSource)
            : undefined;
        const origin =
          isObject(e.origin) &&
          typeof (e.origin as { type?: unknown }).type === 'string' &&
          typeof (e.origin as { url?: unknown }).url === 'string'
            ? (e.origin as unknown as TableOrigin)
            : undefined;
        out.push({
          name: String(entry.name),
          columns: entry.columns.map(normalizeColumn),
          rows: Array.isArray(entry.rows)
            ? (entry.rows.filter(isObject) as Array<Record<string, unknown>>)
            : [],
          ...(title ? { title } : {}),
          ...(geom ? { windowGeometry: geom } : {}),
          ...(sortColumn ? { sortColumn, sortAsc: sortAsc ?? true } : {}),
          ...(filters ? { filters } : {}),
          ...(labelColumn ? { labelColumn } : {}),
          ...(info ? { info } : {}),
          ...(deletedColumns ? { deletedColumns } : {}),
          ...(source ? { source } : {}),
          ...(origin ? { origin } : {}),
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
    if (
      t.elementRect &&
      typeof t.elementRect.x === 'number' &&
      typeof t.elementRect.y === 'number'
    ) {
      // Only honor the saved geometry when both x/y are present. Without an
      // actual position from the dump, leave windowGeometry unset so the
      // window manager cascades the new panel instead of stacking it at 0,0.
      const r = t.elementRect as {
        x: number;
        y: number;
        width?: number;
        height?: number;
        zIndex?: number;
        minimized?: boolean;
        maximized?: boolean;
      };
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
  if (typeof o.script === 'string') spec.script = o.script;
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
