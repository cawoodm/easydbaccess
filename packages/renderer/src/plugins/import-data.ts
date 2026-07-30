// packages/renderer/src/plugins/import-data.ts
//
// easyDBAccess built-in plugin — the "Import" header button. Opens a dialog
// where the user pastes any URL or picks a predefined source from a dropdown
// (our Northwind sample dump plus a few public Datasette tables), then routes
// the import to the right engine:
//   - a format on the import kernel (csv, json) -> runImport does the rest
//   - a native .db.json dump -> json-import's restoreWorkspaceDump
//   - Datasette -> datasette-import's importDatasette (not on the kernel yet)
//
// This is the grown-up replacement for the old single-prompt "Load sample data"
// button: same Northwind default, but now Datasette tables are reachable from
// the UI too (the datasette-source plugin only registered an unsurfaced URL
// source and a file-only drop handler, so there was no clickable way in).

import type {
  ColumnSpec,
  ColumnType,
  HostApi,
  ImporterSpec,
  ImportSourceInput,
  PluginModule,
  Table,
} from '@easydb/shared';
import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { getContext } from '../app-context.js';
import { editColumnNames } from '../dialogs/column-names-dialog.js';
import { ctrlEnterSubmits, dialogChromeStyles } from '../dialogs/dialog-chrome.js';
import { makeDialogDraggable } from '../dialogs/draggable.js';
import { parseCsv } from './csv-import.js';
import { fetchDatabaseNames, parseDatasetteUrl } from './datasette-client.js';
import { resolveChosenTables } from './datasette-common.js';
import { importDatasette } from './datasette-import.js';
import { cryptoUUID, slugTable } from '../util/ids.js';
import { isWorkspaceDump, restoreWorkspaceDump } from './json-import.js';
import { fetchImportTextWithBar, filenameFromUrl } from '../import/fetch-source.js';
import { runImport, type RunImportResult } from '../import/import-kernel.js';
import { refreshFromOrigin } from '../import/refresh.js';
import type { ImportTarget } from '../import/land-tables.js';

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

  // Refresh a snapshot a kernel importer made, by re-reading its origin URL.
  // Datasette snapshots keep their own Refresh in `datasette-import`, because
  // that one also drives a progress bar and a resumable paged read.
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
 * Reload a snapshot table from the URL it was imported from, through the
 * importer that made it.
 *
 * This used to wipe every row and re-parse, never re-discovering columns — so a
 * source that had grown a column never showed it, and a column the user had
 * added locally lost its values. `refreshFromOrigin` gives every kernel importer
 * the behaviour Datasette already had: reconcile the columns against the user's
 * arrangement, honour `deletedColumns`, and merge rows by primary key when the
 * origin recorded them.
 */
async function refreshImported(api: HostApi, tableId: string): Promise<void> {
  const t = await api.store.tables.findOne(tableId);
  if (!t?.origin?.url) return;
  try {
    const spec = await findKernelImporter(t.origin.type as ResolvedKind);
    if (!spec) {
      throw new Error(`No importer is installed that can read a "${t.origin.type}" source.`);
    }
    const res = await refreshFromOrigin(api, t, spec);
    const notes: string[] = [];
    if (res.newFields.length > 0) {
      notes.push(`${res.newFields.length} new column${res.newFields.length === 1 ? '' : 's'}`);
    }
    if (!res.merged && res.rowCount > 0) notes.push('rows replaced (no primary key to match on)');
    api.ui.dialogs.toast(
      `Refreshed "${t.name}" (${res.rowCount.toLocaleString()} rows)` +
        `${notes.length ? ` — ${notes.join(', ')}` : ''}.`,
      { kind: res.newFields.length > 0 ? 'warning' : 'success', title: 'Refresh' },
    );
  } catch (err) {
    api.ui.dialogs.toast(`Couldn't refresh "${t.name}": ${(err as Error).message}`, {
      kind: 'error',
      title: 'Refresh',
    });
  }
}

