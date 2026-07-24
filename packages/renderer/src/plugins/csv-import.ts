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
  const baseName = file.name.replace(/\.csv$/i, '') || 'imported';
  await importCsvText(api, await file.text(), baseName);
}

/**
 * Create a Table (+ rows) from CSV text. Shared by the drag-and-drop file path
 * and the Import dialog's URL path. `name` seeds the table name (a trailing
 * `.csv` is stripped); a same-named existing table prompts append / overwrite /
 * create-new, exactly like a dropped file.
 */
/** Options for {@link importCsvText}. */
export interface CsvImportOpts {
  /**
   * Optional hook (used by the Import dialog's "Edit columns" checkbox) to
   * review/rename the parsed columns before the table is created. Receives the
   * inferred columns; returns the edited set, or `null` to cancel the import.
   * Only consulted for a brand-new table — append/overwrite reuse the existing
   * schema.
   */
  editColumns?: ((columns: ColumnSpec[]) => Promise<ColumnSpec[] | null>) | undefined;
}

export async function importCsvText(
  api: HostApi,
  text: string,
  name: string,
  opts: CsvImportOpts = {},
): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('csv-import: no active workspace');

  const baseName = (name || 'imported').replace(/\.csv$/i, '') || 'imported';

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

  // Build the rows to insert. For 'new' mode the CSV defines the schema, so
  // we run the full parser. For 'append'/'overwrite' we map CSV cells onto
  // the existing column schema BY INDEX — header names are ignored, so a
  // CSV column whose header doesn't match doesn't go missing (which is what
  // happened when we keyed by `slug(header)` instead).
  let docs: Array<{ id: string; tableId: string; data: Record<string, unknown>; updatedAt: number }>;

  if (mode === 'new') {
    const parsed = parseCsv(text);
    let columns = parsed.columns;
    let rows = parsed.rows;
    if (opts.editColumns) {
      const edited = await opts.editColumns(columns);
      if (edited === null) return; // user cancelled the column editor
      rows = remapRows(rows, columns, edited); // rekey cells old field → new field
      columns = edited;
    }
    const uniqueName = existing ? `${baseName} (${Date.now().toString(36)})` : baseName;
    await api.store.tables.insert({
      id: targetId,
      workspaceId,
      name: uniqueName,
      code: slug(uniqueName),
      columns,
      view: 'table',
      updatedAt: Date.now(),
    });
    docs = rows.map((row) => ({
      id: cryptoUUID(),
      tableId: targetId,
      data: row,
      updatedAt: Date.now(),
    }));
  } else {
    // append + overwrite: existing columns are preserved (widths, types,
    // renderers, constraints — all of it). CSV cells map to existing
    // columns by position, then coerce through each column's declared type.
    const targetCols = existing!.columns;
    const raw = parseCsvRaw(text);
    docs = raw.rows.map((cells) => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < targetCols.length; i++) {
        const col = targetCols[i]!;
        data[col.field] = coerce(cells[i] ?? '', col.type);
      }
      return { id: cryptoUUID(), tableId: targetId, data, updatedAt: Date.now() };
    });
    if (mode === 'overwrite') {
      // Wipe existing rows; keep the table id (panel position) AND its
      // columns (widths, renderers, etc. survive).
      const rows = api.store.rows(targetId);
      const old = await rows.find();
      await rows.bulkRemove(old.map((r) => r.id));
    }
  }

  const rowColl = api.store.rows(targetId);
  await rowColl.bulkInsert(docs);

  api.events.emit('import:after', {
    source: 'csv',
    tableId: targetId,
    rowCount: docs.length,
  });
}

// -- Parser -------------------------------------------------------------------

interface ParseResult {
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
}

/**
 * Tokenize-only entry point. Returns header + data rows as raw strings,
 * with no header mini-language parsing, no type inference, and no coercion.
 * Used by importers that map CSV cells onto an existing table's column
 * schema by index — the existing columns' types drive coercion instead.
 */
export function parseCsvRaw(text: string): { header: string[]; rows: string[][] } {
  const normalized = text.replace(/﻿/, ''); // strip BOM
  const sep = detectSeparator(normalized);
  const all = parseLines(normalized, sep);
  if (all.length === 0) return { header: [], rows: [] };
  const header = all[0]!;
  const rows = all.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));
  return { header, rows };
}

