import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType } from '@easydb/shared';
import { getContext } from '../app-context.js';

interface ColumnRow {
  field: string;
  label: string;
  type: ColumnType;
  max?: number | undefined;
  unique?: boolean | undefined;
  notnull?: boolean | undefined;
  /** field name in the saved table (edit mode only); used to detect field renames */
  origField?: string | undefined;
}

const TYPE_OPTIONS: ColumnType[] = ['string', 'number', 'boolean', 'date', 'color', 'image'];

/**
 * Dual-purpose dialog: creates new tables and edits the columns of existing
 * ones. Open mode is chosen by the optional tableId argument to open().
 *
 * Edit mode keeps existing field names intact by default (renames are
 * destructive — they would require re-keying every row's data object).
 * Renaming is still allowed if you really want it, but the warning text
 * below the columns spells out what happens.
 */
@customElement('new-table-dialog')
export class NewTableDialog extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
    dialog {
      border: 0;
      border-radius: 0.5rem;
      padding: 0;
      max-width: 580px;
      width: 100%;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
      font-family: system-ui, sans-serif;
    }
    dialog::backdrop {
      background: rgba(15, 23, 42, 0.4);
    }
    form {
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    h2 {
      margin: 0;
      font-size: 1.1rem;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      font-size: 0.85rem;
      color: #374151;
    }
    input,
    select {
      font: inherit;
      padding: 0.4rem 0.5rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
    }
    .columns {
      display: grid;
      gap: 0.5rem;
    }
    .col-header,
    .col-row {
      display: grid;
      grid-template-columns: 1fr 1fr 7rem 4rem 1.5rem 1.5rem 1.5rem 1.5rem 1.5rem;
      gap: 0.4rem;
      align-items: center;
    }
    .col-row input[type='number'] {
      width: 100%;
      box-sizing: border-box;
    }
    .col-row .flag {
      display: inline-flex;
      justify-content: center;
    }
    .col-header .flag-label {
      font-size: 0.7rem;
      text-align: center;
    }
    .col-header {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #6b7280;
    }
    button.icon-btn {
      background: transparent;
      border: 0;
      color: #6b7280;
      cursor: pointer;
      padding: 0;
      font-size: 1rem;
    }
    button.icon-btn:hover:not(:disabled) {
      color: #111827;
    }
    button.icon-btn:disabled {
      color: #d1d5db;
      cursor: not-allowed;
    }
    button.row-del {
      color: #ef4444;
      font-size: 1.1rem;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      border-top: 1px solid #e5e7eb;
      padding-top: 0.75rem;
    }
    button.primary {
      background: #3b82f6;
      color: white;
      border: 0;
      padding: 0.45rem 0.9rem;
      border-radius: 0.25rem;
      cursor: pointer;
    }
    button.primary:hover {
      background: #2563eb;
    }
    button.ghost {
      background: transparent;
      border: 1px solid #d1d5db;
      padding: 0.45rem 0.9rem;
      border-radius: 0.25rem;
      cursor: pointer;
    }
    button.add {
      align-self: start;
      background: #f3f4f6;
      border: 1px dashed #9ca3af;
      padding: 0.4rem 0.75rem;
      border-radius: 0.25rem;
      cursor: pointer;
    }
    .error {
      color: #ef4444;
      font-size: 0.85rem;
    }
    .hint {
      color: #6b7280;
      font-size: 0.78rem;
    }
  `;

  @state() private mode: 'new' | 'edit' = 'new';
  @state() private editTableId: string | null = null;
  @state() private name = '';
  @state() private columns: ColumnRow[] = [];
  @state() private errorMsg = '';

  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
  }

  /**
   * Open the dialog. If tableId is provided, opens in "edit" mode and pre-fills
   * the form from the saved Table. Otherwise opens "new" mode with two default
   * string columns.
   */
  async open(tableId?: string): Promise<void> {
    this.errorMsg = '';
    if (tableId) {
      const ctx = await getContext();
      const t = await ctx.store.tables.findOne(tableId);
      if (!t) return;
      this.mode = 'edit';
      this.editTableId = tableId;
      this.name = t.name;
      this.columns = t.columns.map((c) => ({
        field: c.field,
        label: c.label,
        type: c.type,
        max: c.max,
        unique: c.unique,
        notnull: c.notnull,
        origField: c.field,
      }));
    } else {
      this.mode = 'new';
      this.editTableId = null;
      this.name = '';
      this.columns = [
        { field: 'name', label: 'Name', type: 'string' },
        { field: 'note', label: 'Note', type: 'string' },
      ];
    }
    await this.updateComplete;
    this.dialogEl?.showModal();
  }

  private close(): void {
    this.dialogEl?.close();
  }

  private addColumn(): void {
    const i = this.columns.length + 1;
    this.columns = [
      ...this.columns,
      { field: `field_${i}`, label: `Field ${i}`, type: 'string' },
    ];
  }

  private removeColumn(idx: number): void {
    this.columns = this.columns.filter((_, i) => i !== idx);
  }

  private moveColumn(idx: number, delta: -1 | 1): void {
    const j = idx + delta;
    if (j < 0 || j >= this.columns.length) return;
    const next = [...this.columns];
    const [item] = next.splice(idx, 1);
    next.splice(j, 0, item!);
    this.columns = next;
  }

  private patchColumn(idx: number, patch: Partial<ColumnRow>): void {
    this.columns = this.columns.map((c, i) => (i === idx ? { ...c, ...patch } : c));
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    const name = this.name.trim();
    if (!name) {
      this.errorMsg = 'Table name is required.';
      return;
    }
    if (this.columns.length === 0) {
      this.errorMsg = 'At least one column is required.';
      return;
    }
    const seen = new Set<string>();
    for (const c of this.columns) {
      const f = c.field.trim();
      if (!f) {
        this.errorMsg = 'Column field names cannot be empty.';
        return;
      }
      if (seen.has(f)) {
        this.errorMsg = `Duplicate column field: ${f}`;
        return;
      }
      seen.add(f);
    }

    const ctx = await getContext();
    const columns: ColumnSpec[] = this.columns.map((c) => {
      const spec: ColumnSpec = {
        field: c.field.trim(),
        label: c.label.trim() || c.field.trim(),
        type: c.type,
      };
      if (c.max != null && c.max > 0) spec.max = c.max;
      if (c.unique) spec.unique = true;
      if (c.notnull) spec.notnull = true;
      return spec;
    });

    if (this.mode === 'edit' && this.editTableId) {
      // Patch the saved table; row data isn't migrated. If a field was
      // renamed, downstream cells will read undefined and display as empty.
      await ctx.store.tables.patch(this.editTableId, {
        name,
        columns,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.store.tables.insert({
        id: cryptoUUID(),
        workspaceId: ctx.workspaceId,
        name,
        code: slug(name),
        columns,
        view: 'table',
        updatedAt: Date.now(),
      });
    }
    this.close();
  }

  private renameDetected(): boolean {
    return (
      this.mode === 'edit' &&
      this.columns.some((c) => c.origField && c.origField !== c.field.trim())
    );
  }

  override render() {
    const title = this.mode === 'edit' ? 'Edit columns' : 'New table';
    const submitLabel = this.mode === 'edit' ? 'Save' : 'Create';
    return html`
      <dialog @cancel=${this.close}>
        <form @submit=${this.submit}>
          <h2>${title}</h2>
          <label>
            Name
            <input
              type="text"
              autofocus
              .value=${this.name}
              @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="columns">
            <div class="col-header">
              <span>Field</span>
              <span>Label</span>
              <span>Type</span>
              <span class="flag-label">Max</span>
              <span class="flag-label" title="Unique">U</span>
              <span class="flag-label" title="Not null">!</span>
              <span></span>
              <span></span>
              <span></span>
            </div>
            ${this.columns.map(
              (c, i) => html`
                <div class="col-row">
                  <input
                    type="text"
                    .value=${c.field}
                    @input=${(e: Event) =>
                      this.patchColumn(i, { field: (e.target as HTMLInputElement).value })}
                  />
                  <input
                    type="text"
                    .value=${c.label}
                    @input=${(e: Event) =>
                      this.patchColumn(i, { label: (e.target as HTMLInputElement).value })}
                  />
                  <select
                    .value=${c.type}
                    @change=${(e: Event) =>
                      this.patchColumn(i, {
                        type: (e.target as HTMLSelectElement).value as ColumnType,
                      })}
                  >
                    ${TYPE_OPTIONS.map(
                      (t) => html`<option value=${t} ?selected=${t === c.type}>${t}</option>`,
                    )}
                  </select>
                  <input
                    type="number"
                    min="0"
                    placeholder="—"
                    title="Max length (strings) or max value (numbers)"
                    .value=${c.max == null ? '' : String(c.max)}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      this.patchColumn(i, { max: v === '' ? undefined : Number(v) });
                    }}
                  />
                  <span class="flag">
                    <input
                      type="checkbox"
                      title="Unique"
                      .checked=${!!c.unique}
                      @change=${(e: Event) =>
                        this.patchColumn(i, { unique: (e.target as HTMLInputElement).checked })}
                    />
                  </span>
                  <span class="flag">
                    <input
                      type="checkbox"
                      title="Not null"
                      .checked=${!!c.notnull}
                      @change=${(e: Event) =>
                        this.patchColumn(i, { notnull: (e.target as HTMLInputElement).checked })}
                    />
                  </span>
                  <button
                    type="button"
                    class="icon-btn"
                    title="Move up"
                    ?disabled=${i === 0}
                    @click=${() => this.moveColumn(i, -1)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    title="Move down"
                    ?disabled=${i === this.columns.length - 1}
                    @click=${() => this.moveColumn(i, 1)}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    class="icon-btn row-del"
                    title="Remove column"
                    @click=${() => this.removeColumn(i)}
                  >
                    ×
                  </button>
                </div>
              `,
            )}
          </div>

          <button type="button" class="add" @click=${this.addColumn}>+ Add column</button>

          ${this.renameDetected()
            ? html`<div class="hint">
                Renamed fields will appear empty for existing rows — the row data
                isn't migrated automatically.
              </div>`
            : ''}
          ${this.errorMsg ? html`<div class="error">${this.errorMsg}</div>` : ''}

          <div class="actions">
            <button type="button" class="ghost" @click=${this.close}>Cancel</button>
            <button type="submit" class="primary">${submitLabel}</button>
          </div>
        </form>
      </dialog>
    `;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'new-table-dialog': NewTableDialog;
  }
}
