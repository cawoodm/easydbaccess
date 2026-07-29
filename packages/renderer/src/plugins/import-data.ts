// packages/renderer/src/plugins/import-data.ts
//
// easyDBAccess built-in plugin — the "Import" header button. Opens a dialog
// where the user pastes any URL or picks a predefined source from a dropdown
// (our Northwind sample dump plus a few public Datasette tables), then routes
// the import to the right engine:
//   - JSON dump  -> fetch the body and hand it to json-import's importJsonText
//   - Datasette  -> hand the URL to datasette-source's importDatasetteTable
//
// This is the grown-up replacement for the old single-prompt "Load sample data"
// button: same Northwind default, but now Datasette tables are reachable from
// the UI too (the datasette-source plugin only registered an unsurfaced URL
// source and a file-only drop handler, so there was no clickable way in).

import type { ColumnSpec, ColumnType, HostApi, PluginModule, Table } from '@easydb/shared';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { TopProgress, type ProgressHandle } from '../chrome/top-progress.js';
import { editColumnNames } from '../dialogs/column-names-dialog.js';
import { ctrlEnterSubmits, dialogChromeStyles } from '../dialogs/dialog-chrome.js';
import { makeDialogDraggable } from '../dialogs/draggable.js';
import { importCsvText, parseCsv, readCsvHead } from './csv-import.js';
import { fetchDatabaseNames, fetchTablesForDb, parseDatasetteUrl } from './datasette-client.js';
import { importDatasette } from './datasette-source.js';
import { slug } from './server-sync-core.js';
import { importJsonText, parsedToTables } from './json-import.js';
import { fetchImportText } from './import-fetch.js';

/** How a URL should be imported. `auto` is resolved to a concrete kind on submit. */
type ImportKind = 'auto' | 'json' | 'csv' | 'datasette';
type ResolvedKind = Exclude<ImportKind, 'auto'>;

interface PredefinedSource {
  label: string;
  url: string;
  kind: ResolvedKind;
}

const NORTHWIND_URL =
  'https://raw.githubusercontent.com/cawoodm/easydbaccess/main/data/northwind.db.json';

// A public CSV served with CORS (raw.githubusercontent sends
// `access-control-allow-origin: *`), so it imports straight from the browser
// build. GitHub "blob" pages are HTML — the raw host serves the file itself.
const AIR_QUALITY_CSV =
  'https://raw.githubusercontent.com/MainakRepositor/Datasets/master/Air%20Quality/real_2016_air.csv';

/**
 * Inline "import" glyph (arrow descending into a tray) rendered as an SVG on
 * the header button. The shell renders `icon` strings that begin with `<svg`
 * as inline SVG (fill: currentColor) rather than as a Material Icons ligature.
 */
const IMPORT_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

/**
 * Curated starting points. The first is our own JSON dump; the rest are public
 * Datasette instances served with CORS so they work from the static browser
 * build (no sync server required). Picking one fills the URL box and sets the
 * import kind, but the URL stays editable.
 */
const PREDEFINED: PredefinedSource[] = [
  { label: 'Northwind — sample database (JSON dump)', url: NORTHWIND_URL, kind: 'json' },
  { label: 'Air quality — 2016 readings (CSV)', url: AIR_QUALITY_CSV, kind: 'csv' },
  {
    label: 'Datasette — US legislators (whole database, pick tables)',
    url: 'https://datasette.io/legislators',
    kind: 'datasette',
  },
  {
    label: 'Datasette — datasette.io (whole instance, pick database & tables)',
    url: 'https://datasette.io',
    kind: 'datasette',
  },
];

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'import-data',
  name: 'Import Data',
  type: 'importer',
  version: '0.2.0',
  description:
    'Header button that imports data from a URL — a JSON dump (e.g. Northwind) or a Datasette table, database, or whole instance — with a picker of sample sources.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/import-data.ts',
};

export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'import-data:open',
    label: 'Import',
    icon: IMPORT_ICON_SVG,
    tooltip: 'Import data from a URL (snapshot into a local table)',
    onClick: () => openImport(api),
  });

  // Refresh a snapshot table imported from a CSV/JSON URL by re-fetching it.
  // (Datasette-origin tables get their own refresh from datasette-source.)
  api.ui.registerTableButton({
    id: 'import-data:refresh',
    label: 'Refresh',
    icon: 'refresh',
    tooltip: 'Reload this table from the URL it was imported from',
    visible: (table) => table.origin?.type === 'csv' || table.origin?.type === 'json',
    onClick: (a, { tableId }) => refreshImported(a, tableId),
  });
}