export function parseCsv(text: string): ParseResult {
  const normalized = text.replace(/﻿/, ''); // strip BOM
  const sep = detectSeparator(normalized);
  const rows = parseLines(normalized, sep);
  if (rows.length === 0) return { columns: [], rows: [] };

  const header = rows[0]!;
  const dataRows = rows.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));

  // Parse the mini-language. Each header cell may be either:
  //   - "Plain Label"                             — pure label, type inferred
  //   - "field:label"                             — explicit field/label
  //   - "field:label:type"                        — + explicit type
  //   - "field:label:type:default:max:flags"      — full spec
  // Flags: u=unique, n=notnull, h=hidden (any combination, any order).
  const headerSpecs = header.map((h, i) => parseHeaderCell(h, i));
  // Field names are object keys, so they must be unique. Distinct headers can
  // slug to the same field (e.g. "TM" and "Tm" both → "tm"); without this a
  // later column would clobber an earlier one's cells and the table would show
  // duplicate columns. Suffix collisions "_2", "_3", … in first-seen order.
  const fields = dedupeFields(headerSpecs.map((s) => s.field));

  const rawRows: Array<Record<string, string>> = dataRows.map((cells) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i++) {
      obj[fields[i]!] = cells[i] ?? '';
    }
    return obj;
  });

  // Infer types only for columns whose header didn't pin one explicitly.
  const types: ColumnType[] = headerSpecs.map((s, i) => {
    if (s.type) return s.type;
    return inferType(rawRows.map((r) => r[fields[i]!] ?? '').filter((v) => v.length > 0));
  });

  const columns: ColumnSpec[] = headerSpecs.map((s, i) => {
    const finalType = types[i] ?? 'string';
    const col: ColumnSpec = { field: fields[i]!, label: s.label, type: finalType };
    // Auto-assign a renderer when inference pinned a type with a built-in
    // renderer. CSV import is the only path where renderer auto-detection
    // is allowed — once a table exists, the user picks renderers manually.
    // An explicit header annotation (s.renderer) wins over inference.
    const autoRenderer = rendererForType(finalType);
    const chosen = s.renderer ?? autoRenderer;
    if (chosen) col.renderer = chosen;
    if (s.default !== undefined) col.default = s.default;
    if (s.max != null) col.max = s.max;
    if (s.unique) col.unique = true;
    if (s.notnull) col.notnull = true;
    if (s.hidden) col.hidden = true;
    return col;
  });

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

interface HeaderSpec {
  field: string;
  label: string;
  type?: ColumnType;
  renderer?: string;
  default?: unknown;
  max?: number;
  unique?: boolean;
  notnull?: boolean;
  hidden?: boolean;
}

const KNOWN_TYPES = new Set<ColumnType>([
  'string',
  'number',
  'boolean',
  'date',
  'datetime',
]);

/**
 * Legacy CSV header type names that map onto renderer names in the post-
 * `column.renderer` world. `bg:Background:color` keeps working — it just
 * becomes `{type:'string', renderer:'color'}` instead of `{type:'color'}`.
 */
const LEGACY_TYPE_TO_RENDERER: Record<string, string> = {
  color: 'color',
  image: 'image',
};

/** Returns the matching renderer name for an inferred type, or undefined. */
function rendererForType(t: ColumnType): string | undefined {
  if (t === 'date' || t === 'datetime' || t === 'boolean') return t;
  return undefined;
}

