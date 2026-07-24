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

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { HostApi, PluginModule } from '@easydb/shared';
import { importJsonText } from './json-import.js';
import { importCsvText } from './csv-import.js';
import { editColumnNames } from '../dialogs/column-names-dialog.js';
import { importDatasette } from './datasette-source.js';
import { parseDatasetteUrl, fetchDatabaseNames } from './datasette-client.js';
import { ctrlEnterSubmits, dialogChromeStyles } from '../dialogs/dialog-chrome.js';
import { makeDialogDraggable } from '../dialogs/draggable.js';

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
  name: 'import-data',
  version: '0.2.0',
  description:
    'Header button that imports data from a URL — a JSON dump (e.g. Northwind) or a Datasette table, database, or whole instance — with a picker of sample sources.',
  author: 'easyDBAccess built-ins',
  optional: true,
};

export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'import-data:open',
    label: 'Import',
    icon: IMPORT_ICON_SVG,
    tooltip: 'Import data from a URL (snapshot into a local table)',
    onClick: () => openImport(api),
  });
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

  const { url, kind, dbChosen, editColumns } = result;
  try {
    if (kind === 'datasette') {
      // importDatasette emits its own toasts. A table URL imports directly; a
      // database/instance URL opens the table picker before importing — unless
      // the user already picked a database here, in which case we import that
      // database's tables directly (skipTablePicker).
      await importDatasette(api, url, { skipTablePicker: dbChosen });
    } else if (kind === 'csv') {
      const res = await api.backend.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      // When "Edit columns" was checked, review/rename columns before creating
      // the table (importCsvText returns without inserting if the user cancels).
      await importCsvText(api, text, filenameFromUrl(url), {
        editColumns: editColumns ? editColumnNames : undefined,
      });
      api.ui.dialogs.toast(`Imported ${filenameFromUrl(url)}.`, {
        kind: 'success',
        title: 'Import',
      });
    } else {
      const res = await api.backend.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      await importJsonText(api, text, filenameFromUrl(url));
      api.ui.dialogs.toast(`Imported ${filenameFromUrl(url)}.`, {
        kind: 'success',
        title: 'Import',
      });
    }
  } catch (err) {
    api.ui.dialogs.toast(`Could not import ${url}: ${(err as Error).message}`, {
      kind: 'error',
      title: 'Import',
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
    if (!hasDatasetteParams && /\.csv$/i.test(u.pathname)) return 'csv';
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
  url: string;
  kind: ResolvedKind;
  /**
   * True when the user picked a specific database from the dialog's dropdown
   * (an instance-root URL narrowed to `.../db`). The datasette importer then
   * skips the table checklist and imports that database's tables directly.
   */
  dbChosen?: boolean;
  /** True when "Edit columns" was checked — open the column editor pre-import (CSV). */
  editColumns?: boolean;
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
      select {
        font: inherit;
        padding: 0.45rem 0.55rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
        background: white;
      }
      .row {
        display: flex;
        gap: 0.75rem;
      }
      .row > * {
        flex: 1;
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

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ImportChoice | null) => void) | null = null;
  private listDatabases: ((url: string) => Promise<string[]>) | null = null;

  /** The concrete kind, resolving `auto` from the current URL. */
  private get resolvedKind(): ResolvedKind {
    return this.kind === 'auto' ? detectKind(this.url.trim()) : this.kind;
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
    if (!url) return;
    const kind = this.resolvedKind;
    // If a database was picked for an instance-root URL, narrow the URL to that
    // database and flag it so the importer imports that db's tables directly
    // (no second table-select dialog — the user already committed to the db).
    const dbChosen =
      kind === 'datasette' && !!this.selectedDb && isDatasetteInstanceRoot(url, kind);
    const finalUrl = dbChosen
      ? `${url.replace(/\/+$/, '')}/${encodeURIComponent(this.selectedDb)}`
      : url;
    // "Edit columns" only applies to CSV (single-table, columns known up front).
    const editColumns = kind === 'csv' && this.editColumns;
    this.finish({ url: finalUrl, kind, dbChosen, editColumns });
  };

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
                placeholder="https://… (JSON dump, .csv file, or Datasette table)"
                .value=${this.url}
                @input=${(e: Event) => {
                  this.url = (e.target as HTMLInputElement).value;
                  // A hand-edited URL is no longer "a preset"; drop any stale
                  // database list (it belonged to the previous instance).
                  this.presetIdx = -1;
                  this.resetDbList();
                }}
              />
            </label>

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
                <option value="csv" ?selected=${this.kind === 'csv'}>CSV file</option>
                <option value="datasette" ?selected=${this.kind === 'datasette'}>
                  Datasette (table or instance)
                </option>
              </select>
            </label>

            ${this.renderDbPicker()}

            ${this.resolvedKind === 'csv'
              ? html`<label class="check">
                  <input
                    type="checkbox"
                    .checked=${this.editColumns}
                    @change=${(e: Event) =>
                      (this.editColumns = (e.target as HTMLInputElement).checked)}
                  />
                  Edit columns before import (rename / fix duplicate names)
                </label>`
              : nothing}

            <p class="hint">
              Paste any URL or pick a sample above — a JSON dump, a <code>.csv</code> file, or a
              Datasette table/database/instance. For a Datasette instance root, click
              <em>List databases</em> to pick one first. Multi-table sources let you choose which
              tables to import; Datasette tables import a read-only snapshot (capped at 10,000 rows
              each).
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
