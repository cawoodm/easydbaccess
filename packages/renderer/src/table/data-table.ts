import { LitElement, css, html, nothing } from 'lit';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, ColumnType, Row, Table, ViewInstance } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { FilterPopover } from '../chrome/filter-popover.js';
import '../chrome/filter-combobox.js';
import { searchRows } from '../search/text-search.js';
import { matchesColumnFilter } from '../search/column-filter.js';
import { runColumnScript } from '../util/column-script.js';
import { emitVisibleCount } from '../window-mgr/panel-title.js';
import { INVALID_CLASS, INVALID_INPUT_STYLE } from '../util/cell-validity.js';

/** A row matches `needle` (lower-cased) when any of its field values contains it. */
function rowContains(r: Row, needle: string): boolean {
  return Object.values(r.data).some((v) => v != null && String(v).toLowerCase().includes(needle));
}

type SortDir = 'asc' | 'desc' | null;

/** Delay before the header loading bar appears, so fast loads don't flash it. */
const LOAD_BAR_DELAY_MS = 200;

/**
 * Narrowest a column may be dragged. Small enough to park a column you don't
 * want to read as a sliver, while still leaving a grab target for the resize
 * gutter (which is 6px wide) so the column can be dragged back open.
 */
const MIN_COL_W = 10;

/**
 * Width of the trailing action column (the row-delete button). A px value, not
 * `2rem`, so `tableSizingStyle` can add it to the exact column sum.
 */
const ACTION_COL_W = 32;