/**
 * {@link fetchImportText} while showing the top progress bar — but only if the
 * read is slow (exceeds ~2s). The bar is determinate when the response
 * advertises a `Content-Length`, indeterminate otherwise, so quick imports
 * never flash it.
 */
async function fetchImportTextWithBar(api: HostApi, url: string, label: string): Promise<string> {
  // Held on an object so the closure assignment isn't narrowed away in finally.
  const ref: { handle: ProgressHandle | null } = { handle: null };
  try {
    return await fetchImportText(api, url, {
      onSlow: () => {
        ref.handle = TopProgress.begin(label);
      },
      onProgress: (f) => ref.handle?.fraction(f),
    });
  } finally {
    ref.handle?.done();
  }
}

/** Re-fetch a CSV/JSON snapshot table from its origin URL and replace its rows. */
async function refreshImported(api: HostApi, tableId: string): Promise<void> {
  const t = await api.store.tables.findOne(tableId);
  const origin = t?.origin;
  if (!origin?.url) return;
  try {
    const text = await fetchImportTextWithBar(api, origin.url, `Reading ${t?.name ?? 'data'}…`);

    let rows: Array<Record<string, unknown>>;
    if (origin.type === 'csv') {
      rows = parseCsv(text).rows;
    } else {
      const parsed = parsedToTables(JSON.parse(text), t!.name);
      const match =
        parsed.find((x) => x.name === t!.name) ?? (parsed.length === 1 ? parsed[0] : undefined);
      if (!match) throw new Error(`"${t!.name}" is no longer in the dump at ${origin.url}`);
      rows = match.rows;
    }

    const coll = api.store.rows(tableId);
    const old = await coll.find();
    await coll.bulkRemove(old.map((r) => r.id));
    await coll.bulkInsert(
      rows.map((data) => ({ id: cryptoUUID(), tableId, data, updatedAt: Date.now() })),
    );
    api.ui.dialogs.toast(`Refreshed "${t!.name}" (${rows.length} rows).`, {
      kind: 'success',
      title: 'Refresh',
    });
  } catch (err) {
    api.ui.dialogs.toast(`Couldn't refresh "${t?.name ?? tableId}": ${(err as Error).message}`, {
      kind: 'error',
      title: 'Refresh',
    });
  }
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

async function openImport(api: HostApi): Promise<void> {
  const dlg = ImportDialog.instance ?? mountDialog();
  const result = await dlg.open({
    // Lets the dialog list an instance's databases so the user can pick one
    // before importing (a root URL otherwise defers the choice to a modal).
    async listDatabases(url) {
      const ref = parseDatasetteUrl(url);
      return fetchDatabaseNames((u) => api.backend.fetch(u), ref.base);
    },
  });
  if (!result) return; // cancelled

  const { url, file, kind, dbChosen, editColumns, maxRows, mode } = result;
  const label = file?.name ?? url;
  try {
    // Reference mode: create a live, read-only table whose rows are fetched from
    // the source on demand and never persisted or synced — all sources go
    // through the generic `url` provider, no connect dialog. A Datasette table
    // is just its `.json?_shape=array` endpoint (an array of row objects), so we
    // save that URL and treat it exactly like any other JSON reference.
    if (mode === 'reference' && !file) {
      if (kind === 'datasette') {
        await referenceDatasette(api, url);
      } else {
        await createUrlReference(api, url, kind);
      }
      return;
    }

    // Uploaded file: read its bytes locally (no network, no origin URL).
    if (file) {
      if (kind === 'csv') {
        // With a row cap, stream only the first `maxRows` rows instead of
        // loading the whole file — a 150 MB CSV read whole + parsed whole (all
        // before the cap applies) can silently kill a memory-limited tab, so a
        // capped import of a big file would do nothing.
        const text = maxRows != null ? await readCsvHead(file, maxRows) : await file.text();
        await importCsvText(api, text, file.name, {
          editColumns: editColumns ? editColumnNames : undefined,
          maxRows,
        });
      } else {
        const text = await file.text();
        await importJsonText(api, text, file.name, { maxRows });
      }
      api.ui.dialogs.toast(`Imported ${file.name}.`, { kind: 'success', title: 'Import' });
      return;
    }

    if (kind === 'datasette') {
      // importDatasette emits its own toasts. A table URL imports directly; a
      // database/instance URL opens the table picker before importing — unless
      // the user already picked a database here, in which case we import that
      // database's tables directly (skipTablePicker).
      await importDatasette(api, url, { skipTablePicker: dbChosen });
    } else if (kind === 'csv') {
      // Reads show a top progress bar only if they take more than ~2s.
      const text = await fetchImportTextWithBar(api, url, `Reading ${filenameFromUrl(url)}…`);
      // When "Edit columns" was checked, review/rename columns before creating
      // the table (importCsvText returns without inserting if the user cancels).
      await importCsvText(api, text, filenameFromUrl(url), {
        editColumns: editColumns ? editColumnNames : undefined,
        maxRows,
        // Remember where it came from so it can be refreshed / reloaded later.
        origin: { type: 'csv', url },
      });
      api.ui.dialogs.toast(`Imported ${filenameFromUrl(url)}.`, {
        kind: 'success',
        title: 'Import',
      });
    } else {
      const text = await fetchImportTextWithBar(api, url, `Reading ${filenameFromUrl(url)}…`);
      await importJsonText(api, text, filenameFromUrl(url), { originUrl: url, maxRows });
      api.ui.dialogs.toast(`Imported ${filenameFromUrl(url)}.`, {
        kind: 'success',
        title: 'Import',
      });
    }
  } catch (err) {
    api.ui.dialogs.toast(`Could not import ${label}: ${(err as Error).message}`, {
      kind: 'error',
      title: 'Import',
    });
  }
}

/** Pull the row records out of a parsed JSON body: a top-level array of objects,
 * or the first array-of-objects property (preferring `rows`/`records`/`data`). */
function jsonRecords(text: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);
  const isRecordArray = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) && v.every((x) => x != null && typeof x === 'object' && !Array.isArray(x));
  if (isRecordArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['rows', 'records', 'data']) {
      if (isRecordArray(obj[key])) return obj[key] as Array<Record<string, unknown>>;
    }
    for (const v of Object.values(obj)) if (isRecordArray(v)) return v;
  }
  return [];
}

