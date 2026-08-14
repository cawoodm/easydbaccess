// packages/renderer/src/dialogs/column-names-dialog.ts
//
// Pre-import column editor. Opened by the Import dialog's "Edit columns"
// checkbox, it lets the user review/rename the columns a parser inferred
// (currently the CSV importer) BEFORE the table is created. Duplicate or empty
// field names are highlighted in red and block the Import until fixed — this is
// the guard for CSVs whose headers collide (e.g. "TM" and "Tm" both → "tm").

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';
import { watchDialogDirty } from '../chrome/dirty-guard.js';

interface EditRow {
  field: string;
  label: string;
  hidden: boolean;
}

/**
 * Open the editor for `columns`; resolves with the edited columns or null.
 * `subject` names what is being edited — a multi-table source (a JSON dump, a
 * Datasette database) opens the editor once per table, so without the name the
 * user cannot tell which one they are looking at.
 */
export function editColumnNames(columns: ColumnSpec[], subject?: string): Promise<ColumnSpec[] | null> {
  const el = ColumnNamesDialog.instance ?? mount();
  return el.open(columns, subject);
}

function mount(): ColumnNamesDialog {
  const el = document.createElement('column-names-dialog') as ColumnNamesDialog;
  document.body.appendChild(el);
  return el;
}

@customElement('column-names-dialog')
export class ColumnNamesDialog extends LitElement {
  static instance: ColumnNamesDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        min-width: 460px;
        max-width: 640px;
      }
      p.intro {
        margin: 0;
        font-size: 0.85rem;
        color: #6b7280;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
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
      /* A header for a per-row toggle column: clicking it flips all rows on/off. */
      .head.toggle {
        cursor: pointer;
        user-select: none;
        text-align: center;
      }
      .head.toggle:hover {
        color: #2563eb;
        text-decoration: underline;
      }
      .hidecell {
        display: flex;
        justify-content: center;
      }
      input {
        font: inherit;
        padding: 0.35rem 0.45rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        width: 100%;
        box-sizing: border-box;
        background: white;
      }
      input[type='checkbox'] {
        width: auto;
        padding: 0;
        cursor: pointer;
      }
      input.invalid {
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

  @state() private rows: EditRow[] = [];
  @state() private subject = '';
  private source: ColumnSpec[] = [];
  private dialogEl: HTMLDialogElement | null = null;
  private resolveFn: ((v: ColumnSpec[] | null) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    ColumnNamesDialog.instance = this;
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (ColumnNamesDialog.instance === this) ColumnNamesDialog.instance = null;
  }

  override firstUpdated(): void {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
    if (this.dialogEl) watchDialogDirty('column-names', this.dialogEl);
  }

  open(columns: ColumnSpec[], subject?: string): Promise<ColumnSpec[] | null> {
    this.source = columns;
    this.subject = subject ?? '';
    this.rows = columns.map((c) => ({ field: c.field, label: c.label, hidden: !!c.hidden }));
    return new Promise<ColumnSpec[] | null>((resolve) => {
      this.resolveFn = resolve;
      void this.updateComplete.then(() => this.dialogEl?.showModal());
    });
  }

  /** Indices whose field is empty or a case-insensitive duplicate of another. */
  private invalidIndices(): Set<number> {
    const bad = new Set<number>();
    const byKey = new Map<string, number[]>();
    this.rows.forEach((r, i) => {
      const key = r.field.trim().toLowerCase();
      if (key === '') {
        bad.add(i);
        return;
      }
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(i);
    });
    for (const idxs of byKey.values()) {
      if (idxs.length > 1) for (const i of idxs) bad.add(i);
    }
    return bad;
  }

  private finish(value: ColumnSpec[] | null): void {
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
    if (this.invalidIndices().size > 0) return; // blocked while invalid
    const edited: ColumnSpec[] = this.source.map((orig, i) => {
      const row = this.rows[i]!;
      const field = row.field.trim();
      const label = row.label.trim() || field;
      return { ...orig, field, label, hidden: row.hidden };
    });
    this.finish(edited);
  };

  private updateRow(i: number, key: 'field' | 'label', value: string): void {
    this.rows = this.rows.map((r, j) => (j === i ? { ...r, [key]: value } : r));
  }

  private setHidden(i: number, hidden: boolean): void {
    this.rows = this.rows.map((r, j) => (j === i ? { ...r, hidden } : r));
  }

  /**
   * Clicking the "Hide" header toggles all rows at once: if every column is
   * already hidden, reveal them all; otherwise hide them all. (All/none.)
   */
  private toggleAllHidden = (): void => {
    const allHidden = this.rows.length > 0 && this.rows.every((r) => r.hidden);
    this.rows = this.rows.map((r) => ({ ...r, hidden: !allHidden }));
  };

  override render() {
    const invalid = this.invalidIndices();
    const errCount = invalid.size;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${() => this.finish(null)}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>${this.subject ? `Edit columns — ${this.subject}` : 'Edit columns'}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${() => this.finish(null)}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${errCount > 0}>Import</button>
            </div>
          </div>
          <div class="dialog-body">
            <p class="intro">
              Rename columns before importing. A <strong>name</strong> is the field key; duplicate or empty names are shown in red and must be fixed first. Tick <strong>Hide</strong> to import a
              column hidden — click the <strong>Hide</strong> header to toggle all/none.
            </p>
            <div class="grid">
              <div class="head">Name</div>
              <div class="head">Label</div>
              <div
                class="head toggle"
                role="button"
                tabindex="0"
                title="Toggle hide for all columns"
                @click=${this.toggleAllHidden}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.toggleAllHidden();
                  }
                }}
              >
                Hide
              </div>
              ${this.rows.map(
                (r, i) => html`
                  <input
                    class=${invalid.has(i) ? 'invalid' : ''}
                    .value=${r.field}
                    aria-label=${`Column ${i + 1} name`}
                    @input=${(e: Event) => this.updateRow(i, 'field', (e.target as HTMLInputElement).value)}
                  />
                  <input .value=${r.label} aria-label=${`Column ${i + 1} label`} @input=${(e: Event) => this.updateRow(i, 'label', (e.target as HTMLInputElement).value)} />
                  <div class="hidecell">
                    <input type="checkbox" .checked=${r.hidden} aria-label=${`Hide column ${i + 1}`} @change=${(e: Event) => this.setHidden(i, (e.target as HTMLInputElement).checked)} />
                  </div>
                `,
              )}
            </div>
            <p class="err">${errCount > 0 ? `Fix ${errCount} column name${errCount === 1 ? '' : 's'} — names must be unique and non-empty.` : nothing}</p>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'column-names-dialog': ColumnNamesDialog;
  }
}
