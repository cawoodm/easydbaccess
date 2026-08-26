// packages/renderer/src/dialogs/new-record-dialog.ts
//
// The form behind a table's + button.
//
// It used to insert a blank row straight into the table, which left the user to
// find the new row in the grid — at the bottom of 600,000 others, under whatever
// sort was on — and fill it in cell by cell. The form asks for the fields
// instead, in one place, with the column's own defaults already in the boxes.
//
// Three rules, all of them deliberate:
//
//  - **Visible fields only, until asked.** A table showing six of its forty
//    columns is showing what the user cares about. "Show all fields" reveals the
//    rest. Every column still gets its default written either way.
//  - **Validation is shown, not enforced.** The rules run as you type and again
//    on save, and the button says "Save anyway" when something is wrong. A record
//    half-known is worth keeping; the grid marks what is invalid and the Validate
//    button lists it. This is the one place in the app where a rule is advice.
//  - **The rules are the grid's own** (`table/validate-value.ts`), so a value the
//    form accepts is one a cell edit would accept, in the same words.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, Table } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { blankRecord, coerceInput, hasMoreFields, inputValue, recordFields } from '../table/new-record.js';
import { validateRecord } from '../table/validate-value.js';

/** Open the new-record form for a table (mounted lazily, one instance reused). */
export async function openNewRecordDialog(tableId: string): Promise<void> {
  const el = NewRecordDialog.instance ?? mount();
  await el.open(tableId);
}

function mount(): NewRecordDialog {
  const el = document.createElement('new-record-dialog') as NewRecordDialog;
  document.body.appendChild(el);
  return el;
}

@customElement('new-record-dialog')
export class NewRecordDialog extends LitElement {
  static instance: NewRecordDialog | null = null;

  static override styles = [
    materialIconStyles,
    dialogChromeStyles,
    css`
      dialog {
        width: 520px;
        max-width: 94vw;
      }
      .fields {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      label.field {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.85rem;
        color: #374151;
      }
      label.field .name {
        display: flex;
        align-items: baseline;
        gap: 0.35rem;
      }
      .req {
        color: #ef4444;
      }
      .units,
      .type {
        color: #9ca3af;
        font-size: 0.75rem;
      }
      input[type='text'],
      input[type='number'],
      input[type='date'],
      input[type='datetime-local'],
      textarea {
        font: inherit;
        padding: 0.35rem 0.5rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
      }
      textarea {
        min-height: 4.5rem;
        resize: vertical;
      }
      .bool {
        flex-direction: row;
        align-items: center;
        gap: 0.45rem;
      }
      .broken input,
      .broken textarea {
        border-color: #f59e0b;
      }
      .why {
        color: #b45309;
        font-size: 0.78rem;
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.8rem;
        color: #6b7280;
        margin: 0 0 0.5rem;
      }
      .none {
        color: #6b7280;
        font-size: 0.85rem;
        margin: 0;
      }
      .summary {
        color: #b45309;
        font-size: 0.8rem;
        margin: 0.6rem 0 0;
      }
    `,
  ];

