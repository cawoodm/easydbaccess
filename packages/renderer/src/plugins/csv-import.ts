import type { ColumnSpec, ColumnType, HostApi, ImporterSpec, ImportSourceInput, PluginModule, TableOrigin } from '@easydb/shared';
import { filenameFromUrl } from '../import/fetch-source.js';
import { isUnsafeIntegerText } from '../import/big-numbers.js';
import { mapRowsToTarget, type ColumnMapping } from '../import/map-columns.js';
import { cryptoUUID, slugField } from '../util/ids.js';
import { looksLikeArray } from '../util/array-cell.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'csv-import',
  name: 'CSV Import',
  type: 'importer',
  version: '0.1.0',
  description: 'Drag-and-drop CSV or TSV files to create typed tables.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/csv-import.ts',
};

export function init(api: HostApi): void {
  api.ui.registerImporter(importerSpec);
  // Define the options panel the Import dialog renders for this importer.
  // Loaded dynamically because this module is unit-tested under Vitest's
  // default Node environment, where `customElements` does not exist; `init`
  // only ever runs in the browser.
  void import('./csv-import-options.js');
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
    // Dropped ON a table window? Then the table is the obvious destination, and
    // asking about columns first would be answering the wrong question. Only for
    // a single file: "append these three files to this table" needs a mapping per
    // file, which is more dialogs than a drag gesture should ever open.
    if (csvs.length === 1) {
      const handled = await dropOntoTable(api, event, csvs[0]!);
      if (handled) return true;
    }
    // A drop used to go straight in, which is right for a clean file and wrong
    // for one with duplicate or unusable headers — the Import dialog has always
    // offered "Edit columns" and a drop had no way to ask for it. One question
    // for the whole drop, not one per file.
    const subject = csvs.length === 1 ? `"${csvs[0]!.name}"` : `${csvs.length} files`;
    const choice = await api.ui.dialogs.choice(`Import ${subject} straight away, or review the columns first (rename, hide, fix duplicate names)?`, [DROP_DIRECT, DROP_EDIT], 'Import CSV');
    // Dismissed ⇒ the drop is cancelled. `true` still claims the event: the file
    // was ours to handle, the user simply changed their mind.
    if (!choice) return true;
    const editColumns =
      choice === DROP_EDIT
        ? async (columns: ColumnSpec[]) => {
            const { editColumnNames } = await import('../dialogs/column-names-dialog.js');
            return editColumnNames(columns);
          }
        : undefined;

    for (const file of csvs) {
      await importCsvFile(api, file, editColumns);
    }
    return true;
  });
}

// -- Importer spec ------------------------------------------------------------
//
// One delimited file is always exactly one table, so `list` returns a single
// candidate and `read` yields a single batch. The kernel supplies the dialog,
// the fetch, the naming and the write.

/**
 * The source's own file name, extension included. The extension matters — it
 * pins the separator for a `.tsv`/`.tab` file — so this is what `read` looks at.
 */
function sourceName(input: ImportSourceInput): string {
  if (input.kind === 'file' && input.file) return input.file.name;
  if (input.kind === 'url' && input.url) return filenameFromUrl(input.url);
  return 'pasted';
}

/**
 * The name to propose for the table, before the kernel's naming policy runs.
 * The extension is dropped: nobody wants a table called `air.csv`.
 */
function candidateName(input: ImportSourceInput): string {
  return stripDelimitedExt(sourceName(input)) || 'imported';
}

/** The two answers of the drop question. Constants because a choice dialog
 *  reports back the label the user picked. */
const DROP_DIRECT = 'Import directly';
const DROP_EDIT = 'Edit columns first';

// Dropping a file ON a table window names its destination, so the question is
// what to do with that table. The wording matches the Import dialog's Target
// field, which offers the same three things.
const ONTO_NEW = 'A new table';
const ONTO_APPEND = 'Append to this table';
const ONTO_REPLACE = 'Replace the rows of this table';

/**
 * Handle a CSV dropped onto an existing table's window. Returns false when the
 * drop landed anywhere else (the canvas, the chrome), leaving the caller's
 * ordinary new-table flow to run.
 *
 * Append opens the column mapper: the append path matches the file's columns to
 * the table's BY POSITION, which is right for a file the table came from and
 * silently wrong for anything else.
 */
