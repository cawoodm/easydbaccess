// packages/renderer/src/dialogs/run-picker-dialog.ts
//
// The one question the footer's **Run** button asks, for both halves of it:
// WHICH columns, and over WHICH rows.
//
// It replaces two `choice()` dialogs in a row. The first offered three canned
// sets — enabled / all / disabled — which is the wrong shape: a table with six
// scripted columns and one slow script had no way to say "that one, not the
// others", and the answer to "which rows" arrived a dialog later, by which time
// the user had forgotten what the first one selected. One dialog, both answers,
// each tickable by hand.
//
// Deliberately generic: `validate` lists rule-carrying columns, `run-scripts`
// lists scripted ones, and neither needs a dialog of its own.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';

/** One tickable column. */
export interface RunPickerItem {
  field: string;
  /** What the column calls itself. */
  label: string;
  /** Right-hand note — "enabled", "required, unique". Says why it is listed. */
  note?: string;
  /** Ticked when the dialog opens. Default true. */
  preselected?: boolean;
}

export interface RunPickerRequest {
  /** Dialog heading, e.g. "Run scripts — Pets". */
  title: string;
  /** One sentence above the list. */
  intro: string;
  items: readonly RunPickerItem[];
  /** Rows the grid is showing. Equal to `totalRows` when nothing is filtered. */
  visibleRows: number;
  /** Rows in the table. */
  totalRows: number;
  /** The submit button's word. Default "Run". */
  runLabel?: string;
}

export interface RunPickerResult {
  /** The ticked columns, in the order they were offered. */
  fields: string[];
  rows: 'all' | 'visible';
}

/**
 * Modal column picker. Mounted once from `<app-shell>` and reached through the
 * static `instance`, the same pattern as `script-editor-dialog`.
 */
@customElement('run-picker-dialog')
export class RunPickerDialog extends LitElement {
  static instance: RunPickerDialog | null = null;

  static override styles = [
    dialogChromeStyles,
    css`
      dialog {
        width: 520px;
        max-width: 92vw;
      }
      p.hint {
        margin: 0;
        color: #6b7280;
        font-size: 0.85rem;
      }
      /* The list scrolls rather than the dialog: a table with forty scripted
         columns must not push the row choice and the Run button off screen. */
      .list {
        border: 1px solid #e5e7eb;
        border-radius: 0.25rem;
        max-height: 40vh;
        overflow-y: auto;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.35rem 0.6rem;
        font-size: 0.9rem;
        cursor: pointer;
        user-select: none;
      }
      .row:hover {
        background: #f9fafb;
      }
      .row + .row {
        border-top: 1px solid #f3f4f6;
      }
      .row.all {
        font-weight: 600;
        background: #f9fafb;
        border-bottom: 1px solid #e5e7eb;
        position: sticky;
        top: 0;
      }
      .row input {
        margin: 0;
        cursor: pointer;
      }
      .row .note {
        margin-left: auto;
        color: #6b7280;
        font-size: 0.8rem;
        white-space: nowrap;
      }
      .row .field {
        color: #9ca3af;
        font-size: 0.8rem;
        font-family: ui-monospace, SFMono-Regular, monospace;
      }
      fieldset {
        border: 1px solid #e5e7eb;
        border-radius: 0.25rem;
        padding: 0.5rem 0.75rem;
        margin: 0;
      }
      legend {
        font-size: 0.8rem;
        color: #6b7280;
        padding: 0 0.3rem;
      }
      fieldset label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        cursor: pointer;
        padding: 0.15rem 0;
      }
    `,
  ];

  @state() private title_ = '';
  @state() private intro = '';
  @state() private items: readonly RunPickerItem[] = [];
  @state() private picked = new Set<string>();
  @state() private rows: 'all' | 'visible' = 'all';
  @state() private visibleRows = 0;
  @state() private totalRows = 0;
  @state() private runLabel = 'Run';
  private dialogEl: HTMLDialogElement | null = null;
  private resolver: ((v: RunPickerResult | null) => void) | null = null;