  @state() private table: Table | null = null;
  @state() private data: Record<string, unknown> = {};
  @state() private showAll = false;
  /** Field → why it is wrong. Recomputed on every keystroke. */
  @state() private issues: Map<string, string> = new Map();
  /** Set once Save has been pressed with issues outstanding. */
  @state() private saving = false;
  private dialogEl: HTMLDialogElement | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    NewRecordDialog.instance = this;
  }

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
    const header = this.shadowRoot?.querySelector('.dialog-header') as HTMLElement | null;
    if (this.dialogEl && header) makeDialogDraggable(this.dialogEl, header);
  }

  async open(tableId: string): Promise<void> {
    const ctx = await getContext();
    const t = await ctx.store.tables.findOne(tableId);
    if (!t) return;
    this.table = t;
    // Every column, not just the shown ones: a hidden column with a default
    // still gets it, or the row would differ from one the grid's own + made.
    this.data = blankRecord(t.columns);
    this.showAll = false;
    this.saving = false;
    this.recheck();
    await this.updateComplete;
    this.dialogEl?.showModal();
    // The first field, so the form can be filled from the keyboard alone.
    (this.shadowRoot?.querySelector('.fields input, .fields textarea') as HTMLElement | null)?.focus();
  }

  private close() {
    this.dialogEl?.close();
  }

  /**
   * Re-run every rule over the whole record.
   *
   * The whole record on every keystroke, not just the field that changed: a
   * `validate` script may compare two fields, so editing one can fix or break
   * the other. Over a form-sized column list this costs nothing.
   *
   * `allRows` is empty, so `unique` is not checked here — see
   * `table/validate-value.ts`. A duplicate is caught by the next cell edit or by
   * the Validate button, both of which have the rows to answer it.
   */
  private recheck(): void {
    this.issues = this.table ? validateRecord(this.fields, this.data) : new Map();
  }

  private get fields(): ColumnSpec[] {
    return this.table ? recordFields(this.table.columns, this.showAll) : [];
  }

  private set(field: string, value: unknown): void {
    this.data = { ...this.data, [field]: value };
    this.recheck();
  }

  private async submit(e: Event) {
    e.preventDefault();
    const t = this.table;
    if (!t || this.saving) return;
    // A first press with problems outstanding only ARMS the button, so "Save
    // anyway" is something the user reads before it happens rather than after.
    if (this.issues.size > 0 && !this.armed) {
      this.armed = true;
      this.requestUpdate();
      return;
    }
    this.saving = true;
    const ctx = await getContext();
    try {
      await ctx.store.rows(t.id).insert({ id: crypto.randomUUID(), tableId: t.id, data: this.data, updatedAt: Date.now() });
      const kept = this.issues.size;
      ctx.api.ui.dialogs.toast(kept > 0 ? `Record added with ${kept} unresolved ${kept === 1 ? 'problem' : 'problems'}.` : 'Record added.', { kind: kept > 0 ? 'warning' : 'success', title: t.name });
      this.close();
    } catch (err) {
      // A remote row source can refuse the write — read-only table, expired
      // token. Say so and leave the form as it is, so nothing typed is lost.
      await ctx.api.ui.dialogs.alert((err as Error)?.message ?? 'Could not add the record.', 'Not added');
    } finally {
      this.saving = false;
    }
  }

  /** Has the user seen the "Save anyway" wording yet? */
  private armed = false;

  private field(c: ColumnSpec) {
    const why = this.issues.get(c.field);
    const value = this.data[c.field];
    const cls = `field${why ? ' broken' : ''}${c.type === 'boolean' ? ' bool' : ''}`;
    const label = html`<span class="name">
      <span>${c.label || c.field}</span>
      ${c.notnull ? html`<span class="req" title="Required">*</span>` : nothing} ${c.units ? html`<span class="units">${c.units}</span>` : nothing}
      ${c.hidden ? html`<span class="type" title="Hidden in the grid">hidden</span>` : nothing}
    </span>`;
    const onInput = (e: Event) => this.set(c.field, coerceInput(c.type, (e.target as HTMLInputElement).value));

    if (c.type === 'boolean') {
      return html`<label class=${cls}>
        <input type="checkbox" .checked=${value === true} @change=${(e: Event) => this.set(c.field, (e.target as HTMLInputElement).checked)} />
        ${label}
      </label>`;
    }
    const box =
      c.type === 'text'
        ? html`<textarea .value=${inputValue(value)} @input=${onInput} spellcheck="false"></textarea>`
        : html`<input
            type=${c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : c.type === 'datetime' ? 'datetime-local' : 'text'}
            .value=${inputValue(value)}
            placeholder=${c.type === 'array' ? 'comma-separated' : ''}
            title=${c.description ?? ''}
            @input=${onInput}
          />`;
    return html`<label class=${cls}>${label}${box}${why ? html`<span class="why">${why}</span>` : nothing}</label>`;
  }

  override render() {
    const t = this.table;
    const fields = this.fields;
    const problems = this.issues.size;
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>New record${t ? html` &mdash; ${t.name}` : nothing}</h2>
            <div class="header-actions">
              <button type="button" class="ghost" @click=${this.close}>Cancel</button>
              <button type="submit" class="primary" ?disabled=${this.saving}>${problems > 0 && this.armed ? 'Save anyway' : 'Save'}</button>
            </div>
          </div>
          <div class="dialog-body">
            ${t && hasMoreFields(t.columns)
              ? html`<label class="toggle">
                  <input type="checkbox" .checked=${this.showAll} @change=${(e: Event) => ((this.showAll = (e.target as HTMLInputElement).checked), this.recheck())} />
                  Show all fields
                </label>`
              : nothing}
            <div class="fields">${fields.length === 0 ? html`<p class="none">This table has no fields to fill in. Save adds an empty record.</p>` : fields.map((c) => this.field(c))}</div>
            ${problems > 0
              ? html`<p class="summary">
                  ${problems === 1 ? 'One field does not meet its rule' : `${problems} fields do not meet their rules`}. You can still save &mdash; the grid marks what is wrong.
                </p>`
              : nothing}
          </div>
        </form>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'new-record-dialog': NewRecordDialog;
  }
}