/** Infer columns from the union of keys across the first rows of a JSON body. */
function inferJsonColumns(text: string): ColumnSpec[] {
  const records = jsonRecords(text).slice(0, 50);
  const typeOf = (v: unknown): ColumnType =>
    typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
  const cols = new Map<string, ColumnType>();
  for (const rec of records) {
    for (const [k, v] of Object.entries(rec)) {
      if (!cols.has(k) && v != null) cols.set(k, typeOf(v));
      else if (!cols.has(k)) cols.set(k, 'string');
    }
  }
  return [...cols.entries()].map(([field, type]) => ({ field, label: field, type }));
}

/**
 * Create a "reference" table for a plain CSV/JSON URL: a live, read-only table
 * whose rows are fetched on demand by the `url` row-source provider and never
 * persisted or synced. We fetch once here only to infer the columns; the rows
 * are served live by the provider (and re-fetched on Refresh).
 */
/**
 * Build the JSON rows endpoint for a Datasette table. We use the DEFAULT shape
 * (`{ ok, next, rows: [objects], truncated }`) — `?_shape=array` fails CORS on
 * datasette.io — with `_size=max` to pull the largest page the instance allows.
 * `jsonRecords` (and the url provider) read the `rows` array out of it.
 */
function datasetteJsonUrl(base: string, db: string, table: string): string {
  return `${base}/${encodeURIComponent(db)}/${encodeURIComponent(table)}.json?_size=max`;
}

/**
 * Reference one or many Datasette tables. A single-table URL references just
 * that table; a database URL references every (non-hidden) table in it; an
 * instance root references every table across every database. Each becomes a
 * live `url` reference (its `.json?_shape=array` endpoint), with one summary
 * toast for the batch.
 */
