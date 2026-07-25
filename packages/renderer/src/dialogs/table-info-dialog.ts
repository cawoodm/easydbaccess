// packages/renderer/src/dialogs/table-info-dialog.ts
//
// Read-only "table info" dialog, opened from the (i) button a window's titlebar
// shows when its table carries descriptive metadata (Datasette description /
// source / license / about). Purely informational — no editing.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { TableInfo } from '@easydb/shared';
import { dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

/** Open the info dialog for `name` with the given metadata (mounted lazily). */
export function openTableInfoDialog(name: string, info: TableInfo): void {
  const el = TableInfoDialog.instance ?? mount();
  el.show(name, info);
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
    `,
  ];

  @state() private name = '';
  @state() private info: TableInfo | null = null;
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

  show(name: string, info: TableInfo): void {
    this.name = name;
    this.info = info;
    void this.updateComplete.then(() => this.dialogEl?.showModal());
  }

  private close = (): void => this.dialogEl?.close();

  /** One <dt>/<dd> attribution row: a link when a URL is present, else text. */
  private row(label: string, text?: string, url?: string) {
    if (!text && !url) return nothing;
    const body = url
      ? html`<a href=${url} target="_blank" rel="noopener noreferrer">${text || url}</a>`
      : html`${text}`;
    return html`<dt>${label}</dt>
      <dd>${body}</dd>`;
  }

  override render() {
    const i = this.info;
    const hasAttribution = !!(
      i?.source ||
      i?.sourceUrl ||
      i?.license ||
      i?.licenseUrl ||
      i?.about ||
      i?.aboutUrl
    );
    return html`
      <dialog @cancel=${this.close}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <div class="dialog-header">
          <h2>${this.name}</h2>
          <div class="header-actions">
            <button type="button" class="ghost" @click=${this.close}>Close</button>
          </div>
        </div>
        <div class="dialog-body">
          ${i?.descriptionHtml
            ? html`<div class="desc">${unsafeHTML(i.descriptionHtml)}</div>`
            : i?.description
              ? html`<div class="desc">${i.description}</div>`
              : nothing}
          ${hasAttribution
            ? html`<dl>
                ${this.row('Source', i?.source, i?.sourceUrl)}
                ${this.row('License', i?.license, i?.licenseUrl)}
                ${this.row('About', i?.about, i?.aboutUrl)}
              </dl>`
            : nothing}
          ${!i?.description && !i?.descriptionHtml && !hasAttribution
            ? html`<p class="empty">No additional information.</p>`
            : nothing}
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'table-info-dialog': TableInfoDialog;
  }
}
