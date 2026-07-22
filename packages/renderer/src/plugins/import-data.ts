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
import { importDatasetteTable } from './datasette-source.js';
import { ctrlEnterSubmits, dialogChromeStyles } from '../dialogs/dialog-chrome.js';
import { makeDialogDraggable } from '../dialogs/draggable.js';

/** How a URL should be imported. `auto` is resolved to a concrete kind on submit. */
type ImportKind = 'auto' | 'json' | 'datasette';
type ResolvedKind = Exclude<ImportKind, 'auto'>;

interface PredefinedSource {
  label: string;
  url: string;
  kind: ResolvedKind;
}

const NORTHWIND_URL =
  'https://raw.githubusercontent.com/cawoodm/easydbaccess/main/data/northwind.db.json';

/**
 * Curated starting points. The first is our own JSON dump; the rest are public
 * Datasette instances served with CORS so they work from the static browser
 * build (no sync server required). Picking one fills the URL box and sets the
 * import kind, but the URL stays editable.
 */
const PREDEFINED: PredefinedSource[] = [
  { label: 'Northwind — sample database (JSON dump)', url: NORTHWIND_URL, kind: 'json' },
  {
    label: 'Datasette — fixtures / facetable',
    url: 'https://latest.datasette.io/fixtures/facetable',
    kind: 'datasette',
  },
  {
    label: 'Datasette — fixtures / roadside_attractions',
    url: 'https://latest.datasette.io/fixtures/roadside_attractions',
    kind: 'datasette',
  },
  {
    label: 'Datasette — global power plants',
    url: 'https://global-power-plants.datasettes.com/global-power-plants/global-power-plants',
    kind: 'datasette',
  },
];

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'import-data',
  version: '0.2.0',
  description:
    'Header button that imports a table from a URL — a JSON dump (e.g. Northwind) or a Datasette table — with a picker of sample sources.',
  author: 'easyDBAccess built-ins',
  optional: true,
};

export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'import-data:open',
    label: '',
    icon: 'cloud_download',
    tooltip: 'Import data from a URL',
    onClick: () => openImport(api),
  });
}

async function openImport(api: HostApi): Promise<void> {
  const dlg = ImportDialog.instance ?? mountDialog();
  const result = await dlg.open();
  if (!result) return; // cancelled

  const { url, kind } = result;
  try {
    if (kind === 'datasette') {
      // importDatasetteTable emits its own toasts (incl. the honest
      // "imported first N of M" when the row cap is hit).
      await importDatasetteTable(api, url);
    } else {
      const res = await api.backend.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      await importJsonText(api, text, filenameFromUrl(url));
      api.ui.dialogs.toast(`Imported ${filenameFromUrl(url)}.`, { kind: 'success', title: 'Import' });
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
    const path = u.pathname.replace(/\.(json|csv)$/i, '');
    const segments = path.split('/').filter(Boolean);
    const hasDatasetteParams = [...u.searchParams.keys()].some((k) => k.startsWith('_'));
    const looksDatasette = host.includes('datasette') || hasDatasetteParams;
    if (segments.length >= 2 && looksDatasette) return 'datasette';
    return 'json';
  } catch {
    return 'json';
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
    `,
  ];

  @state() private url = '';
  @state() private kind: ImportKind = 'auto';
  @state() private presetIdx = -1;

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ImportChoice | null) => void) | null = null;

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
  open(): Promise<ImportChoice | null> {
    this.url = '';
    this.kind = 'auto';
    this.presetIdx = -1;
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
    const kind: ResolvedKind = this.kind === 'auto' ? detectKind(url) : this.kind;
    this.finish({ url, kind });
  };

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
              <select .value=${String(this.presetIdx)} @change=${(e: Event) => this.onPresetChange(e)}>
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
                placeholder="https://… (JSON dump or Datasette table)"
                .value=${this.url}
                @input=${(e: Event) => {
                  this.url = (e.target as HTMLInputElement).value;
                  // A hand-edited URL is no longer "a preset".
                  this.presetIdx = -1;
                }}
              />
            </label>

            <label>
              Import as
              <select
                .value=${this.kind}
                @change=${(e: Event) => {
                  this.kind = (e.target as HTMLSelectElement).value as ImportKind;
                }}
              >
                <option value="auto" ?selected=${this.kind === 'auto'}>Auto-detect</option>
                <option value="json" ?selected=${this.kind === 'json'}>JSON dump</option>
                <option value="datasette" ?selected=${this.kind === 'datasette'}>
                  Datasette table
                </option>
              </select>
            </label>

            <p class="hint">
              Paste any URL or pick a sample above. JSON dumps import every table in the file;
              Datasette tables import a read-only snapshot (capped at 10,000 rows).
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