async function referenceDatasette(api: HostApi, url: string): Promise<void> {
  const ref = parseDatasetteUrl(url);
  const fetchFn = (u: string) => api.backend.fetch(u);

  const targets: Array<{ db: string; table: string }> = [];
  if (ref.db && ref.table) {
    targets.push({ db: ref.db, table: ref.table });
  } else if (ref.db) {
    for (const t of await fetchTablesForDb(fetchFn, ref.base, ref.db)) {
      if (!t.hidden) targets.push({ db: t.db, table: t.table });
    }
  } else {
    for (const db of await fetchDatabaseNames(fetchFn, ref.base)) {
      for (const t of await fetchTablesForDb(fetchFn, ref.base, db)) {
        if (!t.hidden) targets.push({ db: t.db, table: t.table });
      }
    }
  }
  if (targets.length === 0) throw new Error('No tables found to reference at that URL.');

  let ok = 0;
  const failed: string[] = [];
  for (const t of targets) {
    try {
      await createUrlReference(api, datasetteJsonUrl(ref.base, t.db, t.table), 'json', {
        nameHint: `${t.db}/${t.table}`,
        silent: true,
      });
      ok++;
    } catch (err) {
      failed.push(`${t.table}: ${(err as Error).message}`);
    }
  }
  api.ui.dialogs.toast(
    `Referenced ${ok} table${ok === 1 ? '' : 's'}${failed.length ? ` — ${failed.length} failed` : ''}.`,
    { kind: failed.length ? 'warning' : 'success', title: 'Reference' },
  );
}