async function openImport(api: HostApi, presetKind: ImportKind = 'auto'): Promise<void> {
  const dlg = ImportDialog.instance ?? mountDialog();
  const result = await dlg.open({
    presetKind,
    // Lets the dialog list an instance's databases so the user can pick one
    // before importing (a root URL otherwise defers the choice to a modal).
    async listDatabases(url) {
      const ref = parseDatasetteUrl(url);
      return fetchDatabaseNames((u) => api.backend.fetch(u), ref.base);
    },
    // Destinations for "Append to" / "Replace the rows of".
    async listTables() {
      const ws = api.workspaceId();
      return (await api.store.tables.find())
        .filter((t) => t.workspaceId === ws && !t.source)
        .map((t) => ({ id: t.id, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
  if (!result) return; // cancelled

  const { url, file, kind, dbChosen, editColumns, maxRows, mode, panel, target } = result;
  const label = file?.name ?? url;
  // The one common hook, handed to whichever importer runs. Each calls it with
  // the schema it discovered; a multi-table source calls it once per table.
  const editHook = editColumns
    ? (columns: ColumnSpec[], subject?: string) => editColumnNames(columns, subject)
    : undefined;
  // The CSV options panel's separator. Only csv reads it.
  const separator = typeof panel.separator === 'string' ? panel.separator : undefined;
  try {
    // Formats that have moved onto the kernel take the WHOLE path through it —
    // reference, upload and URL alike. The kernel owns the listing, the table
    // picker, the row cap, the naming, the collision policy and the write, so
    // there is nothing left here to branch on. The remaining `if/else` below is
    // the not-yet-migrated formats; it shrinks to nothing as the phases land.
    const spec = await findKernelImporter(kind);
    if (spec) {
      // A `.db.json` is not a table, it is a whole workspace — geometry, views,
      // filters and all. Importing its tables would silently throw that away,
      // so the dump is offered to the restore path instead. Sniffing the body
      // costs one read, which is then handed to the kernel as `text` so nothing
      // is fetched twice.
      const sniffed = kind === 'json' ? await sniffJson(api, url, file, maxRows, mode) : null;
      if (sniffed?.isDump) {
        const restore = await api.ui.dialogs.confirm(
          `"${label}" is a workspace dump, not a plain table. Restore it — tables, window ` +
            `layout, views and filters? Choose Cancel to import only its tables as data.`,
          'Restore workspace',
        );
        if (restore) {
          await restoreWorkspaceDump(api, sniffed.text, label, {
            maxRows,
            editColumns: editHook,
            ...(file ? {} : { originUrl: url }),
          });
          return;
        }
      }

      // The body may already be read, in which case the input carries `text`
      // and the source name has to travel with it — `label` is the whole URL,
      // which is not a table name.
      const sourceName = file ? file.name : filenameFromUrl(url);
      const input: ImportSourceInput = sniffed
        ? { kind: 'text', text: sniffed.text, name: sourceName }
        : file
          ? { kind: 'file', file }
          : { kind: 'url', url };
      const res = await runImport(api, spec, input, {
        mode,
        target,
        maxRows,
        panel,
        // The body was already read, so the input no longer names its source.
        ...(sniffed && !file ? { origin: { type: spec.id, url } } : {}),
        ...(editHook ? { editColumns: (cols: ColumnSpec[]) => editHook(cols) } : {}),
      });
      if (!spec.ownToasts) reportImport(api, res, label);
      return;
    }

    // --- Not yet on the kernel: datasette (Phase D). -------------------------

    // Reference mode: a live, read-only table whose rows are fetched from the
    // source on demand and never persisted or synced, through the generic `url`
    // provider. A Datasette table is just its `.json` endpoint (an array of row
    // objects), so we save that URL and treat it like any other JSON reference.
    if (mode === 'reference' && !file) {
      if (kind === 'datasette') {
        await referenceDatasette(api, url);
      } else {
        await createUrlReference(api, url, kind);
      }
      return;
    }

    // importDatasette emits its own toasts. A table URL imports directly; a
    // database/instance URL opens the table picker before importing — unless
    // the user already picked a database here, in which case we import that
    // database's tables directly (skipTablePicker).
    await importDatasette(api, url, {
      skipTablePicker: dbChosen,
      maxRows,
      editColumns: editHook,
    });
  } catch (err) {
    api.ui.dialogs.toast(`Could not import ${label}: ${(err as Error).message}`, {
      kind: 'error',
      title: 'Import',
    });
  }
}

/**
 * Read a JSON body once and say whether it is a workspace dump. Returns null
 * when there is nothing to read. The text is passed back so the caller can
 * hand it straight to whichever path wins, instead of fetching it again.
 */
async function sniffJson(
  api: HostApi,
  url: string,
  file: File | undefined,
  maxRows: number | undefined,
  mode: 'copy' | 'reference',
): Promise<{ text: string; isDump: boolean } | null> {
  // A Reference never reads the whole body to write it, so leave that path to
  // the kernel — and a dump cannot be referenced anyway.
  if (mode === 'reference') return null;
  const text = file
    ? await file.text()
    : await fetchImportTextWithBar(
        api,
        url,
        `Reading ${filenameFromUrl(url)}…`,
        maxRows != null ? { maxBytes: null } : {},
      );
  try {
    return { text, isDump: isWorkspaceDump(JSON.parse(text)) };
  } catch {
    // Not valid JSON. Let the importer report it with its own message.
    return { text, isDump: false };
  }
}

/**
 * The registered importer for `kind`, but only if it runs on the kernel. Any
 * other format keeps its own route below until its phase lands.
 */
async function findKernelImporter(kind: ResolvedKind): Promise<ImporterSpec | undefined> {
  const { registries } = await getContext();
  return registries.importers.find((s) => s.id === kind && s.supports?.kernel === true);
}

/** One toast for a kernel import, however many tables it produced. */
function reportImport(api: HostApi, res: RunImportResult, label: string): void {
  if (res.cancelled && res.landed.length === 0) return;

  const rows = res.landed.reduce((n, l) => n + l.rowCount, 0);
  const what =
    res.landed.length === 1
      ? `"${res.landed[0]!.tableName}"`
      : `${res.landed.length} tables from ${label}`;

  if (res.landed.length > 0) {
    const suffix = res.failed.length > 0 ? ` — ${res.failed.length} failed` : '';
    api.ui.dialogs.toast(`Imported ${what} (${rows.toLocaleString()} rows)${suffix}.`, {
      kind: res.failed.length > 0 ? 'warning' : 'success',
      title: 'Import',
    });
    return;
  }

  // Nothing landed. Surface the reason rather than a bare "0 tables".
  const why = res.failed.map((f) => `${f.name}: ${f.error}`).join('; ');
  api.ui.dialogs.toast(`Could not import ${label}${why ? ` — ${why}` : ''}.`, {
    kind: 'error',
    title: 'Import',
  });
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

  // The same picker Import and Connect use. Referencing a database or an
  // instance root used to silently take EVERY table, which is rarely what
  // someone pasting a database URL wants.
  const targets = await resolveChosenTables(fetchFn, ref, 'Reference');
  if (targets === null) return; // cancelled
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
  // No size ceiling for a reference: it persists nothing, so the "a huge copy
  // OOMs the tab and floods IndexedDB" reasoning behind the limit does not
  // apply. We read the body once here only to infer the columns.
  const text = await fetchImportTextWithBar(api, url, `Reading ${baseName}…`, { maxBytes: null });
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
    code: slugTable(name),
    columns,
    view: 'table',
    // A live source: the routed data store serves rows via the `url` provider,
    // so nothing is stored locally and gist sync carries the definition only.
    source: { type: 'url', config: { url, format } },
    // The rows live at the source and the provider throws on every write, so
    // the grid must not offer editors it cannot honour.
    readonly: true,
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
  /** True when "Edit columns" was checked — open the column editor pre-import. */
  editColumns?: boolean;
  /** Cap on the number of rows imported (the "Limit rows" option); undefined ⇒ all. */
  maxRows?: number | undefined;
  /**
   * Whatever the chosen importer's own options panel reported, e.g. the CSV
   * separator. Opaque to the dialog — it only reads the element's `value` and
   * hands it on.
   */
  panel: Record<string, unknown>;
  /**
   * Where the rows go, chosen BEFORE the read starts. Only meaningful for an
   * importer that declares `supports.target`; the others still run their own
   * collision prompt and this stays `{ kind: 'new' }`.
   */
  target: ImportTarget;
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
      /*
       * The dialog is two blocks: the options EVERY importer has (source,
       * mode, edit-columns, row limit), then the options only the chosen
       * importer has. Keeping them visually separate is the whole point —
       * see .claude/plans/2026-07-28-importer-architecture.md.
       */
      fieldset.block {
        border: 1px solid #e5e7eb;
        border-radius: 0.35rem;
        padding: 0.85rem 0.9rem 0.9rem;
        margin: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
      }
      fieldset.block > legend {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #6b7280;
        padding: 0 0.35rem;
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
  @state() private targetKind: 'new' | 'append' | 'overwrite' = 'new';
  @state() private targetTableId = '';
  /** Tables in the workspace, for the append/overwrite picker. */
  @state() private tables: Array<{ id: string; name: string }> = [];

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ImportChoice | null) => void) | null = null;
  private listDatabases: ((url: string) => Promise<string[]>) | null = null;

  /**
   * True when the chosen importer takes its destination from this dialog. Only
   * then is the Target control shown — an importer still running its own
   * collision prompt would ignore whatever the user picked here.
   */
  private get supportsTarget(): boolean {
    return this.formats.find((f) => f.id === this.resolvedKind)?.kernel === true;
  }

  /** The destination, as the kernel wants it. Reference always makes a new table. */
  private get target(): ImportTarget {
    if (this.mode === 'reference' || this.targetKind === 'new' || !this.targetTableId) {
      return { kind: 'new' };
    }
    return { kind: this.targetKind, tableId: this.targetTableId };
  }

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

  /**
   * Mount the active importer's own options element into the plugin block.
   *
   * Done imperatively rather than with a Lit template because the tag name is
   * a runtime string from the registry, and because we need the element itself
   * to read its `value` on submit. The element is defined by its own plugin
   * (csv-import loads `<csv-import-options>` from `init`), so the dialog stays
   * free of plugin imports — which is the point of the panel contract.
   */
  override updated(): void {
    const host = this.shadowRoot?.querySelector('.panel-slot') as HTMLElement | null;
    if (!host) {
      // The whole block went away (a format with no panel). Forget what was
      // mounted, so switching back to a panelled format mounts a fresh one.
      this.panelEl = null;
      this.mountedPanel = '';
      return;
    }
    const tag = this.activePanelTag;
    const want = tag ? `${tag}#${this.panelGeneration}` : '';
    if (want === this.mountedPanel) return;
    host.replaceChildren();
    this.panelEl = null;
    this.mountedPanel = want;
    if (!tag) return;
    const el = document.createElement(tag);
    // A panel reports its own edits; re-render so anything keyed off its value
    // (a hint, a dependent field) stays in step.
    el.addEventListener('change', () => this.requestUpdate());
    host.appendChild(el);
    this.panelEl = el;
  }

  /** The `ImporterSpec.panel` tag for the resolved format, if it declares one. */
  private get activePanelTag(): string | undefined {
    return this.formats.find((f) => f.id === this.resolvedKind)?.panel;
  }

  /** Human label of the resolved format, for the plugin block's legend. */
  private get activeLabel(): string {
    return this.formats.find((f) => f.id === this.resolvedKind)?.label ?? this.resolvedKind;
  }

  /** Values the active panel reports, merged into the import as `ctx.panel`. */
  private panelValue(): Record<string, unknown> {
    const v = (this.panelEl as { value?: unknown } | null)?.value;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  }

  private panelEl: HTMLElement | null = null;
  private mountedPanel = '';
  /** Bumped on each open so a re-opened dialog gets a FRESH panel, not the last one's values. */
  private panelGeneration = 0;

  /**
   * The formats offered by "Import as", built from the importer REGISTRY at
   * open time — so a new importer plugin appears here with no edit to this
   * file. `id` is the option value, which is also the dialog's `kind`, so a
   * registered `ImporterSpec.id` must match a kind the dispatcher understands
   * until the kernel takes over the dispatch in Phase C.
   *
   * Staging note: `datasette-source` declares `meta.type: 'source'` and
   * registers no `ImporterSpec`, so its entry is appended by hand. Phase D
   * splits it into `datasette-import` + `datasette-connect`, after which this
   * fallback goes and the list is purely the registry.
   */
  @state() private formats: Array<{
    id: string;
    label: string;
    panel?: string | undefined;
    /** The importer runs on the kernel, so the dialog owns its destination. */
    kernel?: boolean | undefined;
  }> = [];

  private async loadFormats(): Promise<void> {
    const { registries } = await getContext();
    const registered = [...registries.importers]
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
      .map((s) => ({ id: s.id, label: s.label, panel: s.panel, kernel: s.supports?.kernel }));
    const withDatasette = registered.some((f) => f.id === 'datasette')
      ? registered
      : [...registered, { id: 'datasette', label: 'Datasette (table or instance)' }];
    this.formats = withDatasette;

    // The file input's filter is now the union of what the importers declare,
    // instead of a hand-maintained string that silently omitted new formats.
    const exts = new Set<string>(['.txt']);
    for (const spec of registries.importers) for (const a of spec.accept ?? []) exts.add(a);
    this.acceptAttr = [...exts].join(',');
  }

  @state() private acceptAttr = '.txt';

  /** Open the dialog. Resolves with the chosen URL + kind, or null on cancel. */
  open(opts?: {
    listDatabases?: (url: string) => Promise<string[]>;
    /** Workspace tables offered as append/overwrite destinations. */
    listTables?: () => Promise<Array<{ id: string; name: string }>>;
    /** Preselect the format, e.g. when the Import menu already chose one. */
    presetKind?: ImportKind | undefined;
  }): Promise<ImportChoice | null> {
    this.targetKind = 'new';
    this.targetTableId = '';
    this.tables = [];
    void opts?.listTables?.().then((t) => {
      this.tables = t;
    });
    this.url = '';
    this.kind = opts?.presetKind ?? 'auto';
    this.presetIdx = -1;
    this.editColumns = false;
    this.file = null;
    this.maxRowsInput = '';
    this.mode = 'copy';
    this.panelGeneration += 1;
    this.resetDbList();
    this.listDatabases = opts?.listDatabases ?? null;
    // Re-read the registry on every open so a plugin installed since last time
    // (the Plugin Manager hot-loads) shows up without a reload. The modal must
    // not open until the format options have rendered — a caller that selects a
    // format the instant the dialog appears would otherwise race an empty list.
    const formatsReady = this.loadFormats();
    return new Promise<ImportChoice | null>((resolve) => {
      this.resolveFn = resolve;
      void formatsReady.then(() => this.updateComplete).then(() => this.dialogEl?.showModal());
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
    // "Edit columns" is a common option — every importer opens the editor with
    // whatever schema it discovered. A Reference has no local schema to edit.
    const editColumns = this.editColumns && this.mode === 'copy';
    const panel = this.panelValue();
    const target = this.supportsTarget ? this.target : ({ kind: 'new' } as ImportTarget);

    // A file can't be a live reference (nothing to re-fetch), so force copy.
    const mode: 'copy' | 'reference' = this.file ? 'copy' : this.mode;

    // Uploaded file: no URL/database picker applies — import its bytes directly.
    if (this.file) {
      this.finish({ url: '', file: this.file, kind, editColumns, maxRows, mode, panel, target });
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
    this.finish({ url: finalUrl, kind, dbChosen, editColumns, maxRows, mode, panel, target });
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

  /**
   * Where the rows land, chosen up front. This is the control that replaces the
   * "a table named X already exists — Append / Overwrite / Create new" modal
   * that used to interrupt an import halfway through. It is only shown for an
   * importer that declares `supports.target`; the rest still prompt.
   *
   * A Reference always creates a new table, so the control is hidden then.
   */
  private renderTarget() {
    if (!this.supportsTarget || this.mode === 'reference') return nothing;
    const needsTable = this.targetKind !== 'new';
    return html`
      <label>
        Import into
        <div class="row db-row">
          <select
            data-testid="import-target"
            .value=${this.targetKind}
            @change=${(e: Event) => {
              this.targetKind = (e.target as HTMLSelectElement).value as typeof this.targetKind;
              // Default to the first table so "Append" is never a silent no-op.
              if (this.targetKind !== 'new' && !this.targetTableId) {
                this.targetTableId = this.tables[0]?.id ?? '';
              }
            }}
          >
            <option value="new" ?selected=${this.targetKind === 'new'}>A new table</option>
            <option value="append" ?selected=${this.targetKind === 'append'}>
              Append to an existing table
            </option>
            <option value="overwrite" ?selected=${this.targetKind === 'overwrite'}>
              Replace the rows of an existing table
            </option>
          </select>
          ${needsTable
            ? html`<select
                data-testid="import-target-table"
                .value=${this.targetTableId}
                @change=${(e: Event) => {
                  this.targetTableId = (e.target as HTMLSelectElement).value;
                }}
              >
                ${this.tables.length === 0
                  ? html`<option value="">— no tables yet —</option>`
                  : this.tables.map(
                      (t) =>
                        html`<option value=${t.id} ?selected=${t.id === this.targetTableId}>
                          ${t.name}
                        </option>`,
                    )}
              </select>`
            : nothing}
        </div>
      </label>
      ${needsTable
        ? html`<p class="hint">
            The table keeps its own columns. Values map onto them the way the format requires — a
            CSV by column position, so its header names need not match.
          </p>`
        : nothing}
    `;
  }

  /**
   * The second block: only the chosen importer's own options. The dialog knows
   * nothing about what is inside it — the importer declares a `panel` tag and
   * the element goes in the slot (see `updated`).
   *
   * The Datasette database picker is the one exception. `datasette-source` is
   * still a `source` plugin with no `ImporterSpec`, so it has no panel to
   * declare. Phase D splits it into `datasette-import` + `datasette-connect`,
   * and the picker moves into that importer's own panel element. Until then it
   * is rendered here, in the right block, by hand.
   */
  private renderPluginBlock() {
    const dbPicker = this.renderDbPicker();
    const hasPanel = !!this.activePanelTag;
    if (!hasPanel && dbPicker === nothing) return nothing;
    return html`
      <fieldset class="block">
        <legend>${this.activeLabel} options</legend>
        <div class="panel-slot"></div>
        ${dbPicker}
      </fieldset>
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
              Import as
              <select
                data-testid="import-format"
                .value=${this.kind}
                @change=${(e: Event) => {
                  this.kind = (e.target as HTMLSelectElement).value as ImportKind;
                  this.resetDbList();
                }}
              >
                <option value="auto" ?selected=${this.kind === 'auto'}>Auto-detect</option>
                ${this.formats.map(
                  (f) =>
                    html`<option value=${f.id} ?selected=${this.kind === f.id}>${f.label}</option>`,
                )}
              </select>
            </label>

            <fieldset class="block">
              <legend>Source and options</legend>
              <label>
                Sample source
                <select
                  data-testid="import-sample"
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
                  accept=${this.acceptAttr}
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
              ${this.renderTarget()}

              <label class="check">
                <input
                  type="checkbox"
                  ?disabled=${this.mode === 'reference'}
                  .checked=${this.editColumns}
                  @change=${(e: Event) =>
                    (this.editColumns = (e.target as HTMLInputElement).checked)}
                />
                Edit columns before import (rename / hide / fix duplicate names)
              </label>
              ${this.mode === 'reference'
                ? html`<p class="hint">
                    A Reference keeps the source's own schema, so there is nothing to edit.
                  </p>`
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
            </fieldset>

            ${this.renderPluginBlock()}

            <p class="hint">
              Paste any URL or pick a sample above — a JSON dump, a <code>.csv</code> or
              <code>.tsv</code> file, or a Datasette table/database/instance. For a Datasette
              instance root, click <em>List databases</em> to pick one first. Multi-table sources
              let you choose which tables to import; Datasette tables are capped at 10,000 rows
              each.
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
