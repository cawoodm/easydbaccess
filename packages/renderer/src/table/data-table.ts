import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType, Row, Table } from '@easydb/shared';
import { getContext } from '../app-context.js';

type SortDir = 'asc' | 'desc' | null;

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
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    th:hover {
      background: #eef2f7;
    }
    th .sort-icon {
      display: inline-block;
      width: 0.75em;
      color: #6b7280;
      font-size: 0.75em;
      margin-left: 0.25rem;
    }
    th.sorted .sort-icon {
      color: #2563eb;
    }
    td input[type='text'] {
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
    td input[type='color'] {
      width: 1.5rem;
      height: 1.25rem;
      padding: 0;
      border: 1px solid #d1d5db;
      background: transparent;
      vertical-align: middle;
      cursor: pointer;
    }
    td .color-cell {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    td .color-cell input[type='text'] {
      width: 6rem;
      font-family: ui-monospace, SFMono-Regular, monospace;
    }
    td input[type='checkbox'] {
      transform: translateY(1px);
      cursor: pointer;
    }
    td .image-cell {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    td .image-cell img {
      max-height: 32px;
      max-width: 64px;
      border-radius: 0.15rem;
      border: 1px solid #e5e7eb;
    }
    td .image-cell button {
      padding: 0.1rem 0.4rem;
      font-size: 0.75rem;
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
  @state() private sortColumn: string | null = null;
  @state() private sortDir: SortDir = null;
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
    this.sortColumn = table.sortColumn ?? null;
    this.sortDir = table.sortColumn ? (table.sortAsc === false ? 'desc' : 'asc') : null;
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

  private async setCell(row: Row, field: string, value: unknown) {
    const ctx = await getContext();
    await ctx.store.rows(this.tableId).patch(row.id, {
      data: { ...row.data, [field]: value },
      updatedAt: Date.now(),
    });
  }

  private async pickImage(row: Row, field: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      await this.setCell(row, field, dataUrl);
    });
    input.click();
  }

  private renderCell(row: Row, col: ColumnSpec) {
    const raw = row.data[col.field];
    switch (col.type) {
      case 'boolean': {
        const checked = raw === true || raw === 'true' || raw === 1 || raw === '1';
        return html`<input
          type="checkbox"
          .checked=${checked}
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).checked)}
        />`;
      }
      case 'color': {
        const hex = typeof raw === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw : '#000000';
        return html`<span class="color-cell">
          <input
            type="color"
            .value=${hex}
            @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            .value=${typeof raw === 'string' ? raw : ''}
            @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value)}
          />
        </span>`;
      }
      case 'image': {
        const src = typeof raw === 'string' && raw.startsWith('data:image') ? raw : '';
        return html`<span class="image-cell">
          ${src ? html`<img src=${src} alt="" />` : html`<span style="color:#9ca3af">no image</span>`}
          <button type="button" @click=${() => this.pickImage(row, col.field)}>
            ${src ? 'replace' : 'upload'}
          </button>
          ${src
            ? html`<button type="button" @click=${() => this.setCell(row, col.field, '')}>clear</button>`
            : ''}
        </span>`;
      }
      default:
        return html`<input
          type="text"
          .value=${String(raw ?? '')}
          @change=${(e: Event) =>
            this.editCell(row, col.field, (e.target as HTMLInputElement).value)}
        />`;
    }
  }

  private async deleteRow(rowId: string) {
    const ctx = await getContext();
    await ctx.store.rows(this.tableId).remove(rowId);
  }

  /**
   * Click cycle on a column header: none → asc → desc → none.
   * Sort state is persisted on the Table record so it survives reloads
   * and rides along through the dump/restore export path.
   */
  private async toggleSort(field: string) {
    let nextDir: SortDir;
    if (this.sortColumn !== field) nextDir = 'asc';
    else if (this.sortDir === 'asc') nextDir = 'desc';
    else if (this.sortDir === 'desc') nextDir = null;
    else nextDir = 'asc';

    this.sortColumn = nextDir ? field : null;
    this.sortDir = nextDir;

    const ctx = await getContext();
    const patch: Partial<Table> = nextDir
      ? { sortColumn: field, sortAsc: nextDir === 'asc', updatedAt: Date.now() }
      : { sortColumn: undefined, sortAsc: undefined, updatedAt: Date.now() };
    await ctx.store.tables.patch(this.tableId, patch);
  }

  private sortedRows(): Row[] {
    if (!this.sortColumn || !this.sortDir) return this.rows;
    const field = this.sortColumn;
    const col = this.columns.find((c) => c.field === field);
    const type: ColumnType = col?.type ?? 'string';
    const factor = this.sortDir === 'asc' ? 1 : -1;
    const arr = [...this.rows];
    arr.sort((a, b) => compareValues(a.data[field], b.data[field], type) * factor);
    return arr;
  }

  override render() {
    const rows = this.sortedRows();
    return html`
      <table>
        <thead>
          <tr>
            ${this.columns.map((c) => {
              const sorted = this.sortColumn === c.field && this.sortDir;
              const icon = sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '⇅';
              return html`
                <th
                  class=${sorted ? 'sorted' : ''}
                  title=${`${c.field} — click to sort`}
                  @click=${() => this.toggleSort(c.field)}
                >
                  ${c.label}<span class="sort-icon">${icon}</span>
                </th>
              `;
            })}
            <th style="width:2rem"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`
              <tr>
                ${this.columns.map((c) => html`<td>${this.renderCell(r, c)}</td>`)}
                <td><button class="danger" @click=${() => this.deleteRow(r.id)}>×</button></td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      <div class="actions">
        <button @click=${this.addRow}>+ Add row</button>
        <span style="color:#6b7280; font-size:.85em; align-self:center">
          ${rows.length} row${rows.length === 1 ? '' : 's'}
        </span>
      </div>
    `;
  }
}

function coerce(raw: string, type: ColumnType): unknown {
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

function compareValues(a: unknown, b: unknown, type: ColumnType): number {
  // Always sort null/undefined/empty to the end.
  const aEmpty = a == null || a === '';
  const bEmpty = b == null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  switch (type) {
    case 'number': {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return String(a).localeCompare(String(b));
      return na - nb;
    }
    case 'boolean':
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 'date': {
      const ta = new Date(String(a)).getTime();
      const tb = new Date(String(b)).getTime();
      if (Number.isNaN(ta) || Number.isNaN(tb)) return String(a).localeCompare(String(b));
      return ta - tb;
    }
    default:
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'data-table': DataTable;
  }
}
