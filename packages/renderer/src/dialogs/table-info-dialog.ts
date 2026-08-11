// packages/renderer/src/dialogs/table-info-dialog.ts
//
// Read-only "table info" dialog, opened from the (i) button a window's titlebar
// shows when its table carries descriptive metadata (Datasette description /
// source / license / about). Purely informational — no editing.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { TableInfo, TableOrigin, TableSource } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@cawoodm/lit-dialogs';
import { tableKind } from '../window-mgr/table-kind.js';

/** Where a table's rows come from — drives the "Kind" explanation. */
export interface TableProvenance {
  source?: TableSource | undefined;
  origin?: TableOrigin | undefined;
}

/** Open the info dialog for `name` with the given metadata (mounted lazily). */
export function openTableInfoDialog(name: string, info: TableInfo, provenance?: TableProvenance): void {
  const el = TableInfoDialog.instance ?? mount();
  el.show(name, info, provenance);
}

/**
 * Classify a table's provenance into a label + a "what this means" note.
 * Branches on the shared `tableKind()` classifier (window-mgr/table-kind.ts)
 * — the same one the panel titlebar icon uses — so this dialog and the
 * titlebar can never disagree on what kind a table is. `'connected'` and
 * `'referenced'` share the same "Connected (live X)" prose below (unchanged
 * from before this de-duplication): the dialog never distinguished a `'url'`
 * source from any other, only whether a `source` was present at all.
 */
function describeProvenance(p: TableProvenance | null): {
  label: string;
  note: string;
  url?: string;
} | null {
  if (!p) return null;
  const kind = tableKind(p);
  if (kind === 'connected' || kind === 'referenced') {
    // Both kinds imply `source` is set (see tableKind), but TS can't narrow
    // through the call — read it optionally rather than assert.
    const type = p.source?.type ?? 'remote';
    const writable = p.source?.writable ? 'Edits you make are written back to the source.' : 'It is read-only — edits are not saved back to the source.';
    return {
      label: `Connected (live ${type})`,
      note:
        `This table is connected to a live ${type} backend: its rows are fetched from the ` +
        `source on demand and are not stored locally. ${writable} Closing its window just ` +
        `disconnects the view — the source data is untouched.`,
    };
  }
  if (kind === 'imported') {
    return {
      label: 'Imported (snapshot)',
      note: `This table is a local snapshot imported once from its origin. The rows live in this ` + `browser, so edits stay local; use Refresh to re-fetch the latest data from the origin.`,
      // Conditional spread, not `p.origin?.url`: `exactOptionalPropertyTypes`
      // rejects assigning `string | undefined` to an optional `url?: string`.
      ...(p.origin ? { url: p.origin.url } : {}),
    };
  }
  return {
    label: 'Local',
    note: 'This table was created in the app and is stored locally in your browser.',
  };
}

function mount(): TableInfoDialog {
  const el = document.createElement('table-info-dialog') as TableInfoDialog;
  document.body.appendChild(el);
  return el;
}

@customElement('table-info-dialog')
export class TableInfoDialog extends LitElement {
  static instance: TableInfoDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 360px;
        max-width: 560px;
      }
      .desc {
        font-size: 0.9rem;
        color: #374151;
        line-height: 1.5;
      }
      dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.35rem 0.75rem;
        margin: 0.75rem 0 0;
        font-size: 0.85rem;
      }
      dt {
        color: #6b7280;
        font-weight: 600;
      }
      dd {
        margin: 0;
      }
      a {
        color: #2563eb;
      }
      .empty {
        color: #6b7280;
        font-size: 0.85rem;
      }
      .kind {
        margin: 0 0 0.5rem;
        padding: 0.5rem 0.6rem;
        background: #f3f4f6;
        border-radius: 0.35rem;
        font-size: 0.85rem;
      }
      .kind .kind-label {
        font-weight: 600;
        color: #374151;
      }
      .kind .kind-note {
        margin: 0.2rem 0 0;
        color: #4b5563;
        line-height: 1.45;
      }
      .kind .kind-origin {
        margin: 0.25rem 0 0;
        word-break: break-all;
      }
    `,
  ];

  @state() private name = '';
  @state() private info: TableInfo | null = null;
  @state() private provenance: TableProvenance | null = null;
  private dialogEl: HTMLDialogElement | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    TableInfoDialog.instance = this;
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (TableInfoDialog.instance === this) TableInfoDialog.instance = null;
  }
  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  show(name: string, info: TableInfo, provenance?: TableProvenance): void {
    this.name = name;
    this.info = info;
    this.provenance = provenance ?? null;
    void this.updateComplete.then(() => this.dialogEl?.showModal());
  }

  private close = (): void => this.dialogEl?.close();

  private onSubmit = (e: Event): void => {
    e.preventDefault();
    this.close();
  };

  /** One <dt>/<dd> attribution row: a link when a URL is present, else text. */
  private row(label: string, text?: string, url?: string) {
    if (!text && !url) return nothing;
    const body = url ? html`<a href=${url} target="_blank" rel="noopener noreferrer">${text || url}</a>` : html`${text}`;
    return html`<dt>${label}</dt>
      <dd>${body}</dd>`;
  }

  override render() {
    const i = this.info;
    const hasAttribution = !!(i?.source || i?.sourceUrl || i?.license || i?.licenseUrl || i?.about || i?.aboutUrl);
    const kind = describeProvenance(this.provenance);
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>${this.name}</h2>
            <div class="header-actions">
              <button type="submit" class="ghost">Close</button>
            </div>
          </div>
          <div class="dialog-body">
            ${kind
              ? html`<div class="kind">
                  <span class="kind-label">${kind.label}</span>
                  <p class="kind-note">${kind.note}</p>
                  ${kind.url
                    ? html`<div class="kind-origin">
                        <a href=${kind.url} target="_blank" rel="noopener noreferrer">${kind.url}</a>
                      </div>`
                    : nothing}
                </div>`
              : nothing}
            ${i?.descriptionHtml ? html`<div class="desc">${unsafeHTML(i.descriptionHtml)}</div>` : i?.description ? html`<div class="desc">${i.description}</div>` : nothing}
            ${hasAttribution ? html`<dl>${this.row('Source', i?.source, i?.sourceUrl)} ${this.row('License', i?.license, i?.licenseUrl)} ${this.row('About', i?.about, i?.aboutUrl)}</dl>` : nothing}
            ${!i?.description && !i?.descriptionHtml && !hasAttribution && !kind ? html`<p class="empty">No additional information.</p>` : nothing}
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'table-info-dialog': TableInfoDialog;
  }
}
