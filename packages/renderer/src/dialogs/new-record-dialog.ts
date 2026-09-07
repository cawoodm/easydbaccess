// packages/renderer/src/dialogs/new-record-dialog.ts
//
// The form behind a table's + button — and, over an existing row, the record
// editor behind a double-click and the `edit/…` commandlet.
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
//
// One form, three modes, because they differ in three lines and a person reading
// a record expects the same layout they typed it into:
//
//  - **new** — every field blank-or-default, Save inserts.
//  - **edit** — the row's values, Save patches ONLY the fields the form owns.
//    Derived columns are shown, disabled, so the form is the whole record.
//  - **view** — a read-only table, so nothing is writable and there is no Save.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, Row, Table } from '@easydb/shared';
import { ctrlEnterSubmits, dialogChromeStyles, makeDialogDraggable } from '@marccawood/lit-dialogs';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { blankRecord, coerceInput, hasMoreFields, inputValue, isDerived, recordFields } from '../table/new-record.js';
import { validateRecord } from '../table/validate-value.js';

/** Open the new-record form for a table (mounted lazily, one instance reused). */
export async function openNewRecordDialog(tableId: string): Promise<void> {
  const el = NewRecordDialog.instance ?? mount();
  await el.open(tableId);
}

/**
 * Open the same form over an existing row. Read-only when the table is — the
 * caller does not decide that, so a double-click and a commandlet cannot
 * disagree with the grid about whether a table may be written.
 */