  override connectedCallback() {
    super.connectedCallback();
    RunPickerDialog.instance = this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (RunPickerDialog.instance === this) RunPickerDialog.instance = null;
  }

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  /**
   * Ask. Resolves with the answer, or `null` when the user backs out.
   *
   * The row choice starts on **visible** whenever the grid is showing fewer
   * rows than the table holds. A filter that is on is a filter the user put
   * there, and the narrower set is the one it is safe to be wrong about.
   */
  async open(req: RunPickerRequest): Promise<RunPickerResult | null> {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
    this.title_ = req.title;
    this.intro = req.intro;
    this.items = req.items;
    this.picked = new Set(req.items.filter((i) => i.preselected !== false).map((i) => i.field));
    this.visibleRows = req.visibleRows;
    this.totalRows = req.totalRows;
    this.rows = req.visibleRows < req.totalRows ? 'visible' : 'all';
    this.runLabel = req.runLabel ?? 'Run';
    await this.updateComplete;
    this.dialogEl?.showModal();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  private resolve(value: RunPickerResult | null) {
    const r = this.resolver;
    this.resolver = null;
    this.dialogEl?.close();
    if (r) r(value);
  }

  private onCancel = () => this.resolve(null);

  private onSubmit = (e: Event) => {
    e.preventDefault();
    if (this.picked.size === 0) return;
    this.resolve({ fields: this.items.filter((i) => this.picked.has(i.field)).map((i) => i.field), rows: this.rows });
  };

  /** A new Set every time — Lit re-renders on identity, not on mutation. */
  private toggle(field: string, on: boolean) {
    const next = new Set(this.picked);
    if (on) next.add(field);
    else next.delete(field);
    this.picked = next;
  }

  private toggleAll(on: boolean) {
    this.picked = on ? new Set(this.items.map((i) => i.field)) : new Set();
  }

  override render() {
    const all = this.items.length > 0 && this.picked.size === this.items.length;
    const some = this.picked.size > 0 && !all;
    return html`
      <dialog @cancel=${this.onCancel} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.onCancel}>×</button>
        <form @submit=${this.onSubmit}>
          <div class="dialog-header">
            <h2>${this.title_}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.onCancel}>Cancel</button>
              <button type="submit" class="primary" data-testid="run-picker-go" ?disabled=${this.picked.size === 0}>${this.runLabel}</button>
            </div>
          </div>
          <div class="dialog-body" data-testid="run-picker">
            <p class="hint">${this.intro}</p>
            <div class="list">
              <label class="row all">
                <input
                  type="checkbox"
                  data-testid="run-picker-all"
                  .checked=${all}
                  .indeterminate=${some}
                  @change=${(e: Event) => this.toggleAll((e.target as HTMLInputElement).checked)}
                />
                All (${this.items.length})
              </label>
              ${this.items.map(
                (i) => html`
                  <label class="row">
                    <input
                      type="checkbox"
                      data-testid="run-picker-item"
                      data-field=${i.field}
                      .checked=${this.picked.has(i.field)}
                      @change=${(e: Event) => this.toggle(i.field, (e.target as HTMLInputElement).checked)}
                    />
                    <span>${i.label}</span>
                    ${i.label === i.field ? null : html`<span class="field">${i.field}</span>`} ${i.note ? html`<span class="note">${i.note}</span>` : null}
                  </label>
                `,
              )}
            </div>
            <fieldset>
              <legend>Rows</legend>
              <label>
                <input
                  type="radio"
                  name="rows"
                  data-testid="run-picker-rows-visible"
                  .checked=${this.rows === 'visible'}
                  @change=${() => (this.rows = 'visible')}
                />
                Visible rows (${this.visibleRows.toLocaleString()})
              </label>
              <label>
                <input type="radio" name="rows" data-testid="run-picker-rows-all" .checked=${this.rows === 'all'} @change=${() => (this.rows = 'all')} />
                All rows (${this.totalRows.toLocaleString()})
              </label>
            </fieldset>
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-picker-dialog': RunPickerDialog;
  }
}
