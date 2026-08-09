// packages/renderer/src/dialogs/column-map-dialog.ts
//
// Column mapper for an APPEND. Opened when a delimited file is dropped on an
// existing table and the user chooses to append: it shows the file's header
// beside a picker of the table's columns, so a file whose columns are in another
// order (or which carries columns the table does not want) still lands in the
// right fields. Without it the append maps by position, which is silently wrong
// for any file the table was not built from.
//
// The mapping arithmetic lives in `import/map-columns.ts`; this is its dialog.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles } from './dialog-chrome.js';
import { makeDialogDraggable } from './draggable.js';
import { watchDialogDirty } from '../chrome/dirty-guard.js';
import { guessMapping, type ColumnMapping } from '../import/map-columns.js';

/** The value of the "leave this column out" option. Empty ⇒ unmapped. */
const SKIP = '';

/**
 * Open the mapper for `header` against `targetCols`. Resolves with one target
 * field per incoming column (`''` = drop it), or null if the user cancelled.
 * `tableName` names the table being appended to — the whole point of the dialog
 * is which table the values are going into.
 */
export function mapColumnsToTable(header: string[], targetCols: ColumnSpec[], tableName: string, sample?: string[] | undefined): Promise<ColumnMapping | null> {
  const el = ColumnMapDialog.instance ?? mount();
  return el.open(header, targetCols, tableName, sample);
}

function mount(): ColumnMapDialog {
  const el = document.createElement('column-map-dialog') as ColumnMapDialog;
  document.body.appendChild(el);
  return el;
}

@customElement('column-map-dialog')
export class ColumnMapDialog extends LitElement {
  static instance: ColumnMapDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 520px;
        max-width: 720px;
      }
      p.intro {
        margin: 0;
        font-size: 0.85rem;
        color: #6b7280;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 0.4rem 0.75rem;
        margin-top: 0.6rem;
        max-height: 50vh;
        overflow: auto;
        align-items: center;
      }
      .head {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #6b7280;
        position: sticky;
        top: 0;
        background: white;
        padding-bottom: 0.15rem;
      }
      .from {
        min-width: 0;
      }
      .from .name {
        font-weight: 600;
        font-size: 0.9rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* First data row of the file, so the user can tell two same-ish headers
         apart by what is actually in them. */
      .from .sample {
        color: #9ca3af;
        font-size: 0.78rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .arrow {
        color: #9ca3af;
      }
      select {
        font: inherit;
        padding: 0.35rem 0.45rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
        background: white;
      }
      /* A dropped column is not an error, but it should look different from one
         that lands somewhere. */
      select.skipped {
        color: #9ca3af;
        font-style: italic;
      }
      /* Two columns pointing at one target — blocks Append until fixed. */
      select.invalid {
        border-color: #dc2626;
        background: #fef2f2;
        outline-color: #dc2626;
      }
      .err {
        color: #b91c1c;
        font-size: 0.78rem;
        margin: 0.5rem 0 0;
        min-height: 1.1em;
      }
    `,
  ];

  @state() private mapping: ColumnMapping = [];
  @state() private header: string[] = [];
  @state() private sample: string[] = [];
  @state() private tableName = '';
  private targetCols: ColumnSpec[] = [];
  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ColumnMapping | null) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    ColumnMapDialog.instance = this;
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (ColumnMapDialog.instance === this) ColumnMapDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    if (this.dialogEl) watchDialogDirty('column-map', this.dialogEl);
  }

  open(header: string[], targetCols: ColumnSpec[], tableName: string, sample?: string[] | undefined): Promise<ColumnMapping | null> {
    this.header = header;
    this.targetCols = targetCols;
    this.tableName = tableName;
    this.sample = sample ?? [];
    this.mapping = guessMapping(header, targetCols);
    return new Promise<ColumnMapping | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  /** Target fields chosen more than once — one cell cannot take two columns. */
  private duplicates(): Set<string> {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const field of this.mapping) {
      if (field === SKIP) continue;
      if (seen.has(field)) dup.add(field);
      seen.add(field);
    }
    return dup;
  }

  private finish(value: ColumnMapping | null): void {
    this.dialogEl?.close();
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(value));
  }

  private onCancel = (e: Event): void => {
    e.preventDefault();
    this.finish(null);
  };

  private submit = (e: Event): void => {
    e.preventDefault();
    if (this.duplicates().size > 0) return;
    this.finish([...this.mapping]);
  };

  private setTarget(i: number, field: string): void {
    this.mapping = this.mapping.map((f, j) => (j === i ? field : f));
  }

  override render() {
    const dup = this.duplicates();
    const mapped = this.mapping.filter((f) => f !== SKIP).length;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>Map columns — ${this.tableName}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${dup.size > 0}>Append</button>
            </div>
          </div>
          <div class="dialog-body">
            <p class="intro">
              Choose which column of <strong>${this.tableName}</strong> each column of the file feeds. Columns are matched by name where possible, else by position. Pick <strong>— skip —</strong> to
              leave a column out.
            </p>
            <div class="grid">
              <div class="head">From the file</div>
              <div class="head"></div>
              <div class="head">Into ${this.tableName}</div>
              ${this.header.map((h, i) => {
                const value = this.mapping[i] ?? SKIP;
                const isDup = value !== SKIP && dup.has(value);
                return html`
                  <div class="from">
                    <div class="name" title=${h}>${h || `Column ${i + 1}`}</div>
                    ${this.sample[i] ? html`<div class="sample" title=${this.sample[i]!}>${this.sample[i]}</div>` : nothing}
                  </div>
                  <div class="arrow">→</div>
                  <select
                    class=${value === SKIP ? 'skipped' : isDup ? 'invalid' : ''}
                    aria-label=${`Target column for ${h || `column ${i + 1}`}`}
                    .value=${value}
                    @change=${(e: Event) => this.setTarget(i, (e.target as HTMLSelectElement).value)}
                  >
                    <option value=${SKIP} ?selected=${value === SKIP}>— skip —</option>
                    ${this.targetCols.map((c) => html` <option value=${c.field} ?selected=${c.field === value}>${c.label || c.field}</option> `)}
                  </select>
                `;
              })}
            </div>
            <p class="err">${dup.size > 0 ? `Two columns point at the same target: ${[...dup].join(', ')}.` : mapped === 0 ? 'Every column is skipped — the append would add empty rows.' : nothing}</p>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'column-map-dialog': ColumnMapDialog;
  }
}
