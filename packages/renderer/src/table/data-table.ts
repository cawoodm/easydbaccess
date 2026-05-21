import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, Row } from '@easydb/shared';
import { getContext } from '../app-context.js';

@customElement('data-table')
export class DataTable extends LitElement {
  static override styles = css`
    :host {
      display: block;
      overflow: auto;
      max-height: 60vh;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th,
    td {
      border: 1px solid #e5e7eb;
      padding: 0.25rem 0.5rem;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f9fafb;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    td input {
      width: 100%;
      box-sizing: border-box;
      border: 0;
      background: transparent;
      font: inherit;
      padding: 0;
    }
    td input:focus {
      outline: 2px solid #3b82f6;
      outline-offset: -2px;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      padding: 0.5rem;
      background: #f9fafb;
      border-top: 1px solid #e5e7eb;
    }
    button {
      font: inherit;
      padding: 0.25rem 0.75rem;
      border: 1px solid #d1d5db;
      background: white;
      border-radius: 0.25rem;
      cursor: pointer;
    }
    button:hover {
      background: #f3f4f6;
    }
    button.danger {
      color: #ef4444;
      border: 0;
      background: transparent;
      padding: 0 0.25rem;
    }
  `;

  @property({ type: String }) tableId = '';
  @state() private columns: ColumnSpec[] = [];
  @state() private rows: Row[] = [];
  private unsubscribe?: () => void;

  override async connectedCallback() {
    super.connectedCallback();
    await this.bind();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  override async updated(changed: Map<string, unknown>) {
    if (changed.has('tableId') && this.tableId) {
      this.unsubscribe?.();
      await this.bind();
    }
  }

  private async bind() {
    if (!this.tableId) return;
    const ctx = await getContext();
    const table = await ctx.store.tables.findOne(this.tableId);
    if (!table) return;
    this.columns = table.columns;
    const rowColl = ctx.store.rows(this.tableId);
    this.unsubscribe = rowColl.subscribe((r) => (this.rows = r));
    this.rows = await rowColl.find();
  }

  private async addRow() {
    const ctx = await getContext();
    const blank: Record<string, unknown> = {};
    for (const c of this.columns) blank[c.field] = c.default ?? '';
    await ctx.store.rows(this.tableId).insert({
      id: crypto.randomUUID(),
      tableId: this.tableId,
      data: blank,
      updatedAt: Date.now(),
    });
  }

  private async editCell(row: Row, field: string, raw: string) {
    const ctx = await getContext();
    const col = this.columns.find((c) => c.field === field);
    const value = coerce(raw, col?.type ?? 'string');
    await ctx.store.rows(this.tableId).patch(row.id, {
      data: { ...row.data, [field]: value },
      updatedAt: Date.now(),
    });
  }

  private async deleteRow(rowId: string) {
    const ctx = await getContext();
    await ctx.store.rows(this.tableId).remove(rowId);
  }

  override render() {
    return html`
      <table>
        <thead>
          <tr>
            ${this.columns.map((c) => html`<th title=${c.field}>${c.label}</th>`)}
            <th style="width:2rem"></th>
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(
            (r) => html`
              <tr>
                ${this.columns.map(
                  (c) => html`
                    <td>
                      <input
                        .value=${String(r.data[c.field] ?? '')}
                        @change=${(e: Event) =>
                          this.editCell(r, c.field, (e.target as HTMLInputElement).value)}
                      />
                    </td>
                  `,
                )}
                <td><button class="danger" @click=${() => this.deleteRow(r.id)}>×</button></td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      <div class="actions">
        <button @click=${this.addRow}>+ Add row</button>
        <span style="color:#6b7280; font-size:.85em; align-self:center">
          ${this.rows.length} row${this.rows.length === 1 ? '' : 's'}
        </span>
      </div>
    `;
  }
}

function coerce(raw: string, type: ColumnSpec['type']): unknown {
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'date':
      return raw;
    default:
      return raw;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'data-table': DataTable;
  }
}