async function createUrlReference(
  api: HostApi,
  url: string,
  format: 'csv' | 'json',
  opts: { nameHint?: string; silent?: boolean } = {},
): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('No active workspace.');
  const baseName = opts.nameHint ?? filenameFromUrl(url);
  const text = await fetchImportTextWithBar(api, url, `Reading ${baseName}…`);
  const columns = format === 'csv' ? parseCsv(text).columns : inferJsonColumns(text);
  if (columns.length === 0) throw new Error('No columns found in the referenced data.');

  // Keep the name unique in the workspace (references don't overwrite).
  const taken = new Set(
    (await api.store.tables.find())
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => t.name.toLowerCase()),
  );
  let name = baseName;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${baseName}-${i}`;

  const table: Table = {
    id: cryptoUUID(),
    workspaceId,
    name,
    code: slug(name),
    columns,
    view: 'table',
    // A live source: the routed data store serves rows via the `url` provider,
    // so nothing is stored locally and gist sync carries the definition only.
    source: { type: 'url', config: { url, format } },
    updatedAt: Date.now(),
  };
  await api.store.tables.insert(table);
  if (!opts.silent) {
    api.ui.dialogs.toast(`Referenced ${name} — live, read-only.`, {
      kind: 'success',
      title: 'Reference',
    });
  }
}

function mountDialog(): ImportDialog {
  const el = document.createElement('import-dialog') as ImportDialog;
  document.body.appendChild(el);
  return el;
}

/**
 * Best-effort guess for a free-typed URL. Predefined sources carry their own
 * kind, so this only runs for custom input left on "Auto-detect". A `.json`
 * suffix (or the absence of Datasette markers) reads as a dump; a Datasette
 * host or `?_`-prefixed API params read as a Datasette table. Ambiguous cases
 * can always be forced with the "Import as" selector.
 */
function detectKind(url: string): ResolvedKind {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const hasDatasetteParams = [...u.searchParams.keys()].some((k) => k.startsWith('_'));
    // A `.csv`/`.json` file path with no Datasette markers reads as that file
    // kind. Anything on a datasette host (or carrying `?_`-prefixed API params)
    // reads as Datasette — at any depth, so instance and database URLs work too.
    const looksDatasette = host.includes('datasette') || hasDatasetteParams;
    if (!hasDatasetteParams && /\.(csv|tsv|tab)$/i.test(u.pathname)) return 'csv';
    if (!hasDatasetteParams && /\.json$/i.test(u.pathname)) return 'json';
    if (looksDatasette) return 'datasette';
    return 'json';
  } catch {
    return 'json';
  }
}

/**
 * True when `url` is a bare Datasette instance root (an origin/mount with no
 * `/db` or `/db/table` segment). Those are the URLs for which we can offer a
 * database picker — a db or table URL already names its target.
 */
function isDatasetteInstanceRoot(url: string, kind: ResolvedKind): boolean {
  if (kind !== 'datasette' || !url) return false;
  try {
    const ref = parseDatasetteUrl(url);
    return !ref.db && !ref.table;
  } catch {
    return false;
  }
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? last : 'sample.db.json';
  } catch {
    return 'sample.db.json';
  }
}

interface ImportChoice {
  /** Source URL. Empty when importing an uploaded {@link ImportChoice.file}. */
  url: string;
  /** An uploaded local file to import instead of a URL. */
  file?: File | undefined;
  kind: ResolvedKind;
  /**
   * `copy` (default) imports a local snapshot: rows are persisted + synced and
   * the schema is editable + refreshable. `reference` creates a live, read-only
   * table whose rows are fetched from the source on demand and never persisted
   * or synced. Reference needs a re-fetchable URL, so it's unavailable for
   * uploaded files.
   */
  mode: 'copy' | 'reference';
  /**
   * True when the user picked a specific database from the dialog's dropdown
   * (an instance-root URL narrowed to `.../db`). The datasette importer then
   * skips the table checklist and imports that database's tables directly.
   */
  dbChosen?: boolean;
  /** True when "Edit columns" was checked — open the column editor pre-import (CSV). */
  editColumns?: boolean;
  /** Cap on the number of rows imported (the "Limit rows" option); undefined ⇒ all. */
  maxRows?: number | undefined;
}

/** Resolve a CSV/JSON kind from a filename (uploads have no URL to inspect). */
function detectKindFromName(name: string): ResolvedKind {
  return /\.(csv|tsv|tab)$/i.test(name) ? 'csv' : 'json';
}

/**
 * The Import dialog. Kept inside this plugin module (rather than the shared
 * chrome in src/dialogs/) because it's opened from nowhere else — reached via
 * the static `instance` accessor, the same pattern host-dialogs and
 * script-editor-dialog use. Mounted lazily into <body> on first open.
 */
@customElement('import-dialog')
export class ImportDialog extends LitElement {
  static instance: ImportDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 420px;
        max-width: 560px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.85rem;
        color: #374151;
      }
      label.check {
        flex-direction: row;
        align-items: center;
        gap: 0.4rem;
      }
      label.check input {
        width: auto;
      }
      input[type='text'],
      input[type='number'],
      input[type='file'],
      select {
        font: inherit;
        padding: 0.45rem 0.55rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
        background: white;
      }
      input:disabled {
        background: #f3f4f6;
        color: #9ca3af;
      }
      .row {
        display: flex;
        gap: 0.75rem;
      }
      .row > * {
        flex: 1;
      }
      .mode-row {
        flex-direction: column;
        gap: 0.35rem;
      }
      .hint {
        color: #6b7280;
        font-size: 0.78rem;
        margin: 0;
      }
      .hint.error {
        color: #b91c1c;
      }
      .db-row {
        align-items: stretch;
      }
      .db-row select {
        flex: 1;
      }
      .db-row .db-load {
        flex: 0 0 auto;
        white-space: nowrap;
      }
    `,
  ];

  @state() private url = '';
  @state() private kind: ImportKind = 'auto';
  @state() private presetIdx = -1;
  @state() private dbList: string[] | null = null;
  @state() private dbLoading = false;
  @state() private dbError = '';
  @state() private selectedDb = '';
  @state() private editColumns = false;
  @state() private file: File | null = null;
  @state() private maxRowsInput = '';
  @state() private mode: 'copy' | 'reference' = 'copy';

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ImportChoice | null) => void) | null = null;
  private listDatabases: ((url: string) => Promise<string[]>) | null = null;

  /**
   * The concrete kind, resolving `auto` from the uploaded file's name (if any)
   * or the current URL.
   */
  private get resolvedKind(): ResolvedKind {
    if (this.kind !== 'auto') return this.kind;
    if (this.file) return detectKindFromName(this.file.name);
    return detectKind(this.url.trim());
  }

  /** Parsed "Limit rows" value: a positive integer, or undefined for "all". */
  private get maxRows(): number | undefined {
    const n = Math.floor(Number(this.maxRowsInput));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  /** Reset any loaded database list (URL/kind changed → the list is stale). */
  private resetDbList(): void {
    this.dbList = null;
    this.selectedDb = '';
    this.dbError = '';
    this.dbLoading = false;
  }

  /** Fetch the entered instance's database list into the picker. */
  private async loadDatabases(): Promise<void> {
    const url = this.url.trim();
    if (!url || !this.listDatabases) return;
    this.dbLoading = true;
    this.dbError = '';
    this.dbList = null;
    this.selectedDb = '';
    try {
      const dbs = await this.listDatabases(url);
      this.dbList = dbs;
      if (dbs.length === 0) this.dbError = 'No databases found at that instance.';
      else if (dbs.length === 1) this.selectedDb = dbs[0]!;
    } catch (err) {
      this.dbError = (err as Error)?.message ?? 'Could not list databases.';
    } finally {
      this.dbLoading = false;
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    ImportDialog.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (ImportDialog.instance === this) ImportDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  /** Open the dialog. Resolves with the chosen URL + kind, or null on cancel. */
  open(opts?: {
    listDatabases?: (url: string) => Promise<string[]>;
  }): Promise<ImportChoice | null> {
    this.url = '';
    this.kind = 'auto';
    this.presetIdx = -1;
    this.editColumns = false;
    this.file = null;
    this.maxRowsInput = '';
    this.mode = 'copy';
    this.resetDbList();
    this.listDatabases = opts?.listDatabases ?? null;
    return new Promise<ImportChoice | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  private finish(value: ImportChoice | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    // Resolve after the close so awaited code sees the dialog gone.
    queueMicrotask(() => resolve?.(value));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  private onPresetChange(e: Event): void {
    const idx = Number((e.target as HTMLSelectElement).value);
    this.presetIdx = idx;
    this.resetDbList();
    const preset = PREDEFINED[idx];
    if (preset) {
      this.url = preset.url;
      this.kind = preset.kind;
    }
  }

  private submit = (e: Event): void => {
    e.preventDefault();
    const url = this.url.trim();
    // Either an uploaded file OR a URL is required.
    if (!url && !this.file) return;
    const kind = this.resolvedKind;
    const maxRows = this.maxRows;
    // "Edit columns" only applies to CSV (single-table, columns known up front).
    const editColumns = kind === 'csv' && this.editColumns;

    // A file can't be a live reference (nothing to re-fetch), so force copy.
    const mode: 'copy' | 'reference' = this.file ? 'copy' : this.mode;

    // Uploaded file: no URL/database picker applies — import its bytes directly.
    if (this.file) {
      this.finish({ url: '', file: this.file, kind, editColumns, maxRows, mode });
      return;
    }

    // If a database was picked for an instance-root URL, narrow the URL to that
    // database and flag it so the importer imports that db's tables directly
    // (no second table-select dialog — the user already committed to the db).
    const dbChosen =
      kind === 'datasette' && !!this.selectedDb && isDatasetteInstanceRoot(url, kind);
    const finalUrl = dbChosen
      ? `${url.replace(/\/+$/, '')}/${encodeURIComponent(this.selectedDb)}`
      : url;
    this.finish({ url: finalUrl, kind, dbChosen, editColumns, maxRows, mode });
  };

  private onFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    this.file = f;
    if (f) {
      // A file supersedes a URL/preset; clear them so submit is unambiguous.
      this.url = '';
      this.presetIdx = -1;
      this.resetDbList();
    }
  }

  /**
   * Database picker, shown only for a Datasette instance-root URL. "List
   * databases" fetches the instance's databases; choosing one narrows the
   * import to that database (its tables are picked next). Leaving it on
   * "all databases" keeps the existing behaviour (a modal db picker on submit).
   */
  private renderDbPicker() {
    if (!this.listDatabases || !isDatasetteInstanceRoot(this.url.trim(), this.resolvedKind)) {
      return nothing;
    }
    return html`
      <label>
        Database
        <div class="row db-row">
          <select
            .value=${this.selectedDb}
            ?disabled=${!this.dbList || this.dbList.length === 0}
            @change=${(e: Event) => {
              this.selectedDb = (e.target as HTMLSelectElement).value;
            }}
          >
            ${this.dbList
              ? html`
                  <option value="" ?selected=${this.selectedDb === ''}>
                    — all databases (choose tables next) —
                  </option>
                  ${this.dbList.map(
                    (d) =>
                      html`<option value=${d} ?selected=${d === this.selectedDb}>${d}</option>`,
                  )}
                `
              : html`<option value="">— not loaded —</option>`}
          </select>
          <button
            type="button"
            class="ghost db-load"
            ?disabled=${this.dbLoading}
            @click=${() => void this.loadDatabases()}
          >
            ${this.dbLoading ? 'Loading…' : this.dbList ? 'Refresh' : 'List databases'}
          </button>
        </div>
      </label>
      ${this.dbError ? html`<p class="hint error">${this.dbError}</p>` : nothing}
    `;
  }

  override render() {
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>
          ×
        </button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>Import</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary">Import</button>
            </div>
          </div>
          <div class="dialog-body">
            <label>
              Sample source
              <select
                .value=${String(this.presetIdx)}
                @change=${(e: Event) => this.onPresetChange(e)}
              >
                <option value="-1" ?selected=${this.presetIdx === -1}>— choose a sample —</option>
                ${PREDEFINED.map(
                  (p, i) =>
                    html`<option value=${String(i)} ?selected=${i === this.presetIdx}>
                      ${p.label}
                    </option>`,
                )}
              </select>
            </label>

            <label>
              URL
              <input
                type="text"
                autofocus
                placeholder="https://… (JSON dump, .csv/.tsv file, or Datasette table)"
                ?disabled=${!!this.file}
                .value=${this.url}
                @input=${(e: Event) => {
                  this.url = (e.target as HTMLInputElement).value;
                  // A hand-edited URL is no longer "a preset" or an upload; drop
                  // any stale database list (it belonged to the previous instance).
                  this.presetIdx = -1;
                  this.file = null;
                  this.resetDbList();
                }}
              />
            </label>

            <label>
              …or upload a file
              <input
                type="file"
                accept=".csv,.tsv,.tab,.json,.txt,text/csv,text/tab-separated-values,application/json"
                @change=${(e: Event) => this.onFileChange(e)}
              />
            </label>
            ${this.file
              ? html`<p class="hint">
                  Importing <strong>${this.file.name}</strong> as
                  ${this.resolvedKind.toUpperCase()}.
                </p>`
              : nothing}

            <label>
              Import as
              <select
                .value=${this.kind}
                @change=${(e: Event) => {
                  this.kind = (e.target as HTMLSelectElement).value as ImportKind;
                  this.resetDbList();
                }}
              >
                <option value="auto" ?selected=${this.kind === 'auto'}>Auto-detect</option>
                <option value="json" ?selected=${this.kind === 'json'}>JSON dump</option>
                <option value="csv" ?selected=${this.kind === 'csv'}>CSV / TSV file</option>
                <option value="datasette" ?selected=${this.kind === 'datasette'}>
                  Datasette (table or instance)
                </option>
              </select>
            </label>

            <label>
              Import mode
              <div class="row mode-row">
                <label class="check">
                  <input
                    type="radio"
                    name="import-mode"
                    .checked=${this.mode === 'copy'}
                    @change=${() => (this.mode = 'copy')}
                  />
                  Copy — a local, editable, synced snapshot you can refresh
                </label>
                <label class="check">
                  <input
                    type="radio"
                    name="import-mode"
                    ?disabled=${!!this.file}
                    .checked=${this.mode === 'reference'}
                    @change=${() => (this.mode = 'reference')}
                  />
                  Reference — live, read-only; rows never stored or synced
                </label>
              </div>
            </label>
            ${this.file
              ? html`<p class="hint">Uploaded files can only be imported as a Copy.</p>`
              : nothing}
            ${this.renderDbPicker()}
            ${this.resolvedKind === 'csv'
              ? html`<label class="check">
                  <input
                    type="checkbox"
                    .checked=${this.editColumns}
                    @change=${(e: Event) =>
                      (this.editColumns = (e.target as HTMLInputElement).checked)}
                  />
                  Edit columns before import (rename / hide / fix duplicate names)
                </label>`
              : nothing}

            <label>
              Limit rows (optional)
              <input
                type="number"
                min="1"
                step="1"
                placeholder="import all rows"
                .value=${this.maxRowsInput}
                @input=${(e: Event) => (this.maxRowsInput = (e.target as HTMLInputElement).value)}
              />
            </label>
            ${this.resolvedKind === 'datasette' && this.maxRows != null
              ? html`<p class="hint">
                  Row limit applies to CSV/JSON imports; Datasette snapshots use their own
                  10,000-row cap.
                </p>`
              : nothing}

            <p class="hint">
              Paste any URL or pick a sample above — a JSON dump, a <code>.csv</code> or
              <code>.tsv</code> file, or a Datasette table/database/instance. For a Datasette
              instance root, click <em>List databases</em> to pick one first. Multi-table sources
              let you choose which tables to import; Datasette tables import a read-only snapshot
              (capped at 10,000 rows each).
            </p>
          </div>
        </form>
      </dialog>
      ${nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'import-dialog': ImportDialog;
  }
}