function parseHeaderCell(h: string, idx: number): HeaderSpec {
  const trimmed = h.trim();
  if (!trimmed.includes(':')) {
    // Plain label; everything inferred.
    return { field: slug(trimmed || `col_${idx + 1}`), label: trimmed || `Column ${idx + 1}` };
  }
  const parts = trimmed.split(':');
  const field = slug(parts[0] || `col_${idx + 1}`);
  const label = (parts[1] ?? parts[0] ?? '').trim() || field;
  const spec: HeaderSpec = { field, label };
  const typeStr = (parts[2] ?? '').trim();
  if (typeStr) {
    if (KNOWN_TYPES.has(typeStr as ColumnType)) {
      spec.type = typeStr as ColumnType;
    } else if (LEGACY_TYPE_TO_RENDERER[typeStr]) {
      // Legacy 'color' / 'image' header annotations: keep data as a string
      // and let the matching renderer decide how to display it.
      spec.type = 'string';
      spec.renderer = LEGACY_TYPE_TO_RENDERER[typeStr];
    }
  }
  const defStr = (parts[3] ?? '').trim();
  if (defStr) spec.default = defStr;
  const maxStr = (parts[4] ?? '').trim();
  if (maxStr) {
    const n = Number(maxStr);
    if (Number.isFinite(n) && n > 0) spec.max = n;
  }
  const flags = (parts[5] ?? '').toLowerCase();
  if (flags.includes('u')) spec.unique = true;
  if (flags.includes('n')) spec.notnull = true;
  if (flags.includes('h')) spec.hidden = true;
  return spec;
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
  if (samples.every(isDateTime)) return 'datetime';
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

/**
 * Date-only detection. Accepts ISO YYYY-MM-DD plus D{/-.}M{/-.}Y patterns
 * (both DMY and MDY ambiguous — we accept either; coerce() picks one).
 * Rejects bare integers so a column of years/IDs doesn't become 'date'.
 */
function isDate(s: string): boolean {
  const t = s.trim();
  if (t === '' || /^\d+$/.test(t)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(t)) return true;
  return false;
}

/** Datetime detection — requires a time component after a space or 'T'. */
function isDateTime(s: string): boolean {
  const t = s.trim();
  if (t === '') return false;
  // ISO with time: YYYY-MM-DD[T ]HH:MM[:SS]
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2})?/.test(t)) return true;
  // D{/-.}M{/-.}Y space-or-T HH:MM
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}[T ]\d{1,2}:\d{2}/.test(t)) return true;
  return false;
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
      return normalizeDate(s);
    case 'datetime':
      return normalizeDateTime(s);
    default:
      return raw;
  }
}

/**
 * Coerce a date-only string into ISO YYYY-MM-DD. Heuristic for the
 * D{/-.}M{/-.}Y form: if the first part > 12, it must be the day (DMY);
 * if the third part is two digits, treat as YY -> 20YY. Falls back to
 * Date.parse for anything else.
 */
function normalizeDate(s: string): string {
  if (s === '') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (m) {
    let a = parseInt(m[1]!, 10);
    let b = parseInt(m[2]!, 10);
    const yr = m[3]!;
    let year = parseInt(yr, 10);
    if (yr.length === 2) year += 2000;
    // a > 12 forces DMY; b > 12 forces MDY; ambiguous defaults to DMY (rest of world).
    let day: number, month: number;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

function normalizeDateTime(s: string): string {
  if (s === '') return '';
  // Strip Z/timezone for the datetime-local input expectation.
  const t = s.replace(/\s+/, 'T');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})(?::\d{2})?/.exec(t);
  if (m) return `${m[1]}T${m[2]!.padStart(5, '0')}`;
  // D{/-.}M{/-.}Y [T ]HH:MM
  const m2 = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})[T ](\d{1,2}:\d{2})/.exec(s);
  if (m2) {
    const datePart = normalizeDate(`${m2[1]}/${m2[2]}/${m2[3]}`);
    return `${datePart}T${m2[4]!.padStart(5, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const iso = d.toISOString();
    return `${iso.slice(0, 10)}T${iso.slice(11, 16)}`;
  }
  return s;
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

/** Make field names unique, suffixing repeats "_2", "_3", … (first-seen wins). */
export function dedupeFields(fields: string[]): string[] {
  const counts = new Map<string, number>();
  const taken = new Set<string>();
  const out: string[] = [];
  for (const f of fields) {
    let candidate = f;
    let n = counts.get(f) ?? 0;
    while (taken.has(candidate)) {
      n += 1;
      candidate = `${f}_${n + 1}`;
    }
    counts.set(f, n);
    taken.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** Rekey each row's cells from old columns' fields onto new columns' fields (by index). */
function remapRows(
  rows: Array<Record<string, unknown>>,
  oldCols: ColumnSpec[],
  newCols: ColumnSpec[],
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < oldCols.length; i++) {
      out[newCols[i]!.field] = r[oldCols[i]!.field];
    }
    return out;
  });
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