async function dropOntoTable(api: HostApi, event: DragEvent, file: File): Promise<boolean> {
  const { tableIdAtNode } = await import('../window-mgr/table-window-manager.js');
  const tableId = tableIdAtNode(event.target);
  if (!tableId) return false;
  const table = await api.store.tables.findOne(tableId);
  if (!table) return false;
  // A read-only table (a live connection, a reference) cannot take rows at all.
  if (table.readonly === true || table.source != null) {
    api.ui.dialogs.toast(`"${table.name}" is read-only, so the file was imported as a new table.`, {
      kind: 'warning',
      title: 'Import CSV',
    });
    return false;
  }

  const choice = await api.ui.dialogs.choice(`Import "${file.name}" into "${table.name}"?`, [ONTO_APPEND, ONTO_REPLACE, ONTO_NEW], 'Import CSV');
  if (!choice) return true; // dismissed ⇒ the drop is cancelled, and it was ours
  if (choice === ONTO_NEW) return false; // fall through to the new-table flow

  const text = await file.text();
  const mode = choice === ONTO_APPEND ? 'append' : 'overwrite';
  const opts: CsvImportOpts = { target: { tableId, mode } };
  if (mode === 'append') {
    opts.mapFields = async (header, targetCols, sample) => {
      const { mapColumnsToTable } = await import('../dialogs/column-map-dialog.js');
      return mapColumnsToTable(header, targetCols, table.name, sample);
    };
  }
  await importCsvText(api, text, file.name, opts);
  return true;
}

const importerSpec: ImporterSpec = {
  id: 'csv',
  label: 'CSV / TSV',
  icon: 'table_view',
  order: 10,
  accept: ['.csv', '.tsv', '.tab', 'text/csv', 'text/tab-separated-values'],
  panel: 'csv-import-options',
  samples: [
    {
      label: 'Air quality — 2016 readings (CSV)',
      url: 'https://raw.githubusercontent.com/MainakRepositor/Datasets/master/Air%20Quality/real_2016_air.csv',
    },
  ],
  supports: { url: true, file: true, text: true, reference: true, kernel: true },

  detect(input) {
    const name = input.kind === 'file' ? (input.file?.name ?? '') : (input.url ?? input.text ?? '');
    if (/\.(csv|tsv|tab)$/i.test(name)) return 0.95;
    if (input.file?.type === 'text/csv') return 0.9;
    // A delimited body is a plausible last resort but never a confident guess.
    return input.kind === 'text' ? 0.2 : 0;
  },

  async list(_ctx, input) {
    return [{ name: candidateName(input), rowCount: null, handle: input }];
  },

  async *read(ctx, candidate) {
    const input = candidate.handle as ImportSourceInput;
    let text: string;
    if (input.kind === 'file' && input.file) {
      // Honour the cap by STREAMING a prefix rather than reading the whole
      // file. A 150 MB CSV read and parsed whole — before any cap applies —
      // can silently kill a memory-limited tab.
      text = ctx.maxRows != null ? await readCsvHead(input.file, ctx.maxRows) : await input.file.text();
    } else if (input.kind === 'url' && input.url) {
      text = await ctx.fetchText(input.url, `Reading ${sourceName(input)}…`);
    } else {
      text = input.text ?? '';
    }
    // A separator chosen in the options panel beats the name-based rule, which
    // in turn beats auto-detection.
    const panelSep = typeof ctx.panel.separator === 'string' ? ctx.panel.separator : undefined;
    const sep = panelSep ?? separatorForName(sourceName(input));
    const parseOpts = {
      ...(ctx.maxRows != null ? { maxRows: ctx.maxRows } : {}),
      ...(sep ? { separator: sep } : {}),
    };

    // Appending to (or overwriting) an existing table: map cells onto its
    // columns BY POSITION and coerce through each declared type. A CSV header
    // need not match the target's field names — `Person Name,Years` into
    // `[name, age]` must land in `name`/`age`, not invent `person_name`/`years`
    // and drop the data. This is why the kernel hands over `targetColumns`
    // rather than trying to match a generic row object itself.
    const target = ctx.targetColumns;
    if (target && target.length > 0) {
      const raw = parseCsvRaw(text, parseOpts);
      const rows = raw.rows.map((cells) => {
        const data: Record<string, unknown> = {};
        for (let i = 0; i < target.length; i++) {
          const col = target[i]!;
          data[col.field] = coerce(cells[i] ?? '', col.type);
        }
        return data;
      });
      // No `columns` on the batch: the target's schema wins, so the kernel must
      // not reconcile our inferred names into it.
      yield { rows };
      return;
    }

    const parsed = parseCsv(text, parseOpts);
    yield { columns: parsed.columns, rows: parsed.rows };
  },

  reference(_ctx, candidate) {
    const input = candidate.handle as ImportSourceInput;
    if (input.kind !== 'url' || !input.url) {
      throw new Error('A reference needs a re-fetchable URL — an upload cannot be referenced.');
    }
    return { type: 'url', config: { url: input.url, format: 'csv' } };
  },
};

