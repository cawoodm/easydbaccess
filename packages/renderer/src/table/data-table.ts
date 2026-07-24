import { LitElement, css, html, nothing } from 'lit';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType, Row, Table } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { FilterPopover } from '../chrome/filter-popover.js';
import '../chrome/filter-combobox.js';

type SortDir = 'asc' | 'desc' | null;

/** Delay before the header loading bar appears, so fast loads don't flash it. */
const LOAD_BAR_DELAY_MS = 200;

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
      /* Indeterminate loading bar, pinned to the top of the table's header while
       a (large / remote) table's rows are still loading. Sticky + high z-index
       so it rides above the sticky column headers (th z-index 1–2). */
      .load-bar {
        position: sticky;
        top: 0;
        left: 0;
        z-index: 3;
        height: 8px;
        background: #dbeafe;
        overflow: hidden;
      }
      .load-bar-fill {
        height: 100%;
        background: #2563eb;
      }
      /* Indeterminate: a moving sliver, shown before any progress is known. */
      .load-bar-fill:not(.determinate) {
        width: 40%;
        border-radius: 4px;
        animation: eda-load-bar 1.1s ease-in-out infinite;
      }
      /* Determinate: width tracks the actual fraction loaded (set inline). */
      .load-bar-fill.determinate {
        width: 0;
        transition: width 0.2s ease;
      }
      @keyframes eda-load-bar {
        0% {
          transform: translateX(-120%);
        }
        100% {
          transform: translateX(320%);
        }
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
      /* Link cells chop their display length. A ~40ch cap stops a long URL
         from blowing the column out to its full width; the anchor inside (a
         min-width:0 flex child with text-overflow:ellipsis) truncates to the
         cap — and shrinks *further*, to whatever the column actually offers,
         when it's narrower (many columns, a narrow panel, mobile). Pure CSS,
         re-flows live on resize; the full value stays in the title tooltip.
         A concrete cap (not max-width:0) is used so a lone link column can't
         collapse to zero width. */
      td.r-link {
        max-width: 40ch;
        overflow: hidden;
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
      th button.funnel {
        background: transparent;
        border: 0;
        cursor: pointer;
        color: #9ca3af;
        margin-left: 0.2rem;
        padding: 0;
        vertical-align: middle;
        line-height: 1;
      }
      th button.funnel.active {
        color: #2563eb;
      }
      th button.funnel:hover {
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
      td input[type='datetime-local'],
      td input[type='text'],
      td input[type='number'] {
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
  @state() private cellRenderers: Map<string, string> = new Map();
  @state() private scrollY = 0;
  @state() private viewportHeight = 0;
  /** Loading bar driven by this grid's own row fetch (see bind()). */
  @state() private loading = false;
  /**
   * Loading bar driven by an EXTERNAL producer (an import filling this table's
   * rows in the background) via the `easydb:table-loading` event, so the window
   * can show progress before its data exists.
   */
  @state() private externalLoading = false;
  /**
   * Fraction (0–1) of the external load completed, or null when unknown. When
   * a fraction is known the bar is determinate (width ∝ progress); otherwise it
   * runs the indeterminate animation.
   */
  @state() private externalProgress: number | null = null;
  /** Median row height in px, measured from currently-rendered rows. */
  private rowHeight = 28;
  private resizeObs: ResizeObserver | null = null;
  private unsubscribe?: () => void;
  private filterSaveTimer: number | null = null;
  /** Tables with fewer rows than this skip virtualization (cheap to render). */
  private readonly VIRT_THRESHOLD = 200;
  /** Extra rows rendered above/below the viewport to mask scroll jank. */
  private readonly OVERSCAN = 8;

  override async connectedCallback() {
    super.connectedCallback();
    document.addEventListener('easydb:global-search', this.onGlobalSearch as EventListener);
    document.addEventListener('easydb:table-search', this.onTableSearch as EventListener);
    document.addEventListener('easydb:table-loading', this.onTableLoading as EventListener);
    this.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObs = new ResizeObserver(() => {
      this.viewportHeight = this.clientHeight;
    });
    this.resizeObs.observe(this);
    await this.bind();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('easydb:global-search', this.onGlobalSearch as EventListener);
    document.removeEventListener('easydb:table-search', this.onTableSearch as EventListener);
    document.removeEventListener('easydb:table-loading', this.onTableLoading as EventListener);
    this.removeEventListener('scroll', this.onScroll);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.unsubscribe?.();
    this.tableSubUnsub?.();
  }

  private onScroll = () => {
    // :host has overflow:auto so the data-table element itself is the
    // scrolling container. Reading scrollTop off it triggers a @state-driven
    // re-render via the assignment.
    this.scrollY = (this as unknown as { scrollTop: number }).scrollTop;
  };

  private onGlobalSearch = (e: Event) => {
    this.globalQuery = (e as CustomEvent<{ query: string }>).detail.query ?? '';
  };

  private onTableSearch = (e: Event) => {
    const d = (e as CustomEvent<{ tableId: string; query: string }>).detail;
    if (d.tableId === this.tableId) this.localQuery = d.query ?? '';
  };

  private onTableLoading = (e: Event) => {
    const d = (e as CustomEvent<{ tableId: string; loading: boolean; progress?: number }>).detail;
    if (d.tableId !== this.tableId) return;
    this.externalLoading = d.loading;
    this.externalProgress = d.loading && typeof d.progress === 'number' ? d.progress : null;
  };

  override async updated(changed: Map<string, unknown>) {
    if (changed.has('tableId') && this.tableId) {
      this.unsubscribe?.();
      await this.bind();
    }
    // Re-measure row height once we have content. Reading offsetHeight forces
    // layout, so only do it when we actually need a number (still using the
    // 28px default) — measure once, keep using the median.
    const firstTr = this.shadowRoot?.querySelector('tbody tr:not(.spacer)') as HTMLElement | null;
    if (firstTr && firstTr.offsetHeight > 0) {
      this.rowHeight = firstTr.offsetHeight;
    }
    if (!this.viewportHeight) this.viewportHeight = this.clientHeight;
    this.markEmptyCells();
  }

  /**
   * Toggle `is-null` on each data cell based on its *rendered* content, not
   * the stored value. Runs after Lit has updated the DOM and each cell
   * renderer's `connectedCallback` has populated its custom element, so the
   * check sees what the user sees.
   */
  private markEmptyCells() {
    const tds = this.shadowRoot?.querySelectorAll<HTMLTableCellElement>(
      'tbody tr:not(.spacer) > td',
    );
    if (!tds) return;
    for (const td of tds) {
      // Trailing action <td> has no `t-*` class — skip it; it's the delete
      // button cell.
      if (!td.className.startsWith('t-')) continue;
      td.classList.toggle('is-null', isCellEmpty(td));
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
    // Snapshot the cell-renderer registry. Built-in renderer plugins
    // register during init/load(); we resnapshot on app:ready so anything
    // that registered late is picked up too.
    this.cellRenderers = new Map(ctx.registries.cellRenderers);
    ctx.events.on('app:ready', () => (this.cellRenderers = new Map(ctx.registries.cellRenderers)));
    const rowColl = ctx.store.rows(this.tableId);
    this.unsubscribe = rowColl.subscribe((r) => (this.rows = r));
    // Show a loading bar in the table header, but only if the fetch is slow
    // enough to matter (large local tables, remote sources) — fast local loads
    // resolve before the delay so the bar never flashes.
    const barTimer = window.setTimeout(() => (this.loading = true), LOAD_BAR_DELAY_MS);
    try {
      this.rows = await rowColl.find();
    } catch (err) {
      // A remote-backed table (e.g. a live Datasette source) can fail to load
      // its rows — a blocked cross-origin fetch, a bot challenge, an auth
      // error. Surface it instead of leaving a silently empty grid.
      this.rows = [];
      ctx.api.ui.dialogs.toast(`Couldn't load rows: ${(err as Error)?.message ?? String(err)}`, {
        kind: 'error',
        title: 'Load failed',
      });
    } finally {
      window.clearTimeout(barTimer);
      this.loading = false;
    }
  }

  private applyTable(table: Table) {
    this.columns = table.columns;
    this.sortColumn = table.sortColumn ?? null;
    this.sortDir = table.sortColumn ? (table.sortAsc === false ? 'desc' : 'asc') : null;
    this.filters = { ...(table.filters ?? {}) };
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
    try {
      await ctx.store.rows(this.tableId).patch(row.id, {
        data: { ...row.data, [field]: value },
        updatedAt: Date.now(),
      });
    } catch (err) {
      // Remote (e.g. Datasette) sources can reject a write — read-only table,
      // expired token, server error. Surface it and revert the cell instead of
      // leaving an unhandled rejection and a stale-looking value.
      await ctx.api.ui.dialogs.alert(
        (err as Error)?.message ?? 'Could not save the change.',
        'Save failed',
      );
      this.requestUpdate();
    }
  }

  private renderCell(row: Row, col: ColumnSpec) {
    const raw = row.data[col.field];
    // Cell rendering is dispatched by the column's `renderer` attribute, not
    // its data type. If a renderer is registered for the column's chosen
    // name we hand off to its custom element; otherwise the cell renders as
    // read-only HTML-encoded text. The standard renderers (date, datetime,
    // boolean) ship as the core-renderers built-in plugin; color/image/link
    // come from their respective plugins.
    const rendererName = col.renderer;
    const customTag = rendererName ? this.cellRenderers?.get(rendererName) : undefined;
    if (customTag) {
      // Use lit's static-html so the tag can be data-driven; the standard
      // html`` template doesn't allow dynamic tag names. unsafeStatic is the
      // correct primitive for tag names that come from a runtime registry —
      // the trade-off is that plugin authors can register an arbitrary tag
      // string, which is acceptable given the host trust model already lets
      // plugins do anything.
      const tag = unsafeStatic(customTag);
      // `.row` is the full row data object — most renderers ignore it; the
      // `script` renderer needs it so user-authored render(row) functions
      // can pull from neighbouring fields.
      return staticHtml`<${tag}
        .value=${raw ?? ''}
        .column=${col}
        .row=${row.data}
        @change=${(e: Event) =>
          this.setCell(row, col.field, (e as CustomEvent<{ value: unknown }>).detail.value)}
      ></${tag}>`;
    }
    // No renderer set or unknown name — fall back to a native editor chosen
    // by the column's data type. Renderers are a display concern; editing
    // works on any cell by default.
    switch (col.type) {
      case 'boolean': {
        const checked = raw === true || raw === 'true' || raw === 1 || raw === '1';
        return html`<input
          type="checkbox"
          .checked=${checked}
          @change=${(e: Event) =>
            this.setCell(row, col.field, (e.target as HTMLInputElement).checked)}
        />`;
      }
      case 'date':
        return html`<input
          type="date"
          .value=${toDateIso(raw)}
          @change=${(e: Event) =>
            this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
        />`;
      case 'datetime':
        return html`<input
          type="datetime-local"
          .value=${toDatetimeLocal(raw)}
          @change=${(e: Event) =>
            this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
        />`;
      case 'number':
        return html`<input
          type="number"
          .value=${raw == null ? '' : String(raw)}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.setCell(row, col.field, v === '' ? null : Number(v));
          }}
        />`;
      default:
        return html`<input
          type="text"
          .value=${String(raw ?? '')}
          @change=${(e: Event) =>
            this.setCell(row, col.field, (e.target as HTMLInputElement).value)}
        />`;
    }
  }

  private async deleteRow(rowId: string) {
    const ctx = await getContext();
    try {
      await ctx.store.rows(this.tableId).remove(rowId);
    } catch (err) {
      await ctx.api.ui.dialogs.alert(
        (err as Error)?.message ?? 'Could not delete the row.',
        'Delete failed',
      );
    }
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
    arr.sort((a, b) => {
      const av = a.data[field];
      const bv = b.data[field];
      // Emptiness is ranked as the *smallest* value: null < blank < present.
      // The rank rides the direction flip, so ascending floats empties to the
      // top (nulls first, then blanks) and descending sinks them to the bottom
      // (blanks, then nulls last). null and blank are DISTINCT — a null cell is
      // "no value" and sorts ahead of an empty-string cell.
      const rank = (v: unknown): number => (v == null ? 0 : v === '' ? 1 : 2);
      const ar = rank(av);
      const br = rank(bv);
      if (ar !== 2 || br !== 2) return (ar - br) * factor;
      return compareValues(av, bv, type) * factor;
    });
    return arr;
  }

  private async openFilterPicker(e: Event, field: string) {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const popover = FilterPopover.instance;
    if (!popover) return;
    // Faceted: count values only across rows that pass every OTHER column's
    // filter — so a column's own dropdown isn't pre-narrowed by what's
    // already typed in that column's filter, but other filters do narrow it.
    const counts = new Map<string, number>();
    for (const r of this.rowsFacetedFor(field)) {
      const v = r.data[field];
      if (v == null) continue;
      const s = String(v);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const result = await popover.open(
      btn.getBoundingClientRect(),
      values,
      this.filters[field] ?? '',
    );
    if (result === null) return;
    if (typeof result === 'object' && 'clear' in result) {
      this.onFilterInput(field, '');
    } else if (typeof result === 'string') {
      this.onFilterInput(field, result);
    }
  }

  private onFilterInput(field: string, value: string) {
    this.filters = { ...this.filters, [field]: value };
    // Debounce persistence so we don't write to IndexedDB on every keystroke.
    if (this.filterSaveTimer != null) window.clearTimeout(this.filterSaveTimer);
    this.filterSaveTimer = window.setTimeout(() => this.saveFilters(), 250);
  }

  private get visibleColumns(): ColumnSpec[] {
    return this.columns.filter((c) => !c.hidden);
  }

  /**
   * Faceted rows for a single column's filter dropdown: every row that
   * passes every OTHER column's filter, ignoring the focused column's own.
   * Matches the minniDBMax v1 _buildFilterOptionsArray behavior so dropdowns
   * support drill-down (pick Country=Sweden, then City dropdown narrows to
   * Swedish cities), while the Country dropdown itself still shows all
   * countries (because its own filter is excluded from the facet).
   *
   * Pass `null` to evaluate against ALL per-column filters.
   */
  private rowsFacetedFor(focusField: string | null): Row[] {
    const active = Object.entries(this.filters)
      .filter(([f, q]) => q && q.trim().length > 0 && f !== focusField)
      .map(([f, q]) => [f, q.trim().toLowerCase()] as const);
    if (active.length === 0) return this.rows;
    return this.rows.filter((r) =>
      active.every(([f, q]) =>
        String(r.data[f] ?? '')
          .toLowerCase()
          .includes(q),
      ),
    );
  }

  /**
   * Decide per-column whether to feed the <filter-combobox> a suggestion
   * list. Rule: every value in the first 100 rows must stringify to fewer
   * than 50 characters. Long-text or "description"-style columns are
   * excluded so the dropdown doesn't fill with multi-line content.
   *
   * Returns a Map from column field → sorted unique values (capped at 500).
   * The value list for each column is FACETED — it reflects only rows that
   * pass the OTHER columns' filters, so selecting a value in one column
   * narrows what's available in the others. Drill-down UX.
   */
  private computeFilterSuggestions(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const eligibilitySample = this.rows.slice(0, 100);
    if (eligibilitySample.length === 0) return out;
    const MAX_LEN = 50;
    const MAX_OPTIONS = 500;
    for (const c of this.visibleColumns) {
      let eligible = true;
      for (const r of eligibilitySample) {
        const v = r.data[c.field];
        if (v == null) continue;
        const s = typeof v === 'string' ? v : String(v);
        if (s.length >= MAX_LEN) {
          eligible = false;
          break;
        }
      }
      if (!eligible) continue;
      const seen = new Set<string>();
      // Faceted source: rows passing every other column's filter.
      for (const r of this.rowsFacetedFor(c.field)) {
        const v = r.data[c.field];
        if (v == null || v === '') continue;
        const s = typeof v === 'string' ? v : String(v);
        if (s.length >= MAX_LEN) continue;
        seen.add(s);
        if (seen.size >= MAX_OPTIONS) break;
      }
      out.set(c.field, [...seen].sort());
    }
    return out;
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

  /**
   * Decide whether to render every row or just the visible slice.
   * Returns the slice plus virtual padding heights for the rows skipped above
   * and below the viewport. For small tables it just returns the whole list.
   */
  private virtualSlice(rows: Row[]): { slice: Row[]; topPad: number; bottomPad: number } {
    if (rows.length <= this.VIRT_THRESHOLD || this.viewportHeight === 0) {
      return { slice: rows, topPad: 0, bottomPad: 0 };
    }
    const rh = this.rowHeight;
    const visibleRows = Math.ceil(this.viewportHeight / rh) + this.OVERSCAN * 2;
    const startIdx = Math.max(0, Math.floor(this.scrollY / rh) - this.OVERSCAN);
    const endIdx = Math.min(rows.length, startIdx + visibleRows);
    return {
      slice: rows.slice(startIdx, endIdx),
      topPad: startIdx * rh,
      bottomPad: (rows.length - endIdx) * rh,
    };
  }

  override render() {
    const rows = this.sortedRows();
    const cols = this.visibleColumns;
    const { slice, topPad, bottomPad } = this.virtualSlice(rows);
    const suggestions = this.computeFilterSuggestions();
    // Determinate only when an external producer reports a fraction; the
    // grid's own fetch has no incremental signal, so it stays indeterminate.
    const frac = this.externalLoading ? this.externalProgress : null;
    return html`
      ${this.loading || this.externalLoading
        ? html`<div
            class="load-bar"
            role="progressbar"
            aria-label="Loading rows"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${frac != null ? Math.round(frac * 100) : nothing}
          >
            <div
              class="load-bar-fill ${frac != null ? 'determinate' : ''}"
              style=${frac != null ? `width:${Math.max(2, Math.round(frac * 100))}%` : nothing}
            ></div>
          </div>`
        : nothing}
      <table>
        <colgroup>
          ${cols.map((c) => html`<col style=${c.width != null ? `width: ${c.width}px` : ''} />`)}
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
                  <button
                    class=${`funnel${this.filters[c.field] ? ' active' : ''}`}
                    title="Filter by value"
                    @click=${(e: Event) => this.openFilterPicker(e, c.field)}
                  >
                    <span class="mi sm">filter_list</span>
                  </button>
                  <span
                    class="col-resize"
                    title="Drag to resize column"
                    @click=${(e: Event) => e.stopPropagation()}
                    @pointerdown=${(e: PointerEvent) =>
                      this.onResizeStart(
                        e,
                        c.field,
                        (e.currentTarget as HTMLElement).parentElement as HTMLElement,
                      )}
                  ></span>
                </th>
              `;
            })}
            <th style="width:2rem"></th>
          </tr>
          <tr class="filter-row">
            ${cols.map((c) => {
              const opts = suggestions.get(c.field) ?? [];
              return html`
                <th>
                  <filter-combobox
                    .value=${this.filters[c.field] ?? ''}
                    .options=${opts}
                    placeholder="filter…"
                    @filter-change=${(e: Event) =>
                      this.onFilterInput(
                        c.field,
                        (e as CustomEvent<{ value: string }>).detail.value,
                      )}
                  ></filter-combobox>
                </th>
              `;
            })}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${topPad > 0
            ? html`<tr class="spacer" style=${`height:${topPad}px`}>
                <td colspan=${cols.length + 1}></td>
              </tr>`
            : ''}
          ${slice.map(
            (r) => html`
              <tr>
                ${cols.map(
                  (c) =>
                    html`<td class=${`t-${c.type}${c.renderer ? ` r-${c.renderer}` : ''}`}>
                      ${this.renderCell(r, c)}
                    </td>`,
                )}
                <td>
                  <button class="danger" title="Delete row" @click=${() => this.deleteRow(r.id)}>
                    <span class="mi sm">delete</span>
                  </button>
                </td>
              </tr>
            `,
          )}
          ${bottomPad > 0
            ? html`<tr class="spacer" style=${`height:${bottomPad}px`}>
                <td colspan=${cols.length + 1}></td>
              </tr>`
            : ''}
        </tbody>
      </table>
    `;
  }
}

/**
 * Visual-emptiness check for a rendered `<td>`. Used by `markEmptyCells` to
 * decide whether to apply the `is-null` highlight. A cell is empty iff it
 * shows no text, no image, and every input it contains is empty (checkboxes
 * excluded — they're meaningful in both states).
 */
function isCellEmpty(td: Element): boolean {
  if ((td.textContent ?? '').trim() !== '') return false;
  if (td.querySelector('img')) return false;
  const inputs = td.querySelectorAll('input');
  for (const inp of Array.from(inputs)) {
    if (inp.type === 'checkbox') return false;
    if (inp.value !== '') return false;
  }
  return true;
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

function toDateIso(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function toDatetimeLocal(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw).trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]}T${m[2]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 16)}`;
}

// Compares two PRESENT (non-empty) values by column type. Empty handling is
// the caller's job — `sortedRows` sinks blanks to the bottom regardless of
// sort direction, before this runs.
function compareValues(a: unknown, b: unknown, type: ColumnType): number {
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

/**
 * Toggle the progress bar on the window for `tableId` from outside the grid.
 * An importer shows the window (an empty table record) immediately, calls this
 * with `true`, fetches rows in the background, then calls it with `false` once
 * the rows have landed — so the user sees the window + a progress bar before
 * any data arrives.
 */
export function setTableLoading(tableId: string, loading: boolean, progress?: number): void {
  document.dispatchEvent(
    new CustomEvent('easydb:table-loading', { detail: { tableId, loading, progress } }),
  );
}

declare global {
  interface HTMLElementTagNameMap {
    'data-table': DataTable;
  }
}
