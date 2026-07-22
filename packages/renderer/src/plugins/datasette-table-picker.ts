// packages/renderer/src/plugins/datasette-table-picker.ts
//
// Modal shown before a whole-database Datasette import: lists the discovered
// tables (all selected by default) so the user can deselect any they don't
// want. Resolves to the chosen table names, or null if cancelled. Reached via
// the static `instance` accessor and mounted lazily into <body>, mirroring the
// Import dialog's pattern.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from '../dialogs/dialog-chrome.js';
import { makeDialogDraggable } from '../dialogs/draggable.js';

@customElement('datasette-table-picker')
export class DatasetteTablePicker extends LitElement {
  static instance: DatasetteTablePicker | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 380px;
        max-width: 520px;
      }
      .all {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 600;
        color: #374151;
        padding-bottom: 0.4rem;
        border-bottom: 1px solid #e5e7eb;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        max-height: 50vh;
        overflow: auto;
      }
      .list label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        color: #374151;
      }
      input[type='checkbox'] {
        width: 1rem;
        height: 1rem;
      }
    `,
  ];

  @state() private dbName = '';
  @state() private tables: string[] = [];
  @state() private selected = new Set<string>();

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: string[] | null) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    DatasetteTablePicker.instance = this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (DatasetteTablePicker.instance === this) DatasetteTablePicker.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  /** Open the picker. Resolves with the selected table names, or null on cancel. */
  open(dbName: string, tables: string[]): Promise<string[] | null> {
    this.dbName = dbName;
    this.tables = [...tables];
    this.selected = new Set(tables); // all selected by default
    return new Promise<string[] | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  private finish(value: string[] | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(value));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  private toggle(name: string, checked: boolean): void {
    const next = new Set(this.selected);
    if (checked) next.add(name);
    else next.delete(name);
    this.selected = next;
  }

  private toggleAll(checked: boolean): void {
    this.selected = checked ? new Set(this.tables) : new Set();
  }

  private submit = (e: Event): void => {
    e.preventDefault();
    if (this.selected.size === 0) return;
    // Preserve the source table order.
    this.finish(this.tables.filter((t) => this.selected.has(t)));
  };

  override render() {
    const allChecked = this.tables.length > 0 && this.selected.size === this.tables.length;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>
          ×
        </button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>Import tables from ${this.dbName}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${this.selected.size === 0}>
                Import ${this.selected.size}/${this.tables.length}
              </button>
            </div>
          </div>
          <div class="dialog-body">
            <label class="all">
              <input
                type="checkbox"
                .checked=${allChecked}
                @change=${(e: Event) => this.toggleAll((e.target as HTMLInputElement).checked)}
              />
              Select all
            </label>
            <div class="list">
              ${this.tables.map(
                (name) => html`
                  <label>
                    <input
                      type="checkbox"
                      data-table=${name}
                      .checked=${this.selected.has(name)}
                      @change=${(e: Event) =>
                        this.toggle(name, (e.target as HTMLInputElement).checked)}
                    />
                    ${name}
                  </label>
                `,
              )}
            </div>
          </div>
        </form>
      </dialog>
    `;
  }
}

/** Open the table picker for a database import. Lazily mounts the element. */
export function pickDatasetteTables(dbName: string, tables: string[]): Promise<string[] | null> {
  const el =
    DatasetteTablePicker.instance ??
    (document.body.appendChild(
      document.createElement('datasette-table-picker'),
    ) as DatasetteTablePicker);
  return el.open(dbName, tables);
}

declare global {
  interface HTMLElementTagNameMap {
    'datasette-table-picker': DatasetteTablePicker;
  }
}
