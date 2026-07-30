import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { ColumnSpec, Row, ViewInstance, ViewTemplate } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { openViewsDialog } from '../dialogs/views-dialog.js';
import { hasRowHtml, substituteRow, viewRows } from './view-render.js';
import { searchRowsByField } from '../search/text-search.js';
import { emitVisibleCount } from '../window-mgr/panel-title.js';
// Side-effect import: the template-off mode renders the standard interactive
// grid, bound to this view instance for its presentation state.
import '../table/data-table.js';

/**
 * Render of a single {@link ViewInstance}. Two modes, toggled by the table icon
 * in the footer (bottom-right):
 *
 *  - Template ON (default): the data is shown through the instance's
 *    {@link ViewTemplate} (read-only cards / custom HTML, or the fallback table).
 *  - Template OFF: the data is shown in the standard interactive `<data-table>`
 *    grid — sort, filter, show/hide and reorder columns — with those
 *    presentation choices stored on THIS view instance, not the underlying
 *    table. DB-level column definitions (uniqueness, nulls, defaults, max) are
 *    never edited from a view.
 *
 * Template HTML is injected verbatim (via `unsafeHTML`) into this component's
 * shadow root, so a template's inline styles scope here without leaking out.
 */
@customElement('view-window')
export class ViewWindow extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #f8fafc;
        font-family: system-ui, sans-serif;
      }
      .vw-body {
        flex: 1;
        min-height: 0;
      }
      .vw-body.scroll {
        overflow: auto;
      }
      /* Grid mode: let the data-table fill the body and scroll internally. */
      .vw-body.grid {
        display: flex;
      }
      .vw-body.grid data-table {
        flex: 1;
        min-height: 0;
        max-height: none;
      }
      .vw-root {
        min-height: 100%;
      }
      .vw-loading,
      .vw-empty {
        padding: 1rem;
        color: #6b7280;
        font-size: 0.9rem;
      }
      /* Fallback read-only table (used when a template has no row HTML). */
      table.vw-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      table.vw-table th,
      table.vw-table td {
        border: 1px solid #e5e7eb;
        padding: 0.25rem 0.5rem;
        text-align: left;
        vertical-align: top;
        white-space: nowrap;
        /* Clip a long value to the column instead of stretching the table past
           the window; the cell's title attribute carries the whole thing.
           Matches the grid (data-table). */
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 40ch;
      }
      table.vw-table th {
        background: #f9fafb;
        position: sticky;
        top: 0;
      }
      .vw-html {
        padding: 0.5rem 0.75rem;
      }
      /* Editable $input.TOKEN controls injected into a template's row HTML. */
      .eda-input-field {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        cursor: pointer;
        font-size: 0.82rem;
        color: #374151;
      }
      .eda-input-field input[disabled] {
        cursor: not-allowed;
      }
      .eda-input-field .eda-input-label:empty {
        display: none;
      }
      /* Sort toolbar pinned to the top of a template view. */
      .vw-sortbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.3rem 0.5rem;
        border-bottom: 1px solid #e5e7eb;
        background: #ffffff;
        font-size: 0.82rem;
        color: #6b7280;
      }
      .vw-sortbar select {
        font: inherit;
        padding: 0.15rem 0.3rem;
        border: 1px solid #d1d5db;
        border-radius: 0.25rem;
        background: white;
        color: #374151;
      }
      .vw-sortbar button {
        display: inline-flex;
        align-items: center;
        padding: 0.15rem 0.3rem;
        border: 1px solid #d1d5db;
        background: white;
        border-radius: 0.25rem;
        cursor: pointer;
        color: #374151;
      }
      .vw-sortbar button:hover {
        background: #f3f4f6;
      }
      .vw-sortbar button[disabled] {
        opacity: 0.5;
        cursor: default;
      }
      .vw-sortbar .mi {
        font-size: 1.05rem;
      }
      /* Footer toolbar: the template on/off toggle sits at the bottom-right. */
      .vw-footer {
        flex: 0 0 auto;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.35rem;
        padding: 0.25rem 0.4rem;
        border-top: 1px solid #e5e7eb;
        background: #ffffff;
      }
      .vw-footer button {
        font: inherit;
        display: inline-flex;
        align-items: center;
        padding: 0.2rem 0.4rem;
        border: 1px solid #d1d5db;
        background: white;
        border-radius: 0.25rem;
        cursor: pointer;
        color: #374151;
      }
      .vw-footer button:hover {
        background: #f3f4f6;
      }
      /* Same dark red as the delete-table trash icon (panel-footer). */
      .vw-footer button.danger {
        color: #b91c1c;
      }
      /* Active = template is OFF (showing the raw table). */
      .vw-footer button.active {
        background: #0891b2;
        border-color: #0891b2;
        color: white;
      }
      .vw-footer .mi {
        font-size: 1.05rem;
      }
      .cols-menu {
        position: absolute;
        right: 0.4rem;
        bottom: 100%;
        margin-bottom: 0.25rem;
        max-height: 40vh;
        overflow: auto;
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 0.35rem;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
        padding: 0.3rem;
        z-index: 5;
        min-width: 10rem;
      }
      .cols-menu label {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.2rem 0.3rem;
        font-size: 0.82rem;
        color: #374151;
        white-space: nowrap;
        cursor: pointer;
      }
      .cols-menu label:hover {
        background: #f3f4f6;
        border-radius: 0.2rem;
      }
    `,
  ];

  @property({ type: String }) viewInstanceId = '';
  @state() private loaded = false;
  @state() private error = '';
  @state() private instance: ViewInstance | null = null;
  @state() private template: ViewTemplate | null = null;
  @state() private columns: ColumnSpec[] = [];
  /** The underlying table's full column list — powers the show/hide menu. */
  @state() private tableColumns: ColumnSpec[] = [];
  @state() private rows: Row[] = [];
  @state() private showColsMenu = false;
  private allRows: Row[] = [];
  private rowsUnsub?: () => void;
  private instUnsub?: () => void;
  /** Free-text search from this view's own header search box. */
  @state() private searchQuery = '';
  /** The app-wide global search (header search bar), applied to every window. */
  @state() private globalQuery = '';

  /** Template rendering is on unless the instance explicitly disabled it. */
  private get templateOn(): boolean {
    return this.instance?.templateEnabled !== false;
  }

  override async connectedCallback() {
    super.connectedCallback();
    document.addEventListener('easydb:table-search', this.onSearch as EventListener);
    document.addEventListener('easydb:global-search', this.onGlobalSearch as EventListener);
    await this.load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('easydb:table-search', this.onSearch as EventListener);
    document.removeEventListener('easydb:global-search', this.onGlobalSearch as EventListener);
    this.rowsUnsub?.();
    this.instUnsub?.();
  }

  // The header search box is keyed by the view instance id (not the underlying
  // table id), so a view's search stays independent of the table window's.
  private onSearch = (e: Event) => {
    const d = (e as CustomEvent<{ tableId: string; query: string }>).detail;
    if (d.tableId === this.viewInstanceId) {
      this.searchQuery = d.query ?? '';
      this.recompute();
    }
  };

  // The app-wide global search applies to every open window, including views —
  // combined with (respecting) the view's own search below.
  private onGlobalSearch = (e: Event) => {
    this.globalQuery = (e as CustomEvent<{ query: string }>).detail.query ?? '';
    this.recompute();
  };

  override async updated(changed: Map<string, unknown>) {
    if (changed.has('viewInstanceId')) {
      this.rowsUnsub?.();
      this.loaded = false;
      await this.load();
    }
  }

  /** Re-read the instance/template/columns/rows — e.g. after the instance is
   * edited (rename / re-mapping) — without tearing down the window. */
  async reload() {
    this.rowsUnsub?.();
    this.loaded = false;
    await this.load();
  }

  private async load() {
    if (!this.viewInstanceId) return;
    this.rowsUnsub?.();
    this.instUnsub?.();
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) {
      this.error = 'This view no longer exists.';
      this.loaded = true;
      return;
    }
    this.instance = inst;
    this.template = (await ctx.store.viewTemplates.findOne(inst.templateId)) ?? null;
    const table = await ctx.store.tables.findOne(inst.tableId);
    this.tableColumns = table?.columns ?? [];
    // Keep the table-name snapshot current while the table exists, so the
    // reconnect-by-name path (view-window-manager) has an up-to-date value to
    // match against after a delete + recreate.
    if (table && inst.tableName !== table.name) {
      void ctx.store.viewInstances.patch(inst.id, { tableName: table.name });
    }
    const byField = new Map(this.tableColumns.map((c) => [c.field, c]));
    this.columns = inst.visibleColumns.map(
      (f) => byField.get(f) ?? { field: f, label: f, type: 'string' as const },
    );
    // Track instance changes so filters / sort the grid persists (template-off
    // mode) flow straight into the template render — toggling back shows the
    // same rows the user just filtered.
    this.instUnsub = ctx.store.viewInstances.subscribe((all) => {
      const me = all.find((v) => v.id === this.viewInstanceId);
      if (!me) return;
      if (me.tableId !== this.instance?.tableId) {
        // The view was rebound to a different table (reconnect-by-name after a
        // delete + recreate). Re-read so the rows subscription re-binds to the
        // new table id.
        this.instance = me;
        void this.reload();
        return;
      }
      this.instance = me;
      this.recompute();
    });
    const coll = ctx.store.rows(inst.tableId);
    this.rowsUnsub = coll.subscribe((all) => {
      this.allRows = all;
      this.recompute();
    });
    this.allRows = await coll.find();
    this.recompute();
    this.loaded = true;
  }

  private recompute() {
    if (!this.instance) return;
    let rows = viewRows(this.allRows, this.instance);
    // Free-text search across field values — supports `field:value` (with
    // !/^/comma-OR/NULL), boolean AND/OR, and the phrase→AND→OR fallback,
    // matching the table window. The view's own search AND the app-wide global
    // search both apply (each narrows the set), so global search respects the
    // view's search. Field names resolve against the underlying table's columns.
    const local = this.searchQuery.trim();
    const global = this.globalQuery.trim();
    if (local) rows = searchRowsByField(rows, local, this.tableColumns);
    if (global) rows = searchRowsByField(rows, global, this.tableColumns);
    const lim = this.instance.limit ?? 0;
    if (lim > 0 && rows.length > lim) rows = rows.slice(0, lim);
    this.rows = rows;
    // Template-ON: this component owns the visible set, so it reports the count
    // for the view window's title. Template-OFF renders <data-table>, which
    // emits its own count (keyed by the same view-instance id) — so we skip
    // here to avoid two producers fighting over the title.
    if (this.templateOn) emitVisibleCount(this.viewInstanceId, rows.length, this.allRows.length);
  }

  /**
   * Persist an edit made through an `$input.TOKEN` control in the template. The
   * write goes straight to the row's cell; the live-query subscription then
   * re-runs `recompute`, so the view refreshes and re-applies its filters — a
   * row edited out of the filter (e.g. a `read` checkbox filtered on `!true`)
   * simply disappears. No-ops for a readonly view (the inputs are disabled too).
   */
  private onInputChange = async (e: Event): Promise<void> => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains('eda-input')) return;
    if (!this.instance || this.instance.readonly === true) return;
    const rowId = t.getAttribute('data-eda-row');
    const field = t.getAttribute('data-eda-field');
    const type = t.getAttribute('data-eda-type') ?? 'string';
    if (!rowId || !field) return;
    const existing = this.allRows.find((r) => r.id === rowId);
    if (!existing) return;
    let value: unknown;
    if (type === 'boolean') {
      value = t.checked;
    } else if (type === 'number') {
      const n = Number(t.value);
      value = t.value.trim() === '' ? null : Number.isNaN(n) ? t.value : n;
    } else {
      value = t.value;
    }
    const ctx = await getContext();
    await ctx.store.rows(this.instance.tableId).patch(rowId, {
      data: { ...existing.data, [field]: value },
      updatedAt: Date.now(),
    });
  };

  // -- footer actions ---------------------------------------------------------

  /** Change the view's sort column (persisted on the instance). Empty ⇒ unsorted. */
  private async setSortColumn(field: string) {
    if (!this.instance) return;
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(this.instance.id, {
      sortColumn: field || undefined,
      updatedAt: Date.now(),
    });
    this.instance = { ...this.instance, sortColumn: field || undefined };
    this.recompute();
  }

  /** Flip the sort direction (persisted on the instance). No-op when unsorted. */
  private async toggleSortDir() {
    if (!this.instance?.sortColumn) return;
    const asc = !(this.instance.sortAsc ?? true);
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(this.instance.id, { sortAsc: asc, updatedAt: Date.now() });
    this.instance = { ...this.instance, sortAsc: asc };
    this.recompute();
  }

  /** Flip the template on/off for this view and persist it to the instance. */
  private async toggleTemplate() {
    if (!this.instance) return;
    const next = !this.templateOn; // true ⇒ turning template OFF
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(this.instance.id, {
      templateEnabled: next,
      updatedAt: Date.now(),
    });
    this.instance = { ...this.instance, templateEnabled: next };
    this.showColsMenu = false;
  }

  /** Open the Views manager straight into this view's template editor. */
  private editTemplate() {
    if (!this.instance || !this.template) return;
    openViewsDialog(this.instance.tableId, { editTemplateId: this.template.id });
  }

  /** Open the Views manager straight into this view instance's editor
   * (rename / re-map the template tokens to columns). */
  private editView() {
    if (!this.instance) return;
    openViewsDialog(this.instance.tableId, { editInstanceId: this.instance.id });
  }

  /** Delete this view instance after a confirm. No explicit window close: the
   * view-window manager drops the window when the instance leaves its
   * reconcile subscription (same path as the Views manager's Delete). */
  private async deleteView() {
    if (!this.instance) return;
    const ctx = await getContext();
    const ok = await ctx.api.ui.dialogs.confirm(
      `Delete the view "${this.instance.name}"? The table and its rows stay.`,
      'Delete view',
    );
    if (!ok) return;
    await ctx.store.viewInstances.remove(this.instance.id);
  }

  /** Show/hide a column in template-off mode (persisted on the instance). */
  private async toggleColumn(field: string) {
    if (!this.instance) return;
    const cur = this.instance.visibleColumns;
    const has = cur.includes(field);
    const next = has ? cur.filter((f) => f !== field) : [...cur, field];
    if (next.length === 0) return; // keep at least one column visible
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(this.instance.id, {
      visibleColumns: next,
      updatedAt: Date.now(),
    });
    this.instance = { ...this.instance, visibleColumns: next };
  }

  // -- render -----------------------------------------------------------------

  private renderTable() {
    if (this.rows.length === 0) return html`<div class="vw-empty">No rows.</div>`;
    return html`
      <table class="vw-table">
        <thead>
          <tr>
            ${this.columns.map((c) => html`<th>${c.label || c.field}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(
            (r) =>
              html`<tr>
                ${this.columns.map((c) => {
                  const v = r.data[c.field];
                  const text = v == null ? '' : String(v);
                  // Same deal as the grid: the cell clips to the column width,
                  // so the full value has to be reachable on hover.
                  return html`<td title=${text}>${text}</td>`;
                })}
              </tr>`,
          )}
        </tbody>
      </table>
    `;
  }

  /** Template-on rendering: the row-fragment view or the table fallback. */
  private renderTemplated() {
    const t = this.template;
    if (!t) return html`<div class="vw-empty">This view's template is missing.</div>`;
    if (hasRowHtml(t.rowHtml)) {
      // Row mode: concatenate header + repeated rows + footer into one HTML
      // block so a header that opens a wrapping tag pairs with the footer.
      const mapping = this.instance?.mapping ?? {};
      // Column specs (field → spec) drive how an $input.TOKEN renders (checkbox
      // for a boolean, number/text otherwise). A readonly view disables them.
      const colMap = new Map(this.tableColumns.map((c) => [c.field, c]));
      const readonly = this.instance?.readonly === true;
      const body = this.rows
        .map((r) => substituteRow(t.rowHtml, r, mapping, { columns: colMap, readonly }))
        .join('');
      const full = (t.headerHtml ?? '') + body + (t.footerHtml ?? '');
      return html`<div class="vw-root">${unsafeHTML(full)}</div>`;
    }
    // Table mode: header/footer HTML above and below a read-only table.
    return html`<div class="vw-root">
      ${t.headerHtml?.trim()
        ? html`<div class="vw-html">${unsafeHTML(t.headerHtml)}</div>`
        : nothing}
      ${this.renderTable()}
      ${t.footerHtml?.trim()
        ? html`<div class="vw-html">${unsafeHTML(t.footerHtml)}</div>`
        : nothing}
    </div>`;
  }

  /** Top toolbar (template mode): a sort-column dropdown + direction toggle. */
  private renderSortBar() {
    if (!this.instance) return nothing;
    // Offer every column the source lets us sort by (a provider can mark some
    // unsortable via `sortable: false`).
    const cols = this.tableColumns.filter((c) => c.sortable !== false);
    const cur = this.instance.sortColumn ?? '';
    const asc = this.instance.sortAsc ?? true;
    return html`<div class="vw-sortbar">
      <span class="mi" title="Sort">sort</span>
      <select
        aria-label="Sort by"
        @change=${(e: Event) => void this.setSortColumn((e.target as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${!cur}>— unsorted —</option>
        ${cols.map(
          (c) =>
            html`<option value=${c.field} ?selected=${cur === c.field}>${c.label || c.field}</option>`,
        )}
      </select>
      <button
        aria-label="Toggle sort direction"
        title=${asc ? 'Ascending (click for descending)' : 'Descending (click for ascending)'}
        ?disabled=${!cur}
        @click=${() => void this.toggleSortDir()}
      >
        <span class="mi">${asc ? 'arrow_upward' : 'arrow_downward'}</span>
      </button>
    </div>`;
  }

  private renderFooter() {
    if (!this.instance) return nothing;
    const on = this.templateOn;
    const visible = new Set(this.instance.visibleColumns);
    return html`<div class="vw-footer">
      ${!on && this.showColsMenu
        ? html`<div class="cols-menu">
            ${this.tableColumns.map(
              (c) =>
                html`<label
                  ><input
                    type="checkbox"
                    .checked=${visible.has(c.field)}
                    @change=${() => void this.toggleColumn(c.field)}
                  />${c.label || c.field}</label
                >`,
            )}
          </div>`
        : nothing}
      ${!on
        ? html`<button
            title="Show / hide columns"
            aria-label="Columns"
            @click=${() => (this.showColsMenu = !this.showColsMenu)}
          >
            <span class="mi">view_column</span>
          </button>`
        : nothing}
      <button
        aria-label="Edit view"
        title="Edit this view (rename, re-map columns)"
        @click=${() => this.editView()}
      >
        <span class="mi">edit</span>
      </button>
      ${this.template
        ? html`<button
            class="edit-template"
            aria-label="Edit template"
            title=${`Edit the "${this.template.name}" template`}
            @click=${() => this.editTemplate()}
          >
            <span class="mi">code</span>
          </button>`
        : nothing}
      <button
        class=${on ? '' : 'active'}
        title=${on ? 'Show as a table (turn the template off)' : 'Show through the template'}
        aria-label="Toggle template"
        aria-pressed=${on ? 'false' : 'true'}
        @click=${() => void this.toggleTemplate()}
      >
        <span class="mi">table_view</span>
      </button>
      <button
        class="danger"
        aria-label="Delete view"
        title="Delete this view (the table stays)"
        @click=${() => void this.deleteView()}
      >
        <span class="mi">delete</span>
      </button>
    </div>`;
  }

  override render() {
    if (!this.loaded)
      return html`<div class="vw-body scroll"><div class="vw-loading">Loading…</div></div>`;
    if (this.error)
      return html`<div class="vw-body scroll"><div class="vw-empty">${this.error}</div></div>`;

    const on = this.templateOn;
    const body = on
      ? html`<div class="vw-body scroll" @change=${this.onInputChange}>
          ${this.renderTemplated()}
        </div>`
      : html`<div class="vw-body grid">
          <data-table
            .tableId=${this.instance?.tableId ?? ''}
            .viewInstanceId=${this.viewInstanceId}
          ></data-table>
        </div>`;
    // The sort bar rides at the top in template mode; the grid (template-off)
    // has its own clickable column headers, so it isn't shown there.
    return html`${on ? this.renderSortBar() : nothing}${body}${this.renderFooter()}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'view-window': ViewWindow;
  }
}