// -- Core: turn one File into a Table + Rows ----------------------------------

async function importCsvFile(api: HostApi, file: File, editColumns?: CsvImportOpts['editColumns']): Promise<void> {
  // Keep the extension on the name we pass down: importCsvText strips it and
  // reads it to pin the separator for a .tsv file.
  await importCsvText(api, await file.text(), file.name, editColumns ? { editColumns } : undefined);
}

/**
 * Create a Table (+ rows) from CSV or TSV text. Shared by the drag-and-drop
 * file path and the Import dialog's URL path. `name` seeds the table name (a
 * trailing `.csv` / `.tsv` / `.tab` is stripped) and also pins the separator:
 * a `.tsv`/`.tab` name forces TAB, because a TSV whose cells contain commas
 * can out-count its own tabs and fool the auto-detector. Anything else
 * auto-detects. A same-named existing table prompts append / overwrite /
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
  /**
   * Snapshot origin to stamp on a newly-created table (the URL it was imported
   * from), so it can be refreshed/reloaded later. Set by the Import dialog for
   * URL imports; absent for dropped files.
   */
  origin?: TableOrigin | undefined;
  /**
   * Cap the number of data rows imported (the Import dialog's "Limit rows"
   * option). Undefined ⇒ import all rows. Applies to new, append, and
   * overwrite modes alike.
   */
  maxRows?: number | undefined;
  /**
   * Separator character chosen in the CSV options panel. Overrides both the
   * `.tsv`/`.tab` name rule and auto-detection. Undefined ⇒ keep that order.
   */
  separator?: string | undefined;
  /**
   * Where the rows go, decided by the caller. Set when the file was dropped ON a
   * table window: the destination is that table, whatever it is called, so the
   * same-name lookup below must not run (and must not offer to create a new
   * table under a uniquified name).
   */
  target?: { tableId: string; mode: 'append' | 'overwrite' } | undefined;
  /**
   * Map the file's columns onto the target table's columns before an append.
   * Receives the file's header, the table's columns and the first data row (so
   * two similar headers can be told apart), and returns one target field per
   * incoming column — `''` drops that column. Null cancels the import.
   *
   * Absent ⇒ the historical by-position mapping.
   */
  mapFields?: ((header: string[], targetCols: ColumnSpec[], sample: string[]) => Promise<ColumnMapping | null>) | undefined;
}

