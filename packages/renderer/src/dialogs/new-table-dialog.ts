import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType } from '@easydb/shared';
import { getContext } from '../app-context.js';

interface ColumnRow {
  field: string;
  label: string;
  type: ColumnType;
}

const TYPE_OPTIONS: ColumnType[] = ['string', 'number', 'boolean', 'date', 'color', 'image'];

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
      max-width: 540px;
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
      grid-template-columns: 1fr 1fr 9rem 2rem;
      gap: 0.5rem;
      align-items: center;
    }
    .col-header {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #6b7280;
    }
    button.row-del {
      background: transparent;
      border: 0;
      color: #ef4444;
      font-size: 1.1rem;
      cursor: pointer;
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
  `;

  @state() private name = '';
  @state() private columns: ColumnRow[] = [];
  @state() private errorMsg = '';

  private dialogEl: HTMLDialogElement | null = null;

  override firstUpdated() {
    this.dialogEl = this.shadowRoot?.querySelector('dialog') ?? null;
  }

  open(): void {
    this.name = '';
    this.columns = [
      { field: 'name', label: 'Name', type: 'string' },
      { field: 'note', label: 'Note', type: 'string' },
    ];
    this.errorMsg = '';
    this.updateComplete.then(() => this.dialogEl?.showModal());
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
    const columns: ColumnSpec[] = this.columns.map((c) => ({
      field: c.field.trim(),
      label: c.label.trim() || c.field.trim(),
      type: c.type,
    }));
    await ctx.store.tables.insert({
      id: cryptoUUID(),
      workspaceId: ctx.workspaceId,
      name,
      code: slug(name),
      columns,
      view: 'table',
      updatedAt: Date.now(),
    });
    this.close();
  }

  override render() {
    return html`
      <dialog @cancel=${this.close}>
        <form @submit=${this.submit}>
          <h2>New table</h2>
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
                  <button
                    type="button"
                    class="row-del"
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

          ${this.errorMsg ? html`<div class="error">${this.errorMsg}</div>` : ''}

          <div class="actions">
            <button type="button" class="ghost" @click=${this.close}>Cancel</button>
            <button type="submit" class="primary">Create</button>
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
