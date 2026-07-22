// packages/renderer/src/plugins/datasette-table-picker.ts
//
// Modal shown before a whole-database Datasette import. Lists the discovered
// tables with their row count and an estimated size, flags any that collide
// with an existing local table (offering Overwrite vs Rename), and lets the
// user deselect any they don't want. Resolves to the chosen tables (each with
// an `overwrite` flag), or null if cancelled. Reached via the static
// `instance` accessor and mounted lazily into <body>.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles } from '../dialogs/dialog-chrome.js';
import { makeDialogDraggable } from '../dialogs/draggable.js';

export interface PickerTable {
  name: string;
  rows: number | null;
  bytes: number | null; // null = unknown / still estimating
  exists: boolean; // a local table with the target name already exists
}

export interface PickerChoice {
  table: string;
  /** true → overwrite the existing local table; false → import as a new table. */
  overwrite: boolean;
}

function fmtRows(n: number | null): string {
  return n == null ? '? rows' : `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;
}

function fmtBytes(b: number | null): string {
  if (b == null) return '…';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

@customElement('datasette-table-picker')
export class DatasetteTablePicker extends LitElement {
  static instance: DatasetteTablePicker | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 460px;
        max-width: 600px;
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
        gap: 0.1rem;
        max-height: 52vh;
        overflow: auto;
      }
      .row {
        display: grid;
        grid-template-columns: 1rem 1fr auto auto;
        align-items: center;
        gap: 0.6rem;
        padding: 0.25rem 0.1rem;
        font-size: 0.9rem;
        color: #374151;
      }
      .row .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .row .size {
        color: #6b7280;
        font-size: 0.8rem;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .row .collision {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      .badge {
        background: #fef3c7;
        color: #92400e;
        border-radius: 0.2rem;
        padding: 0.05rem 0.3rem;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      select {
        font: inherit;
        font-size: 0.8rem;
        padding: 0.1rem 0.25rem;
        border: 1px solid #d1d5db;
        border-radius: 0.2rem;
      }
      input[type='checkbox'] {
        width: 1rem;
        height: 1rem;
      }
      .footer {
        color: #6b7280;
        font-size: 0.8rem;
        border-top: 1px solid #e5e7eb;
        padding-top: 0.5rem;
      }
    `,
  ];

  @state() private dbName = '';
  @state() private items: PickerTable[] = [];
  @state() private selected = new Set<string>();
  /** Names the user switched from the default Overwrite to Rename. */
  @state() private renameMode = new Set<string>();

  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: PickerChoice[] | null) => void) | null = null;

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

  /**
   * Open the picker. `estimate` (optional) is called per table to fill in the
   * size lazily so the dialog opens instantly. Resolves with the chosen tables,
   * or null on cancel.
   */
  open(
    dbName: string,
    tables: PickerTable[],
    estimate?: (name: string) => Promise<number | null>,
  ): Promise<PickerChoice[] | null> {
    this.dbName = dbName;
    this.items = tables.map((t) => ({ ...t }));
    this.selected = new Set(tables.map((t) => t.name)); // all selected by default
    this.renameMode = new Set(); // existing tables default to Overwrite
    return new Promise<PickerChoice[] | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => {
        this.dialogEl?.showModal();
        if (estimate) this.runEstimates(estimate);
      });
    });
  }

  private runEstimates(estimate: (name: string) => Promise<number | null>): void {
    this.items.forEach((item, i) => {
      if (item.bytes != null) return;
      void estimate(item.name)
        .then((bytes) => {
          this.items = this.items.map((it, idx) => (idx === i ? { ...it, bytes } : it));
        })
        .catch(() => {
          /* leave as unknown */
        });
    });
  }

  private finish(value: PickerChoice[] | null): void {
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
    this.selected = checked ? new Set(this.items.map((t) => t.name)) : new Set();
  }

  private setMode(name: string, mode: string): void {
    const next = new Set(this.renameMode);
    if (mode === 'rename') next.add(name);
    else next.delete(name);
    this.renameMode = next;
  }

  private submit = (e: Event): void => {
    e.preventDefault();
    if (this.selected.size === 0) return;
    const chosen: PickerChoice[] = this.items
      .filter((it) => this.selected.has(it.name))
      .map((it) => ({ table: it.name, overwrite: it.exists && !this.renameMode.has(it.name) }));
    this.finish(chosen);
  };

  override render() {
    const allChecked = this.items.length > 0 && this.selected.size === this.items.length;
    const sel = this.items.filter((it) => this.selected.has(it.name));
    const totalRows = sel.reduce((s, it) => s + (it.rows ?? 0), 0);
    const totalBytes = sel.some((it) => it.bytes == null)
      ? null
      : sel.reduce((s, it) => s + (it.bytes ?? 0), 0);
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
                Import ${this.selected.size}/${this.items.length}
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
              ${this.items.map(
                (it) => html`
                  <label class="row">
                    <input
                      type="checkbox"
                      data-table=${it.name}
                      .checked=${this.selected.has(it.name)}
                      @change=${(e: Event) =>
                        this.toggle(it.name, (e.target as HTMLInputElement).checked)}
                    />
                    <span class="name" title=${it.name}>${it.name}</span>
                    <span class="size">${fmtRows(it.rows)} · ${fmtBytes(it.bytes)}</span>
                    ${it.exists
                      ? html`<span class="collision">
                          <span class="badge" title="A local table with this name already exists"
                            >exists</span
                          >
                          <select
                            data-mode=${it.name}
                            @change=${(e: Event) =>
                              this.setMode(it.name, (e.target as HTMLSelectElement).value)}
                          >
                            <option value="overwrite" ?selected=${!this.renameMode.has(it.name)}>
                              Overwrite
                            </option>
                            <option value="rename" ?selected=${this.renameMode.has(it.name)}>
                              Rename
                            </option>
                          </select>
                        </span>`
                      : nothing}
                  </label>
                `,
              )}
            </div>
            <div class="footer">
              ${this.selected.size} selected · ${totalRows.toLocaleString()} rows ·
              ${totalBytes == null ? '~' : ''}${fmtBytes(totalBytes)}
            </div>
          </div>
        </form>
      </dialog>
    `;
  }
}

/** Open the table picker for a database import. Lazily mounts the element. */
export function pickDatasetteTables(
  dbName: string,
  tables: PickerTable[],
  estimate?: (name: string) => Promise<number | null>,
): Promise<PickerChoice[] | null> {
  const el =
    DatasetteTablePicker.instance ??
    (document.body.appendChild(
      document.createElement('datasette-table-picker'),
    ) as DatasetteTablePicker);
  return el.open(dbName, tables, estimate);
}

declare global {
  interface HTMLElementTagNameMap {
    'datasette-table-picker': DatasetteTablePicker;
  }
}