export async function openEditRecordDialog(tableId: string, rowId: string): Promise<void> {
  const el = NewRecordDialog.instance ?? mount();
  await el.open(tableId, rowId);
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
      .locked input,
      .locked textarea {
        background: #f3f4f6;
        color: #6b7280;
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
  /** The row being edited. `null` ⇒ this is a new record. */
  @state() private row: Row | null = null;
  /** The row is shown but cannot be written — the table is read-only. */
  @state() private viewOnly = false;
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

  /** `rowId` given ⇒ edit that row. Omitted ⇒ a new record. */
  async open(tableId: string, rowId?: string): Promise<void> {
    const ctx = await getContext();
    const t = await ctx.store.tables.findOne(tableId);
    if (!t) return;
    let row: Row | null = null;
    if (rowId !== undefined) {
      row = await ctx.store.rows(tableId).findOne(rowId);
      if (!row) {
        ctx.api.ui.dialogs.toast('That record no longer exists.', { kind: 'error', title: t.name });
        return;
      }
    }
    this.table = t;
    this.row = row;
    this.viewOnly = row !== null && t.readonly === true;
    // Every column, not just the shown ones: a hidden column with a default
    // still gets it, or the row would differ from one the grid's own + made.
    // Over an existing row the defaults fill in only what the row has no key
    // for, so a column added after the row was written shows its default
    // instead of an empty box.
    this.data = row ? { ...blankRecord(t.columns), ...row.data } : blankRecord(t.columns);
    this.showAll = false;
    this.saving = false;
    this.armed = false;
    this.recheck();
    await this.updateComplete;
    this.dialogEl?.showModal();
    // The first field, so the form can be filled from the keyboard alone.
    (this.shadowRoot?.querySelector('.fields input:not([disabled]), .fields textarea:not([disabled])') as HTMLElement | null)?.focus();
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
    // Only the fields the form can write. A derived column is shown in edit mode
    // but has no write target, so a rule it fails is not something the user can
    // act on here — and a read-only record has nothing to act on at all.
    this.issues = this.table && !this.viewOnly ? validateRecord(this.writableFields, this.data) : new Map();
  }

  /** Editing an existing row? Decides the fields, the title and the write. */
  private get editing(): boolean {
    return this.row !== null;
  }

  private get fields(): ColumnSpec[] {
    return this.table ? recordFields(this.table.columns, this.showAll, this.editing) : [];
  }

  /** Of those, the ones the form may write back. */
  private get writableFields(): ColumnSpec[] {
    return this.fields.filter((c) => !isDerived(c));
  }

  /** Is this field drawn as a box the user can type in? */
  private locked(c: ColumnSpec): boolean {
    return this.viewOnly || isDerived(c);
  }

  private set(field: string, value: unknown): void {
    this.data = { ...this.data, [field]: value };
    this.recheck();
  }

  private async submit(e: Event) {
    e.preventDefault();
    const t = this.table;
    if (!t || this.saving) return;
    // Nothing to write: the form is a reader, so the only button closes it.
    if (this.viewOnly) {
      this.close();
      return;
    }
    // A first press with problems outstanding only ARMS the button, so "Save
    // anyway" is something the user reads before it happens rather than after.
    if (this.issues.size > 0 && !this.armed) {
      this.armed = true;
      this.requestUpdate();
      return;
    }
    this.saving = true;
    const ctx = await getContext();
    const row = this.row;
    try {
      if (row) {
        // ONLY the fields the form owns, over what the row already holds. A
        // patch of the whole form state would write a default into every
        // derived column and into every key the row simply does not have.
        const data = { ...row.data };
        for (const c of this.writableFields) data[c.field] = this.data[c.field];
        await ctx.store.rows(t.id).patch(row.id, { data, updatedAt: Date.now() });
      } else {
        await ctx.store.rows(t.id).insert({ id: crypto.randomUUID(), tableId: t.id, data: this.data, updatedAt: Date.now() });
      }
      const kept = this.issues.size;
      const done = row ? 'updated' : 'added';
      ctx.api.ui.dialogs.toast(kept > 0 ? `Record ${done} with ${kept} unresolved ${kept === 1 ? 'problem' : 'problems'}.` : `Record ${done}.`, {
        kind: kept > 0 ? 'warning' : 'success',
        title: t.name,
      });
      this.close();
    } catch (err) {
      // A remote row source can refuse the write — read-only table, expired
      // token. Say so and leave the form as it is, so nothing typed is lost.
      await ctx.api.ui.dialogs.alert((err as Error)?.message ?? 'Could not save the record.', row ? 'Not saved' : 'Not added');
    } finally {
      this.saving = false;
    }
  }

  /** Has the user seen the "Save anyway" wording yet? */
  private armed = false;

  private field(c: ColumnSpec) {
    const why = this.issues.get(c.field);
    const value = this.data[c.field];
    const off = this.locked(c);
    const cls = `field${why ? ' broken' : ''}${c.type === 'boolean' ? ' bool' : ''}${off ? ' locked' : ''}`;
    const label = html`<span class="name">
      <span>${c.label || c.field}</span>
      ${c.notnull ? html`<span class="req" title="Required">*</span>` : nothing} ${c.units ? html`<span class="units">${c.units}</span>` : nothing}
      ${c.hidden ? html`<span class="type" title="Hidden in the grid">hidden</span>` : nothing}
      ${off && !this.viewOnly ? html`<span class="type" title="This column has no write target">read-only</span>` : nothing}
    </span>`;
    const onInput = (e: Event) => this.set(c.field, coerceInput(c.type, (e.target as HTMLInputElement).value));

    if (c.type === 'boolean') {
      return html`<label class=${cls}>
        <input type="checkbox" ?disabled=${off} .checked=${value === true} @change=${(e: Event) => this.set(c.field, (e.target as HTMLInputElement).checked)} />
        ${label}
      </label>`;
    }
    const box =
      c.type === 'text'
        ? html`<textarea ?disabled=${off} .value=${inputValue(value)} @input=${onInput} spellcheck="false"></textarea>`
        : html`<input
            type=${c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : c.type === 'datetime' ? 'datetime-local' : 'text'}
            ?disabled=${off}
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
    const title = this.viewOnly ? 'Record' : this.editing ? 'Edit record' : 'New record';
    return html`
      <dialog @cancel=${this.close} @keydown=${ctrlEnterSubmits}>
        <button type="button" class="close-x" title="Close" @click=${this.close}>×</button>
        <form @submit=${this.submit}>
          <div class="dialog-header">
            <h2>${title}${t ? html` &mdash; ${t.name}` : nothing}</h2>
            <div class="header-actions">
              ${this.viewOnly
                ? html`<button type="button" class="primary" @click=${this.close}>Close</button>`
                : html`<button type="button" class="ghost" @click=${this.close}>Cancel</button>
                    <button type="submit" class="primary" ?disabled=${this.saving}>${problems > 0 && this.armed ? 'Save anyway' : 'Save'}</button>`}
            </div>
          </div>
          <div class="dialog-body">
            ${this.viewOnly ? html`<p class="none">This table is read-only, so the record is shown as it stands.</p>` : nothing}
            ${t && hasMoreFields(t.columns, this.editing)
              ? html`<label class="toggle">
                  <input type="checkbox" .checked=${this.showAll} @change=${(e: Event) => ((this.showAll = (e.target as HTMLInputElement).checked), this.recheck())} />
                  Show all fields
                </label>`
              : nothing}
            <div class="fields">
              ${fields.length === 0
                ? html`<p class="none">${this.editing ? 'This table has no fields to show.' : 'This table has no fields to fill in. Save adds an empty record.'}</p>`
                : fields.map((c) => this.field(c))}
            </div>
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