export async function importCsvText(api: HostApi, text: string, name: string, opts: CsvImportOpts = {}): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('csv-import: no active workspace');

  const baseName = stripDelimitedExt(name || 'imported') || 'imported';
  // An explicit choice from the options panel wins over the `.tsv`/`.tab` name
  // rule, which wins over auto-detection inside the parser.
  const separator = opts.separator ?? separatorForName(name);

  // An explicit target (the file was dropped on a table window) settles it. The
  // name lookup below is only for guessing a destination, and there is nothing
  // left to guess.
  const chosen = opts.target ? await api.store.tables.findOne(opts.target.tableId) : null;
  // If a table with this name already exists in the workspace, ask the user
  // what to do: append rows, overwrite (clear + insert), or create a new
  // table under a unique name.
  const existing = chosen ?? (await api.store.tables.find()).find((t) => t.workspaceId === workspaceId && t.name === baseName);

  let targetId: string;
  let mode: 'new' | 'append' | 'overwrite';

  if (chosen && opts.target) {
    mode = opts.target.mode;
    targetId = chosen.id;
  } else if (existing) {
    const choice = await api.ui.dialogs.choice(`A table named "${baseName}" already exists in this workspace.`, ['Append rows', 'Overwrite rows', 'Create as new table'], 'CSV import');
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
  let docs: Array<{
    id: string;
    tableId: string;
    data: Record<string, unknown>;
    updatedAt: number;
  }>;

  if (mode === 'new') {
    const parsed = parseCsv(text, { maxRows: opts.maxRows, separator });
    let columns = parsed.columns;
    let rows = parsed.rows;
    if (opts.editColumns) {
      const edited = await opts.editColumns(columns);
      if (edited === null) return; // user cancelled the column editor
      rows = remapRows(rows, columns, edited); // rekey cells old field → new field
      columns = edited;
    }
    if (opts.maxRows != null) rows = rows.slice(0, opts.maxRows);
    // No local uniquing rule: the store refuses a duplicate name and hands back
    // `places-2` (see `db/unique-table-names.ts`). This used to append a base36
    // timestamp here, which read as `places (m8x1k2)`.
    await api.store.tables.insert({
      id: targetId,
      workspaceId,
      name: baseName,
      // NOTE: csv-import derives the table `code` with the FIELD slug
      // (underscores), unlike every other importer, which uses the TABLE slug
      // (dashes). Kept as-is here so this extraction changes no behavior.
      // Unify in Phase C — see .claude/plans/2026-07-28-importer-architecture.md.
      code: slugField(baseName),
      columns,
      view: 'table',
      ...(opts.origin ? { origin: opts.origin } : {}),
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
    // columns by position, then coerce through each column's declared type —
    // unless the caller supplies a mapping (see `mapFields`).
    const targetCols = existing!.columns;
    const raw = parseCsvRaw(text, { maxRows: opts.maxRows, separator });
    const rawRows = opts.maxRows != null ? raw.rows.slice(0, opts.maxRows) : raw.rows;
    let mapping: ColumnMapping = targetCols.map((c) => c.field);
    if (opts.mapFields) {
      const chosenMapping = await opts.mapFields(raw.header, targetCols, raw.rows[0] ?? []);
      if (chosenMapping === null) return; // user cancelled the mapper
      mapping = chosenMapping;
    }
    docs = mapRowsToTarget(rawRows, targetCols, mapping, coerce).map((data) => ({
      id: cryptoUUID(),
      tableId: targetId,
      data,
      updatedAt: Date.now(),
    }));
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
export function parseCsvRaw(text: string, opts: { maxRows?: number | undefined; separator?: string | undefined } = {}): { header: string[]; rows: string[][] } {
  const normalized = text.replace(/\uFEFF/, ''); // strip BOM
  const sep = opts.separator ?? detectSeparator(normalized);
  const all = parseLines(normalized, sep, lineCap(opts.maxRows));
  if (all.length === 0) return { header: [], rows: [] };
  const header = all[0]!;
  const rows = all.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));
  return { header, rows };
}

/** Cap for parseLines: header + maxRows data rows. Undefined ⇒ no cap. */
function lineCap(maxRows: number | undefined): number | undefined {
  return maxRows != null ? maxRows + 1 : undefined;
}

/**
 * Read only the first `maxRows` data rows (plus the header) of a possibly huge
 * CSV file, streaming it in byte-slices so the WHOLE file is never held in
 * memory at once. Without this, `file.text()` on a 150 MB CSV allocates a
 * ~300 MB string (UTF-16) and the parser then builds full copies of every row
 * before the row cap is applied — enough to silently kill a memory-limited
 * browser tab (notably iOS Safari), so a capped import of a large file does
 * nothing at all.
 *
 * Quote-aware: a `\n` inside a quoted field does not end a row. Row counting
 * keys on `\n` (covering `\n` and `\r\n`); a `\r`-only file simply isn't capped
 * early (it falls back to a full read) rather than being cut mid-row.
 */
export async function readCsvHead(file: Blob, maxRows: number): Promise<string> {
  const CHUNK = 1 << 20; // 1 MiB per slice
  const decoder = new TextDecoder();
  const targetLines = maxRows + 1; // + the header row
  let text = '';
  let lines = 0;
  let inQuotes = false;
  let offset = 0;

  while (offset < file.size) {
    const buf = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
    offset += CHUNK;
    const chunk = decoder.decode(buf, { stream: true });
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (ch === '"') {
        inQuotes = !inQuotes; // "" toggles twice → back to the same state
      } else if (ch === '\n' && !inQuotes) {
        lines += 1;
        if (lines >= targetLines) return text + chunk.slice(0, i + 1);
      }
    }
    text += chunk;
  }
  return text; // file has fewer rows than the cap
}

export function parseCsv(text: string, opts: { maxRows?: number | undefined; separator?: string | undefined } = {}): ParseResult {
  const normalized = text.replace(/\uFEFF/, ''); // strip BOM
  const sep = opts.separator ?? detectSeparator(normalized);
  const rows = parseLines(normalized, sep, lineCap(opts.maxRows));
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

const KNOWN_TYPES = new Set<ColumnType>(['string', 'number', 'boolean', 'date', 'datetime', 'array']);

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
  // An `array` column's renderer is not named after its type: `tags` is what
  // draws one pill per value (see plugins/cell-tags.ts).
  if (t === 'array') return 'tags';
  return undefined;
}

function parseHeaderCell(h: string, idx: number): HeaderSpec {
  const trimmed = h.trim();
  if (!trimmed.includes(':')) {
    // Plain label; everything inferred.
    return { field: slugField(trimmed || `col_${idx + 1}`), label: trimmed || `Column ${idx + 1}` };
  }
  const parts = trimmed.split(':');
  const field = slugField(parts[0] || `col_${idx + 1}`);
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
function parseLines(text: string, sep: string, maxLines?: number): string[][] {
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
        // Stop once we've emitted the requested number of lines — the caller
        // capped the import, so parsing the rest would only waste time/memory.
        if (maxLines != null && out.length >= maxLines) return out;
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
  // A cell spelled `["a","b"]` is a list, whoever exported it. A cell with bare
  // commas is NOT — prose is full of commas, so a comma list only becomes an
  // `array` column when the header says so (`tags:Tags:array`) or the user picks
  // the type in the columns editor.
  if (samples.every(looksLikeArray)) return 'array';
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
  // An integer past 2^53 cannot round-trip through a JS number, so a column
  // holding one is TEXT — see import/big-numbers.ts.
  if (isUnsafeIntegerText(t)) return false;
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
    case 'array':
      // Kept verbatim: `util/array-cell.ts` reads the members out of whichever
      // spelling arrived, so rewriting the cell would only lose the original.
      return s === '' ? null : s;
    case 'number': {
      if (s === '') return null;
      // Keep the digits when they do not fit a JS number — the same reason
      // `isNumber` refuses to infer one. A column typed `number` by hand (or
      // by a header annotation) still holds such a value as text rather than
      // rounding it.
      if (isUnsafeIntegerText(s)) return s;
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
    const a = parseInt(m[1]!, 10);
    const b = parseInt(m[2]!, 10);
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

/** Extensions this importer reads. `.tab` is the other common TSV extension. */
const DELIMITED_EXT_RE = /\.(csv|tsv|tab)$/i;

/** Strip a trailing `.csv` / `.tsv` / `.tab` from a file name. */
export function stripDelimitedExt(name: string): string {
  return name.replace(DELIMITED_EXT_RE, '');
}

/**
 * TAB for a `.tsv`/`.tab` name, otherwise undefined (let the parser auto-detect).
 * A tab-separated file whose cells contain commas can show more commas than
 * tabs, so the extension must win over the sample count.
 */
export function separatorForName(name: string): string | undefined {
  return /\.(tsv|tab)$/i.test(name) ? '\t' : undefined;
}

function isCsv(file: File): boolean {
  if (DELIMITED_EXT_RE.test(file.name)) return true;
  if (file.type === 'text/csv' || file.type === 'application/csv') return true;
  if (file.type === 'text/tab-separated-values') return true;
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
function remapRows(rows: Array<Record<string, unknown>>, oldCols: ColumnSpec[], newCols: ColumnSpec[]): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < oldCols.length; i++) {
      out[newCols[i]!.field] = r[oldCols[i]!.field];
    }
    return out;
  });
}