@customElement('data-table')
export class DataTable extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      :host {
        display: block;
        overflow: auto;
        /* Fill whatever box the host gives us and scroll inside it. This used to
           be a hard 60vh, which BEAT the height:100% the panel sets inline
           (max-height wins over height) — so a maximized window left a dead gap
           between the last row and the panel footer. 100% caps us at the parent
           when its height is definite (a jsPanel content box always is) and is
           ignored when it isn't, so a standalone mount still grows to its
           content. view-window.ts overrides this with max-height:none because
           it drives the height with flex instead. */
        max-height: 100%;
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
        /* min-width keeps a narrow table filling the panel; max-content lets a
           wide one grow past it (the host scrolls). Under table-layout:fixed
           (set inline once a column is resized) the sum of the <col> widths is
           authoritative, which is what makes per-column resize actually stick —
           auto layout silently ignores <col> widths on content-heavy tables. */
        width: max-content;
        min-width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }
      th,
      td {
        border: 1px solid #e5e7eb;
        padding: 0.25rem 0.5rem;
        text-align: left;
        vertical-align: top;
        /* A narrow column must CHOP its content, not spill it over the next
           column and not wrap into a taller row. One line + ellipsis also keeps
           every row the same height, which the row virtualization assumes when
           it converts scrollTop into a row index. */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
      /* Header cell layout: grip on the left, label taking the free space, then
         the sort + filter icons pinned to the right edge of the column. The
         flex lives on an inner wrapper — display:flex on the th itself would
         drop it out of table-cell layout and the columns would stack. */
      th .col-head {
        display: flex;
        align-items: center;
        gap: 0.15rem;
      }
      th .col-head .col-label {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
      th .col-units {
        color: #9ca3af;
        font-weight: 400;
      }
      /* A column outside the source's sortable-columns allowlist. */
      th.no-sort {
        cursor: default;
      }
      /* Only this small grip drags-to-reorder — NOT the whole th. A draggable
         th would (a) make the entire cell a grab surface that swallows the sort
         click and (b) start a native HTML5 drag on the resize gutter, which
         hijacks the pointer and breaks column resizing. */
      th .col-grip {
        cursor: grab;
        color: #cbd5e1;
        vertical-align: middle;
        margin-right: 0.15rem;
        line-height: 1;
      }
      th .col-grip:hover {
        color: #6b7280;
      }
      th .col-grip:active {
        cursor: grabbing;
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
      /* Number CELLS are right-aligned so digits line up; the HEADER stays
         left-aligned like every other column header. */
      td.t-number {
        text-align: right;
      }
      td.t-number input[type='text'] {
        text-align: right;
      }
      /* A column script that failed to compile or threw. Kept small and inline
         so one broken script does not disturb the rest of the row; the full
         message is the element's title. */
      .script-err {
        color: #b91c1c;
        font-size: 0.8em;
        font-family: ui-monospace, SFMono-Regular, monospace;
        cursor: help;
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
        /* An editable cell is an <input>, which clips its value flat — the td's
           own text-overflow can't reach inside it. Inputs honor text-overflow
           themselves while unfocused, so a narrow column ellipses its text and
           still reveals the whole value once you click into it. */
        text-overflow: ellipsis;
      }
      .mi.sm {
        font-size: 1rem;
      }
    `,
  ];

  @property({ type: String }) tableId = '';
  /**
   * When set, the grid is "view-bound": its rows and column *definitions* still
   * come from `tableId`, but the presentation (which columns show, their order,
   * widths, the sort and the filters) is read from and PERSISTED TO this
   * `ViewInstance` — not the underlying table. Empty ⇒ normal table binding.
   */
  @property({ type: String }) viewInstanceId = '';
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
  /** View-bound mode: the instance + the table's column definitions. */
  private viewInst: ViewInstance | null = null;
  private tableColumns: ColumnSpec[] = [];
  private viewSubUnsub?: () => void;

  private get viewMode(): boolean {
    return !!this.viewInstanceId;
  }
  /** A view whose instance opted into read-only: show values, offer no editors. */
  private get readOnlyView(): boolean {
    return this.viewMode && !!this.viewInst?.readonly;
  }
  /** Visible-row count from the last render, emitted for the panel title. */
  private renderedCount = 0;
  private lastEmittedCount = -1;
  private lastEmittedTotal = -1;
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
    this.viewSubUnsub?.();
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
    // In view-bound mode the header search box is keyed by the VIEW instance id,
    // so match either — the underlying table id or the view instance id.
    if (d.tableId === this.tableId || (this.viewMode && d.tableId === this.viewInstanceId)) {
      this.localQuery = d.query ?? '';
    }
  };

  private onTableLoading = (e: Event) => {
    const d = (e as CustomEvent<{ tableId: string; loading: boolean; progress?: number }>).detail;
    if (d.tableId !== this.tableId) return;
    this.externalLoading = d.loading;
    this.externalProgress = d.loading && typeof d.progress === 'number' ? d.progress : null;
  };

  override async updated(changed: Map<string, unknown>) {
    if ((changed.has('tableId') || changed.has('viewInstanceId')) && this.tableId) {
      this.unsubscribe?.();
      this.tableSubUnsub?.();
      this.viewSubUnsub?.();
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
    this.emitCount();
  }

  /**
   * Emit the visible/total row count for the panel title. Keyed by the view
   * instance id in view-bound mode (so the view window's title updates) and by
   * the table id otherwise (the table window's title). Only fires on a change.
   */
  private emitCount(): void {
    const key = this.viewMode ? this.viewInstanceId : this.tableId;
    if (!key) return;
    const count = this.renderedCount;
    const total = this.rows.length;
    if (count === this.lastEmittedCount && total === this.lastEmittedTotal) return;
    this.lastEmittedCount = count;
    this.lastEmittedTotal = total;
    emitVisibleCount(key, count, total);
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

    if (this.viewMode) {
      // View-bound: column DEFINITIONS come from the table (kept fresh), while
      // the presentation (order / visibility / widths / sort / filters) comes
      // from — and is persisted to — the view instance.
      this.tableColumns = table.columns;
      this.viewInst = (await ctx.store.viewInstances.findOne(this.viewInstanceId)) ?? null;
      this.applyView();
      this.tableSubUnsub?.();
      this.tableSubUnsub = ctx.store.tables.subscribe((all) => {
        const me = all.find((t) => t.id === this.tableId);
        if (me) {
          this.tableColumns = me.columns;
          this.applyView();
        }
      });
      this.viewSubUnsub?.();
      this.viewSubUnsub = ctx.store.viewInstances.subscribe((all) => {
        const me = all.find((v) => v.id === this.viewInstanceId);
        if (me) {
          this.viewInst = me;
          this.applyView();
        }
      });
    } else {
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
    }
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
    // Don't stomp on filters the user is mid-editing (a debounced save is
    // pending) with the older store value — that reverts the just-typed filter.
    if (this.filterSaveTimer == null) this.filters = { ...(table.filters ?? {}) };
  }

  /**
   * View-bound presentation: the effective columns are the instance's
   * `visibleColumns` (in that order) resolved against the table's definitions,
   * with per-column widths overlaid from the instance. Sort and filters come
   * from the instance too. A column dropped from the table is skipped.
   */
  private applyView() {
    const inst = this.viewInst;
    if (!inst) return;
    const byField = new Map(this.tableColumns.map((c) => [c.field, c]));
    const widths = inst.columnWidths ?? {};
    this.columns = inst.visibleColumns
      .map((f) => byField.get(f))
      .filter((c): c is ColumnSpec => !!c)
      .map((c) => {
        const w = widths[c.field];
        return typeof w === 'number' ? { ...c, width: w } : c;
      });
    this.sortColumn = inst.sortColumn ?? null;
    this.sortDir = inst.sortColumn ? (inst.sortAsc === false ? 'desc' : 'asc') : null;
    // See applyTable: never revert a filter the user is mid-editing (pending
    // debounced save) to the older instance value.
    if (this.filterSaveTimer == null) this.filters = { ...(inst.filters ?? {}) };
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

  /**
   * Escape-to-cancel: revert the editor's displayed value/checked state back
   * to the original stored value, then blur so the subsequent blur sees no
   * change and the existing `@change` commit path stays untouched — nothing
   * is written. `stopPropagation` keeps the keypress from reaching the panel
   * titlebar/search handlers.
   */
  private cancelCellEdit(e: KeyboardEvent, original: string | boolean) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    const el = e.target as HTMLInputElement;
    if (typeof original === 'boolean') el.checked = original;
    else el.value = original;
    el.blur();
  }

  /**
   * A non-empty value that doesn't fit the column's data type (unparseable
   * date/datetime, non-numeric number). Rather than silently blanking or
   * coercing it, show the raw value in a plain text input marked invalid
   * (red border, `title` naming the problem) — still visible, still fixable
   * on the very next `change`, which re-validates and switches back to the
   * type-specific input once the value parses.
   */
  private renderInvalidCell(row: Row, col: ColumnSpec, raw: unknown, reason: string) {
    const text = String(raw);
    return html`<input
      type="text"
      class=${INVALID_CLASS}
      style=${INVALID_INPUT_STYLE}
      title=${reason}
      .value=${text}
      @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, text)}
      @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value)}
    />`;
  }

  /** Plain-text (non-editable) rendering of a cell for read-only view mode. */
  private renderReadonlyCell(col: ColumnSpec, raw: unknown) {
    if (col.type === 'boolean') {
      const checked = raw === true || raw === 'true' || raw === 1 || raw === '1';
      return html`<input type="checkbox" .checked=${checked} disabled />`;
    }
    if (raw == null || raw === '') return html``;
    if (col.type === 'date') return html`${toDateIso(raw)}`;
    if (col.type === 'datetime') return html`${toDatetimeLocal(raw).replace('T', ' ')}`;
    return html`${String(raw)}`;
  }

  /**
   * A cell whose column carries a script: the script's return value is what the
   * renderer receives. The result is derived from the row, so it is always
   * read-only — there is nowhere to write an edit back to. A failing script
   * shows an inline chip (title = the message) instead of taking the table down.
   */
  private renderScriptedCell(row: Row, col: ColumnSpec) {
    const run = runColumnScript(col.script, row.data);
    if (!run.ok) {
      return html`<span class="script-err" title=${run.message}>⚠ ${run.label}</span>`;
    }
    const customTag = col.renderer ? this.cellRenderers?.get(col.renderer) : undefined;
    if (!customTag) {
      // No renderer (or an unknown name): show the computed value as text.
      return html`${run.value == null ? '' : String(run.value)}`;
    }
    const tag = unsafeStatic(customTag);
    return staticHtml`<${tag}
      .value=${run.value ?? ''}
      .column=${col}
      .row=${row.data}
      .readonly=${true}
    ></${tag}>`;
  }

  private renderCell(row: Row, col: ColumnSpec) {
    const raw = row.data[col.field];
    // A column can carry a `script` whose `render(row)` output REPLACES the
    // stored value on the way into the renderer — so any renderer (link, image,
    // html, boolean…) can display something computed from the whole row. The
    // `script` renderer is excluded: it runs the script itself and injects the
    // result as HTML, and its `.value` stays the stored value so its pencil
    // still edits the real cell.
    if (col.script?.trim() && col.renderer !== 'script') {
      return this.renderScriptedCell(row, col);
    }
    // Cell rendering is dispatched by the column's `renderer` attribute, not
    // its data type. If a renderer is registered for the column's chosen
    // name we hand off to its custom element; otherwise the cell falls back to
    // a plain editable input on the raw value (see the switch below — only a
    // read-only view renders text). The standard renderers (date, datetime,
    // boolean, script) each ship as their own built-in plugin
    // (`cell-date`/`cell-datetime`/`cell-boolean`/`cell-script`);
    // color/image/link come from their respective plugins.
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
      // can pull from neighbouring fields. `.readonly` tells editor renderers
      // (date/datetime/boolean) to display, not edit, in a read-only view;
      // display-only renderers (link/image/html/…) just ignore it.
      return staticHtml`<${tag}
        .value=${raw ?? ''}
        .column=${col}
        .row=${row.data}
        .readonly=${this.readOnlyView}
        @change=${(e: Event) =>
          this.setCell(row, col.field, (e as CustomEvent<{ value: unknown }>).detail.value)}
      ></${tag}>`;
    }
    // A read-only view never offers an editor: show the value as plain text
    // (dates/booleans formatted) instead of the native <input>.
    if (this.readOnlyView) {
      return this.renderReadonlyCell(col, raw);
    }
    // No renderer set or unknown name — fall back to a native editor. Most
    // types get one chosen by the column's data type; `boolean` deliberately
    // has no case here and falls through to `default:` (a plain text input on
    // the raw stored value) — a checkbox can't distinguish false/null/''/0/a
    // junk string, so it would silently coerce and invite an accidental
    // write. A user who wants a checkbox opts in via the `boolean` renderer
    // (the `cell-boolean` plugin). Renderers are a display concern; editing
    // works on any cell by default.
    switch (col.type) {
      case 'date':
        // A non-empty value the date input can't parse would otherwise render
        // as a misleadingly empty box. Show it raw and fixable instead.
        if (isNonEmptyButUnparsed(raw, toDateIso(raw))) {
          return this.renderInvalidCell(row, col, raw, `Not a valid date: "${String(raw)}"`);
        }
        return html`<input
          type="date"
          .value=${toDateIso(raw)}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, toDateIso(raw))}
          @change=${(e: Event) =>
            this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
        />`;
      case 'datetime':
        if (isNonEmptyButUnparsed(raw, toDatetimeLocal(raw))) {
          return this.renderInvalidCell(row, col, raw, `Not a valid datetime: "${String(raw)}"`);
        }
        return html`<input
          type="datetime-local"
          .value=${toDatetimeLocal(raw)}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, toDatetimeLocal(raw))}
          @change=${(e: Event) =>
            this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
        />`;
      case 'number': {
        const isEmpty = raw == null || raw === '';
        if (!isEmpty && Number.isNaN(Number(raw))) {
          return this.renderInvalidCell(row, col, raw, `Not a valid number: "${String(raw)}"`);
        }
        return html`<input
          type="number"
          .value=${isEmpty ? '' : String(raw)}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, isEmpty ? '' : String(raw))}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            this.setCell(row, col.field, v === '' ? null : Number(v));
          }}
        />`;
      }
      default:
        return html`<input
          type="text"
          .value=${String(raw ?? '')}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, String(raw ?? ''))}
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
    const patch = nextDir
      ? { sortColumn: field, sortAsc: nextDir === 'asc', updatedAt: Date.now() }
      : { sortColumn: undefined, sortAsc: undefined, updatedAt: Date.now() };
    if (this.viewMode) await ctx.store.viewInstances.patch(this.viewInstanceId, patch);
    else await ctx.store.tables.patch(this.tableId, patch);
  }

  private filteredRows(): Row[] {
    const active = Object.entries(this.filters).filter(([, q]) => q && q.trim().length > 0);
    const gq = this.globalQuery.trim();
    const lq = this.localQuery.trim();
    if (active.length === 0 && gq.length === 0 && lq.length === 0) return this.rows;
    // Per-column filters first (per-row substring), then the free-text searches.
    let rows = this.rows;
    if (active.length > 0) {
      rows = rows.filter((r) =>
        active.every(([field, query]) => matchesColumnFilter(r.data[field], query)),
      );
    }
    // Free-text search supports boolean AND/OR and the phrase→AND→OR fallback.
    // Local and global queries each narrow the set independently.
    if (lq) rows = searchRows(rows, lq, rowContains);
    if (gq) rows = searchRows(rows, gq, rowContains);
    return rows;
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
    let blanks = 0;
    for (const r of this.rowsFacetedFor(field)) {
      const v = r.data[field];
      // Null / empty / whitespace cells collapse into the single "(Blanks)" entry.
      if (v == null || String(v).trim() === '') {
        blanks++;
        continue;
      }
      const s = String(v);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    // Toggles apply live while the popover stays open (multi-value tri-state);
    // the promise only reports dismissal or an explicit Clear.
    const result = await popover.open(
      btn.getBoundingClientRect(),
      values,
      this.filters[field] ?? '',
      blanks,
      (next) => this.onFilterInput(field, next),
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
    // The timer doubles as a "save pending" flag (see applyTable/applyView): a
    // store emission that lands during the debounce must NOT reset the filters
    // the user just typed back to the not-yet-saved store value.
    if (this.filterSaveTimer != null) window.clearTimeout(this.filterSaveTimer);
    this.filterSaveTimer = window.setTimeout(() => {
      this.filterSaveTimer = null;
      void this.saveFilters();
    }, 250);
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
    const active = Object.entries(this.filters).filter(
      ([f, q]) => q && q.trim().length > 0 && f !== focusField,
    );
    if (active.length === 0) return this.rows;
    return this.rows.filter((r) => active.every(([f, q]) => matchesColumnFilter(r.data[f], q)));
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

  /**
   * Snapshot the current on-screen width of every visible column into
   * `this.columns`, so the table can flip to `table-layout: fixed` and honour
   * per-column resizing exactly. A no-op for columns that already have a width.
   */
  private freezeColumnWidths() {
    const headerRow = this.renderRoot.querySelector('thead tr');
    if (!headerRow) return;
    const cells = Array.from(headerRow.querySelectorAll(':scope > th'));
    const vis = this.visibleColumns;
    const measured = new Map<string, number>();
    vis.forEach((c, i) => {
      if (c.width != null) return; // keep an already-set width
      const cell = cells[i] as HTMLElement | undefined;
      if (cell) measured.set(c.field, Math.round(cell.getBoundingClientRect().width));
    });
    if (measured.size === 0) return;
    this.columns = this.columns.map((c) =>
      measured.has(c.field) ? { ...c, width: measured.get(c.field)! } : c,
    );
  }

  private onResizeStart(e: PointerEvent, field: string, th: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const startW = th.offsetWidth;
    // Freeze the CURRENT rendered width of every visible column before we start
    // dragging. `table-layout: auto` ignores <col> widths whenever content
    // demands more room (wide/multi-column tables), so setting one column's
    // width does nothing. Snapshotting all widths lets us switch to
    // `table-layout: fixed` (see render), under which <col> widths are exact —
    // so the drag moves the column 1:1. Columns that already carry a width keep
    // it; unset ones inherit whatever the browser is showing right now.
    this.freezeColumnWidths();
    this.resizing = { field, startX: e.clientX, startW };
    const onMove = (ev: PointerEvent) => {
      if (!this.resizing) return;
      const dx = ev.clientX - this.resizing.startX;
      const w = Math.max(MIN_COL_W, this.resizing.startW + dx);
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
      if (this.viewMode) {
        // Persist ALL frozen widths, not just the dragged one — the freeze
        // snapshot gave every visible column a width and the fixed layout needs
        // them all to render identically after a reload.
        const widths = { ...(this.viewInst?.columnWidths ?? {}) };
        for (const c of this.columns) {
          if (typeof c.width === 'number') widths[c.field] = c.width;
        }
        await ctx.store.viewInstances.patch(this.viewInstanceId, {
          columnWidths: widths,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.store.tables.patch(this.tableId, {
          columns: this.columns,
          updatedAt: Date.now(),
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private onColDragStart(e: DragEvent, field: string) {
    // Reorder drags start ONLY from the small `.col-grip` handle, never the
    // whole th — see the col-grip CSS note for why (a draggable th would
    // hijack the resize gutter's pointer drag and cover the sort click).
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
    if (this.viewMode) {
      // Reorder is stored as the new order of the instance's visible columns.
      await ctx.store.viewInstances.patch(this.viewInstanceId, {
        visibleColumns: next.map((c) => c.field),
        updatedAt: Date.now(),
      });
    } else {
      await ctx.store.tables.patch(this.tableId, {
        columns: next,
        updatedAt: Date.now(),
      });
    }
  }

  private async saveFilters() {
    const ctx = await getContext();
    // Strip empty entries so the persisted shape stays tidy.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.filters)) if (v && v.trim().length > 0) cleaned[k] = v;
    if (this.viewMode) {
      // A view instance always carries a (possibly empty) filters object.
      await ctx.store.viewInstances.patch(this.viewInstanceId, {
        filters: cleaned,
        updatedAt: Date.now(),
      });
      return;
    }
    const filters: Record<string, string> | undefined =
      Object.keys(cleaned).length === 0 ? undefined : cleaned;
    await ctx.store.tables.patch(this.tableId, { filters, updatedAt: Date.now() });
  }

  /**
   * Decide whether to render every row or just the visible slice.
   * Returns the slice plus virtual padding heights for the rows skipped above
   * and below the viewport. For small tables it just returns the whole list.
   */
  /**
   * Inline sizing for the <table> once columns carry explicit widths.
   *
   * `table-layout: fixed` alone is not enough to make a <col> width exact: it
   * needs a DEFINITE table width. The stylesheet's `width: max-content` isn't
   * definite, so the browser measured content anyway and then redistributed the
   * surplus across the columns — a column dragged to 10px still rendered at 341px.
   * Pinning the table to the exact sum of its columns (and releasing the
   * `min-width: 100%` that stretched it to the panel) makes each <col> exact, so
   * a column really can be 10px wide.
   *
   * Returns null while any visible column is still unsized — then the default
   * auto layout applies and a narrow table still fills the panel.
   */
  private tableSizingStyle(cols: ColumnSpec[]): string | null {
    if (cols.length === 0 || !cols.every((c) => typeof c.width === 'number')) return null;
    const total = cols.reduce((sum, c) => sum + (c.width ?? 0), 0) + ACTION_COL_W;
    return `table-layout: fixed; width: ${total}px; min-width: 0`;
  }

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
    // Captured for the panel-title row-count (emitted in updated()); render
    // already computes the visible set, so this reuses that pass.
    this.renderedCount = rows.length;
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
      <table style=${this.tableSizingStyle(cols) ?? nothing}>
        <colgroup>
          ${cols.map((c) => html`<col style=${c.width != null ? `width: ${c.width}px` : ''} />`)}
          <col style="width:${ACTION_COL_W}px" />
        </colgroup>
        <thead>
          <tr>
            ${cols.map((c) => {
              const canSort = c.sortable !== false;
              const sorted = this.sortColumn === c.field && this.sortDir;
              const icon = !canSort ? '' : sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '⇅';
              const typeClass = `t-${c.type}`;
              const isSrc = this.dragSourceField === c.field;
              const isTgt = this.dropTargetField === c.field;
              const edgeClass =
                isTgt && this.dropEdge === 'before'
                  ? ' drop-before'
                  : isTgt && this.dropEdge === 'after'
                    ? ' drop-after'
                    : '';
              const tip =
                (c.description ? `${c.description}\n` : '') +
                (c.units ? `Units: ${c.units}\n` : '') +
                `${c.field} — ${canSort ? 'click to sort, ' : 'not sortable · '}drag to reorder`;
              return html`
                <th
                  class=${`${typeClass}${sorted ? ' sorted' : ''}${isSrc ? ' drag-source' : ''}${edgeClass}${canSort ? '' : ' no-sort'}`}
                  title=${tip}
                  @click=${() => canSort && this.toggleSort(c.field)}
                  @dragover=${(e: DragEvent) =>
                    this.onColDragOver(e, c.field, e.currentTarget as HTMLElement)}
                  @dragleave=${() => this.onColDragLeave(c.field)}
                  @drop=${(e: DragEvent) => this.onColDrop(e, c.field)}
                >
                  <div class="col-head">
                    <span
                      class="col-grip mi sm"
                      title="Drag to reorder column"
                      draggable="true"
                      @click=${(e: Event) => e.stopPropagation()}
                      @dragstart=${(e: DragEvent) => this.onColDragStart(e, c.field)}
                      @dragend=${() => {
                        this.dragSourceField = null;
                        this.dropTargetField = null;
                        this.dropEdge = null;
                      }}
                      >drag_indicator</span
                    ><span class="col-label"
                      >${c.label}${c.units
                        ? html`<span class="col-units"> (${c.units})</span>`
                        : ''}</span
                    ><span class="sort-icon">${icon}</span>
                    <button
                      class=${`funnel${this.filters[c.field] ? ' active' : ''}`}
                      title="Filter by value"
                      @click=${(e: Event) => this.openFilterPicker(e, c.field)}
                    >
                      <span class="mi sm">filter_list</span>
                    </button>
                  </div>
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
            <th style="width:${ACTION_COL_W}px"></th>
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
                    title="Filter: text = contains, ^text = starts with, !text = does not contain, NULL = empty, !NULL = has a value. Comma-separate for several values (a,b = a OR b; !a,!b excludes both); quote a value containing a comma."
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

/**
 * True when `raw` has content (not null/undefined/empty/whitespace-only) but
 * `parsed` — whatever `toDateIso`/`toDatetimeLocal` made of it — came back
 * empty. Both parsers also return '' for a genuinely empty `raw`, so the
 * empty-content check above is what tells "no value" apart from "unparseable
 * value" — only the latter counts as invalid.
 */
function isNonEmptyButUnparsed(raw: unknown, parsed: string): boolean {
  if (raw == null) return false;
  if (typeof raw === 'string' && raw.trim() === '') return false;
  return parsed === '';
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
