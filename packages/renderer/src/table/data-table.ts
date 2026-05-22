import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType, Row, Table } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';

type SortDir = 'asc' | 'desc' | null;

@customElement('data-table')
export class DataTable extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
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
    th[draggable='true'] {
      cursor: grab;
    }
    /* 6px right-edge resize gutter; absolute so it doesn't push cell text. The
       th is already position: sticky (declared in the main th rule above),
       which is a containing block for absolute children. */
    th .col-resize {
      position: absolute;
      top: 0;
      right: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      user-select: none;
      z-index: 2;
    }
    th .col-resize:hover {
      background: #3b82f6;
      opacity: 0.4;
    }
    th.drag-source {
      opacity: 0.4;
    }
    th.drop-before {
      box-shadow: inset 3px 0 0 #3b82f6;
    }
    th.drop-after {
      box-shadow: inset -3px 0 0 #3b82f6;
    }
    tr.filter-row th {
      cursor: default;
      background: #f3f4f6;
      padding: 0.15rem 0.3rem;
      top: 1.85em; /* sits just below the header row */
      z-index: 1;
    }
    tr.filter-row th:hover {
      background: #f3f4f6;
    }
    tr.filter-row input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d1d5db;
      border-radius: 0.2rem;
      background: white;
      font: inherit;
      font-size: 0.8rem;
      padding: 0.1rem 0.3rem;
    }
    tr.filter-row input::placeholder {
      color: #9ca3af;
      font-style: italic;
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
      color: #9ca3af;
      border: 0;
      background: transparent;
      padding: 0 0.25rem;
      font-size: 1.1rem;
      line-height: 1;
      cursor: pointer;
    }
    button.danger:hover {
      color: #ef4444;
    }
    th.t-number,
    td.t-number {
      text-align: right;
    }
    th.t-number .sort-icon {
      margin-left: 0.25rem;
    }
    td.t-number input[type='text'] {
      text-align: right;
    }
    /* Null / empty cell highlight — picks them out at a glance without
       shouting like full red. */
    td.is-null {
      background: #fef2f2;
    }
    td.is-null input[type='text'] {
      background: transparent;
    }
    td input[type='date'],
    td input[type='datetime-local'] {
      font: inherit;
      border: 0;
      background: transparent;
      padding: 0;
      width: 100%;
      box-sizing: border-box;
    }
    .mi.sm {
      font-size: 1rem;
    }
  `,
  ];

  @property({ type: String }) tableId = '';
  @state() private columns: ColumnSpec[] = [];
  @state() private rows: Row[] = [];
  @state() private sortColumn: string | null = null;
  @state() private sortDir: SortDir = null;
  @state() private filters: Record<string, string> = {};
  @state() private globalQuery = '';
  @state() private localQuery = '';
  @state() private dragSourceField: string | null = null;
  @state() private dropTargetField: string | null = null;
  @state() private dropEdge: 'before' | 'after' | null = null;
  @state() private resizing: { field: string; startX: number; startW: number } | null = null;
  private unsubscribe?: () => void;
  private filterSaveTimer: number | null = null;

  override async connectedCallback() {
    super.connectedCallback();
    document.addEventListener('easydb:global-search', this.onGlobalSearch as EventListener);
    document.addEventListener('easydb:table-search', this.onTableSearch as EventListener);
    await this.bind();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('easydb:global-search', this.onGlobalSearch as EventListener);
    document.removeEventListener('easydb:table-search', this.onTableSearch as EventListener);
    this.unsubscribe?.();
    this.tableSubUnsub?.();
  }

  private onGlobalSearch = (e: Event) => {
    this.globalQuery = (e as CustomEvent<{ query: string }>).detail.query ?? '';
  };

  private onTableSearch = (e: Event) => {
    const d = (e as CustomEvent<{ tableId: string; query: string }>).detail;
    if (d.tableId === this.tableId) this.localQuery = d.query ?? '';
  };

  override async updated(changed: Map<string, unknown>) {
    if (changed.has('tableId') && this.tableId) {
      this.unsubscribe?.();
      await this.bind();
    }
  }

  private tableSubUnsub?: () => void;

  private async bind() {
    if (!this.tableId) return;
    const ctx = await getContext();
    const table = await ctx.store.tables.findOne(this.tableId);
    if (!table) return;
    this.applyTable(table);
    // Re-bind columns/sort/filters whenever this table's record changes
    // (column editor, sort header click, filter input). Without this, the
    // data-table would only pick up its own writes — external updates
    // (e.g. column editor patching columns) wouldn't refresh until reload.
    this.tableSubUnsub?.();
    this.tableSubUnsub = ctx.store.tables.subscribe((all) => {
      const me = all.find((t) => t.id === this.tableId);
      if (me) this.applyTable(me);
    });
    const rowColl = ctx.store.rows(this.tableId);
    this.unsubscribe = rowColl.subscribe((r) => (this.rows = r));
    this.rows = await rowColl.find();
  }

  private applyTable(table: Table) {
    this.columns = table.columns;
    this.sortColumn = table.sortColumn ?? null;
    this.sortDir = table.sortColumn ? (table.sortAsc === false ? 'desc' : 'asc') : null;
    this.filters = { ...(table.filters ?? {}) };
  }


  private async editCell(row: Row, field: string, raw: string) {
    const ctx = await getContext();
    const col = this.columns.find((c) => c.field === field);
    const value = coerce(raw, col?.type ?? 'string');
    await this.commitCell(ctx, row, field, value);
  }

  private async setCell(row: Row, field: string, value: unknown) {
    const ctx = await getContext();
    await this.commitCell(ctx, row, field, value);
  }

  /**
   * Validate the proposed value against the column's constraints
   * (notnull, max, unique) before writing. On rejection: pop a dialog with
   * the reason and re-render so the cell input reverts to its prior value.
   */
  private async commitCell(
    ctx: import('../app-context.js').AppContext,
    row: Row,
    field: string,
    value: unknown,
  ) {
    const col = this.columns.find((c) => c.field === field);
    if (col) {
      const reason = validate(col, value, this.rows, row.id);
      if (reason) {
        await ctx.api.ui.dialogs.alert(reason, `Cannot save ${col.label}`);
        // Force re-render so the input snaps back to the stored value.
        this.requestUpdate();
        return;
      }
    }
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
      case 'date': {
        const iso = toDateIso(raw);
        return html`<input
          type="date"
          .value=${iso}
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
        />`;
      }
      case 'datetime': {
        const local = toDatetimeLocal(raw);
        return html`<input
          type="datetime-local"
          .value=${local}
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
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

  private filteredRows(): Row[] {
    const active = Object.entries(this.filters).filter(([, q]) => q && q.trim().length > 0);
    const gq = this.globalQuery.trim().toLowerCase();
    const lq = this.localQuery.trim().toLowerCase();
    if (active.length === 0 && gq.length === 0 && lq.length === 0) return this.rows;
    return this.rows.filter((r) => {
      const matchAny = (needle: string) =>
        Object.values(r.data).some((v) => v != null && String(v).toLowerCase().includes(needle));
      if (gq.length > 0 && !matchAny(gq)) return false;
      if (lq.length > 0 && !matchAny(lq)) return false;
      return active.every(([field, query]) =>
        String(r.data[field] ?? '')
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
    });
  }

  private sortedRows(): Row[] {
    const base = this.filteredRows();
    if (!this.sortColumn || !this.sortDir) return base;
    const field = this.sortColumn;
    const col = this.columns.find((c) => c.field === field);
    const type: ColumnType = col?.type ?? 'string';
    const factor = this.sortDir === 'asc' ? 1 : -1;
    const arr = [...base];
    arr.sort((a, b) => compareValues(a.data[field], b.data[field], type) * factor);
    return arr;
  }

  private onFilterInput(field: string, value: string) {
    this.filters = { ...this.filters, [field]: value };
    // Debounce persistence so we don't write to RxDB on every keystroke.
    if (this.filterSaveTimer != null) window.clearTimeout(this.filterSaveTimer);
    this.filterSaveTimer = window.setTimeout(() => this.saveFilters(), 250);
  }

  private get visibleColumns(): ColumnSpec[] {
    return this.columns.filter((c) => !c.hidden);
  }

  private onResizeStart(e: PointerEvent, field: string, th: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const startW = th.offsetWidth;
    this.resizing = { field, startX: e.clientX, startW };
    const onMove = (ev: PointerEvent) => {
      if (!this.resizing) return;
      const dx = ev.clientX - this.resizing.startX;
      const w = Math.max(40, this.resizing.startW + dx);
      // Live update: patch the in-memory column width so the colgroup reflows.
      this.columns = this.columns.map((c) =>
        c.field === this.resizing!.field ? { ...c, width: w } : c,
      );
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const fld = this.resizing?.field;
      this.resizing = null;
      if (!fld) return;
      const ctx = await getContext();
      await ctx.store.tables.patch(this.tableId, {
        columns: this.columns,
        updatedAt: Date.now(),
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private onColDragStart(e: DragEvent, field: string) {
    this.dragSourceField = field;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-easydb-col', field);
    }
  }

  private onColDragOver(e: DragEvent, field: string, th: HTMLElement) {
    if (!this.dragSourceField || this.dragSourceField === field) return;
    e.preventDefault();
    const rect = th.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    this.dropTargetField = field;
    this.dropEdge = before ? 'before' : 'after';
  }

  private onColDragLeave(field: string) {
    if (this.dropTargetField === field) {
      this.dropTargetField = null;
      this.dropEdge = null;
    }
  }

  private async onColDrop(e: DragEvent, targetField: string) {
    e.preventDefault();
    const src = this.dragSourceField;
    const edge = this.dropEdge;
    this.dragSourceField = null;
    this.dropTargetField = null;
    this.dropEdge = null;
    if (!src || src === targetField || !edge) return;

    const next = [...this.columns];
    const fromIdx = next.findIndex((c) => c.field === src);
    if (fromIdx < 0) return;
    const [moved] = next.splice(fromIdx, 1);
    let toIdx = next.findIndex((c) => c.field === targetField);
    if (toIdx < 0) {
      // Target was the same as the moved column — shouldn't happen but bail safely.
      next.splice(fromIdx, 0, moved!);
      return;
    }
    if (edge === 'after') toIdx += 1;
    next.splice(toIdx, 0, moved!);

    const ctx = await getContext();
    await ctx.store.tables.patch(this.tableId, {
      columns: next,
      updatedAt: Date.now(),
    });
  }

  private async saveFilters() {
    const ctx = await getContext();
    // Strip empty entries so the persisted shape stays tidy.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.filters)) if (v && v.trim().length > 0) cleaned[k] = v;
    const filters: Record<string, string> | undefined =
      Object.keys(cleaned).length === 0 ? undefined : cleaned;
    await ctx.store.tables.patch(this.tableId, { filters, updatedAt: Date.now() });
  }

  override render() {
    const rows = this.sortedRows();
    const cols = this.visibleColumns;
    return html`
      <table>
        <colgroup>
          ${cols.map(
            (c) =>
              html`<col style=${c.width != null ? `width: ${c.width}px` : ''} />`,
          )}
          <col style="width:2rem" />
        </colgroup>
        <thead>
          <tr>
            ${cols.map((c) => {
              const sorted = this.sortColumn === c.field && this.sortDir;
              const icon = sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '⇅';
              const typeClass = `t-${c.type}`;
              const isSrc = this.dragSourceField === c.field;
              const isTgt = this.dropTargetField === c.field;
              const edgeClass =
                isTgt && this.dropEdge === 'before'
                  ? ' drop-before'
                  : isTgt && this.dropEdge === 'after'
                    ? ' drop-after'
                    : '';
              return html`
                <th
                  class=${`${typeClass}${sorted ? ' sorted' : ''}${isSrc ? ' drag-source' : ''}${edgeClass}`}
                  title=${`${c.field} — click to sort, drag to reorder`}
                  draggable="true"
                  @click=${() => this.toggleSort(c.field)}
                  @dragstart=${(e: DragEvent) => this.onColDragStart(e, c.field)}
                  @dragover=${(e: DragEvent) =>
                    this.onColDragOver(e, c.field, e.currentTarget as HTMLElement)}
                  @dragleave=${() => this.onColDragLeave(c.field)}
                  @drop=${(e: DragEvent) => this.onColDrop(e, c.field)}
                  @dragend=${() => {
                    this.dragSourceField = null;
                    this.dropTargetField = null;
                    this.dropEdge = null;
                  }}
                >
                  ${c.label}<span class="sort-icon">${icon}</span>
                  <span
                    class="col-resize"
                    title="Drag to resize column"
                    @click=${(e: Event) => e.stopPropagation()}
                    @pointerdown=${(e: PointerEvent) =>
                      this.onResizeStart(e, c.field, (e.currentTarget as HTMLElement)
                        .parentElement as HTMLElement)}
                  ></span>
                </th>
              `;
            })}
            <th style="width:2rem"></th>
          </tr>
          <tr class="filter-row">
            ${cols.map(
              (c) => html`
                <th>
                  <input
                    type="text"
                    placeholder="filter…"
                    .value=${this.filters[c.field] ?? ''}
                    @input=${(e: Event) =>
                      this.onFilterInput(c.field, (e.target as HTMLInputElement).value)}
                  />
                </th>
              `,
            )}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`
              <tr>
                ${cols.map((c) => {
                  const nullClass = isNullish(r.data[c.field]) ? ' is-null' : '';
                  return html`<td class=${`t-${c.type}${nullClass}`}>${this.renderCell(r, c)}</td>`;
                })}
                <td>
                  <button class="danger" title="Delete row" @click=${() => this.deleteRow(r.id)}>
                    <span class="mi sm">close</span>
                  </button>
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim().length === 0);
}

/**
 * Coerce arbitrary stored values into the YYYY-MM-DD string that
 * <input type=date> expects. Returns '' if it can't parse — leaves the input
 * empty rather than showing a misleading "Invalid Date".
 */
function toDateIso(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Same idea for <input type=datetime-local> which wants YYYY-MM-DDTHH:MM
 * (no timezone). We strip seconds/timezone bits because the input ignores them.
 */
function toDatetimeLocal(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]}T${m[2]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  // toISOString in UTC; for "local" inputs we feed back something close enough.
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 16)}`;
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

/** Returns a human-readable rejection reason, or null if value is acceptable. */
function validate(col: ColumnSpec, value: unknown, allRows: Row[], rowId: string): string | null {
  if (col.notnull) {
    if (value === null || value === undefined) return `${col.label} cannot be empty.`;
    if (typeof value === 'string' && value.trim().length === 0) {
      return `${col.label} cannot be empty.`;
    }
  }
  if (col.max != null && col.max > 0) {
    if (typeof value === 'string' && value.length > col.max) {
      return `${col.label} must be at most ${col.max} characters (got ${value.length}).`;
    }
    if (typeof value === 'number' && value > col.max) {
      return `${col.label} must be at most ${col.max} (got ${value}).`;
    }
  }
  if (col.unique && value !== null && value !== undefined && value !== '') {
    const dup = allRows.find((r) => r.id !== rowId && r.data[col.field] === value);
    if (dup) return `${col.label} must be unique. Another row already has "${String(value)}".`;
  }
  return null;
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
