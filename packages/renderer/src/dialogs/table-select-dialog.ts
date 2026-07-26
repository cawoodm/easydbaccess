// packages/renderer/src/dialogs/table-select-dialog.ts
//
// A reusable "pick which tables to import" dialog. Used whenever an import
// yields more than one table — a multi-table JSON dump, or an entire Datasette
// database/instance. Every row starts selected; the user unchecks what they
// don't want. Resolves with the selected indices (into the input array) so
// callers can map back to their own richer records, or null on cancel.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';

export interface SelectableTable {
  /** Display name of the table. */
  name: string;
  /** Row count, or null when the source can't/ won't report one. */
  size: number | null;
  /** Optional secondary text (e.g. the database a table belongs to). */
  detail?: string | undefined;
  /**
   * Whether the source marks this table hidden (Datasette `hidden` metadata /
   * FTS/SpatiaLite tables). Shown with a "hidden" tag and unchecked by default,
   * but still selectable.
   */
  hidden?: boolean | undefined;
}

export interface ChooseTablesOpts {
  title?: string;
  message?: string;
  /** Verb for the confirm button; the count is appended, e.g. "Import (3)". */
  confirmLabel?: string;
}

/**
 * Open the table picker. Resolves with the indices (into `items`) the user
 * chose, or null if they cancelled. Never resolves with an empty array — the
 * confirm button is disabled while nothing is selected.
 */
export function chooseTables(
  items: SelectableTable[],
  opts: ChooseTablesOpts = {},
): Promise<number[] | null> {
  const dlg = TableSelectDialog.instance ?? mountDialog();
  return dlg.open(items, opts);
}

function mountDialog(): TableSelectDialog {
  const el = document.createElement('table-select-dialog') as TableSelectDialog;
  document.body.appendChild(el);
  return el;
}

function formatSize(size: number | null): string {
  if (size == null) return ''; // unknown / not a row count (e.g. a database entry)
  return `${size.toLocaleString()} row${size === 1 ? '' : 's'}`;
}

@customElement('table-select-dialog')
export class TableSelectDialog extends LitElement {
  static instance: TableSelectDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 420px;
        max-width: 560px;
      }
      .message {
        margin: 0;
        color: #374151;
        font-size: 0.9rem;
      }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        font-size: 0.82rem;
        color: #6b7280;
      }
      .toolbar button {
        font: inherit;
        background: transparent;
        border: 0;
        color: #2563eb;
        cursor: pointer;
        padding: 0;
      }
      .toolbar button:hover {
        text-decoration: underline;
      }
      ul.tables {
        list-style: none;
        margin: 0;
        padding: 0;
        border: 1px solid #e5e7eb;
        border-radius: 0.35rem;
        max-height: 46vh;
        overflow: auto;
      }
      li {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.45rem 0.7rem;
        border-bottom: 1px solid #f1f5f9;
      }
      li:last-child {
        border-bottom: 0;
      }
      li label {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        flex: 1;
        cursor: pointer;
        min-width: 0;
      }
      .name {
        font-weight: 500;
        color: #111827;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .size {
        color: #6b7280;
        font-size: 0.8rem;
        white-space: nowrap;
      }
      .detail {
        color: #9ca3af;
        font-size: 0.78rem;
      }
      .tag-hidden {
        flex: 0 0 auto;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #92400e;
        background: #fef3c7;
        border-radius: 0.25rem;
        padding: 0.05rem 0.35rem;
      }
      input[type='checkbox'] {
        width: 1rem;
        height: 1rem;
      }
      button.primary:disabled {
        background: #93c5fd;
        cursor: default;
      }
    `,
  ];

  @state() private items: SelectableTable[] = [];
  @state() private selected: boolean[] = [];
  @state() private heading = 'Select tables';
  @state() private message = '';
  @state() private confirmLabel = 'Import';

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: number[] | null) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    TableSelectDialog.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (TableSelectDialog.instance === this) TableSelectDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  open(items: SelectableTable[], opts: ChooseTablesOpts): Promise<number[] | null> {
    this.items = items;
    // Hidden tables start unchecked (the user opts in); everything else is on.
    this.selected = items.map((t) => !t.hidden);
    this.heading = opts.title ?? 'Select tables';
    this.message = opts.message ?? '';
    this.confirmLabel = opts.confirmLabel ?? 'Import';
    return new Promise<number[] | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  private finish(value: number[] | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(value));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  private toggle(i: number): void {
    const next = this.selected.slice();
    next[i] = !next[i];
    this.selected = next;
  }

  private setAll(value: boolean): void {
    this.selected = this.items.map(() => value);
  }

  private get selectedCount(): number {
    return this.selected.filter(Boolean).length;
  }

  private submit = (e: Event): void => {
    e.preventDefault();
    const indices = this.selected.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    if (indices.length === 0) return;
    this.finish(indices);
  };

  override render() {
    const count = this.selectedCount;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>
          ×
        </button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>${this.heading}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${count === 0}>
                ${this.confirmLabel} (${count})
              </button>
            </div>
          </div>
          <div class="dialog-body">
            ${this.message ? html`<p class="message">${this.message}</p>` : ''}
            <div class="toolbar">
              <span>${count} of ${this.items.length} selected</span>
              <span>
                <button type="button" @click=${() => this.setAll(true)}>Select all</button>
                &nbsp;·&nbsp;
                <button type="button" @click=${() => this.setAll(false)}>None</button>
              </span>
            </div>
            <ul class="tables">
              ${this.items.map(
                (t, i) => html`
                  <li>
                    <input
                      type="checkbox"
                      id=${`tsel-${i}`}
                      .checked=${this.selected[i] ?? false}
                      @change=${() => this.toggle(i)}
                    />
                    <label for=${`tsel-${i}`}>
                      <span class="name">${t.name}</span>
                      ${t.hidden ? html`<span class="tag-hidden">hidden</span>` : ''}
                      <span class="size">${formatSize(t.size)}</span>
                      ${t.detail ? html`<span class="detail">${t.detail}</span>` : ''}
                    </label>
                  </li>
                `,
              )}
            </ul>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'table-select-dialog': TableSelectDialog;
  }
}
