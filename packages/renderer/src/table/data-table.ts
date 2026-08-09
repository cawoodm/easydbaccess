import { LitElement, css, html, nothing } from 'lit';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnSpec, DataCollection, Row, SortSpec, Table, ViewInstance } from '@easydb/shared';
import { readRows, type RowRequest } from '../db/row-reader.js';
import { ROW_FETCH_CAP } from '../db/data-store-ipc.js';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { FilterPopover } from '../chrome/filter-popover.js';
import '../chrome/filter-combobox.js';
import { searchRowsByField } from '../search/text-search.js';
import { matchesColumnFilter } from '@easydb/shared';
import { facetable, facetCounts, facetValues } from '../search/facet-values.js';
import { readSortDescFirst } from './grid-settings.js';
import { readSortSpecs, sortRowsBySpecs } from './row-sort.js';
import { nextSortSpecs } from './sort-cycle.js';
import { runColumnScript, runValidateScript } from '../util/column-script.js';
import { arrayMembers } from '@easydb/shared';
import { emitVisibleCount } from '../window-mgr/panel-title.js';
import { cellState, INVALID_CLASS, INVALID_INPUT_STYLE } from '../util/cell-validity.js';

/** Delay before the header loading bar appears, so fast loads don't flash it. */
const LOAD_BAR_DELAY_MS = 200;

/**
 * How long a view change waits before the grid refetches.
 *
 * Every keystroke in a filter box changes the query, and one round trip per
 * character is both wasteful and visibly jittery. 250ms matches what the
 * filter's own persist already waits, so the refetch and the save coincide.
 */
const RELOAD_DEBOUNCE_MS = 250;

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
      /* Says the grid is showing a slice. Sticky so scrolling a long table
         cannot leave the user reading a partial answer as a whole one. */
      .truncated-note {
        position: sticky;
        top: 0;
        left: 0;
        z-index: 3;
        padding: 0.25rem 0.5rem;
        background: #fef3c7;
        border-bottom: 1px solid #fcd34d;
        color: #92400e;
        font-size: 0.75rem;
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
      /* A cell whose content is a RENDERER ELEMENT: the element sizes itself from
         its content, and overflow:hidden does not shrink an element's intrinsic
         width — so a long value pushed the whole COLUMN wide and the table
         scrolled sideways instead of ellipsizing. That is what "auto ellipsis
         works until we have a renderer" meant. Capping the cell (the same trick
         as a link cell, and for the same reason) gives the element a bounded box
         to clip inside, so the ellipsis follows the column again. An explicitly
         resized column sets width, which takes over from this cap. */
      td.has-renderer {
        max-width: 40ch;
      }
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
      /* Sort priority (1, 2, 3 …), shown only while several columns sort. */
      .sort-rank {
        font-size: 0.85em;
        vertical-align: super;
        margin-left: 0.05em;
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
      /* Empty cell: pink background, so a gap is visible at a glance whatever
         the column's renderer draws. Kept distinct from the invalid red below —
         "nothing here" is normal, "this does not fit the type" is not. */
      td.is-null {
        background: #fce7f3;
      }
      td.is-null input[type='text'] {
        background: transparent;
      }
      /* Invalid stored value: the app-wide invalid red (see util/cell-validity),
         as an inset outline so the cell keeps its size and the grid lines stay
         put. Renderers additionally mark their own inputs. */
      td.is-invalid {
        outline: 1px solid #dc2626;
        outline-offset: -1px;
        background: #fef2f2;
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
  /**
   * The rows this grid holds — the answer to its CURRENT query, not the table.
   *
   * It used to be the whole table (capped at `ROW_FETCH_CAP`), which cost 1483ms
   * and a 15.4 MB IPC payload to show about 30 rows of a 609,283-row table. Worse
   * than slow, it was wrong: the cap truncated silently, so a filter or a sort
   * only ever saw the first 20,000 rows and confidently showed the wrong ones.
   * Now the filter, the search and the sort go to the store (`db/row-reader.ts`),
   * which applies them over the whole table and returns the narrowed set.
   */
  @state() private rows: Row[] = [];
  /**
   * Rows MATCHING the current filter and search across the whole table, which is
   * not the same as `rows.length` once the fetch is capped. The panel title needs
   * a number the grid did not fetch.
   */
  @state() private matchingTotal = 0;
  /**
   * Rows in the TABLE, filter and search ignored — the denominator of the panel
   * title's "3 of 1,204".
   *
   * A third number, because the other two cannot stand in for it. `rows.length` is
   * what was fetched and `matchingTotal` is what the filter matched, so once the
   * grid stopped fetching everything, both shrink the moment a filter is typed and
   * the title collapsed from "2/4" to "2" — the count vanishing exactly when it
   * became interesting. Counting is cheap (`COUNT(*)`, or a Dexie index count);
   * fetching to measure is what was not.
   */
  @state() private tableTotal = 0;
  /**
   * The fetch stopped short of the matching set, so `matchingTotal` is a floor and
   * what is on screen is a slice. Said out loud rather than implied — a truncated
   * grid that looks complete is how the old cap misled.
   */
  @state() private truncated = false;
  /**
   * Sort keys in priority order. A plain header click replaces the list; a
   * shift-click adds the column as a tie-breaker behind the ones already there.
   * `sortColumn`/`sortAsc` on the record mirror the first entry, so anything
   * reading a single sort (view windows, exports) keeps working.
   */
  @state() private sortSpecs: SortSpec[] = [];
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
  /** The row collection this grid reads, kept so a refetch needn't re-resolve it. */
  private rowColl: DataCollection<Row> | null = null;
  /**
   * Monotonic id per fetch. Two loads can be in flight (a change signal and a
   * filter edit), and the slower one must not deliver over the fresher one.
   */
  private loadGeneration = 0;
  private reloadTimer: number | null = null;
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
  /** The table itself is read-only (a reference, or the user marked it so). */
  @state() private tableReadonly = false;
  /**
   * No editing at all, from either source. A reference table used to render
   * editors it could never honour: typing in a cell threw
   * `ReadOnlyReferenceError` only AFTER the user had committed the edit.
   */
  private get readOnly(): boolean {
    return this.readOnlyView || this.tableReadonly;
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
    // A pending refetch would otherwise land on a detached element — and bump
    // the generation, so a later re-connect could discard its own fresh load.
    if (this.reloadTimer != null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    // A live column resize (see onResizeStart) has its own window-level
    // pointermove/pointerup/pointercancel listeners, but those only fire on
    // an actual pointer event — if the grid unmounts mid-drag (table
    // deleted, panel closed) none of them ever will, so clear the flag here
    // too. Otherwise it would stay set forever on THIS (now detached)
    // instance, which is harmless since applyTable never runs again on a
    // disconnected element, but leaves no ambiguity either way.
    this.resizing = null;
  }

  private onScroll = () => {
    // :host has overflow:auto so the data-table element itself is the
    // scrolling container. Reading scrollTop off it triggers a @state-driven
    // re-render via the assignment.
    this.scrollY = (this as unknown as { scrollTop: number }).scrollTop;
  };

  private onGlobalSearch = (e: Event) => {
    const next = (e as CustomEvent<{ query: string }>).detail.query ?? '';
    if (next === this.globalQuery) return;
    this.globalQuery = next;
    // Search is part of the query the store answers, so it has to be re-asked.
    this.scheduleReload();
  };

  private onTableSearch = (e: Event) => {
    const d = (e as CustomEvent<{ tableId: string; query: string }>).detail;
    // In view-bound mode the header search box is keyed by the VIEW instance id,
    // so match either — the underlying table id or the view instance id.
    if (d.tableId === this.tableId || (this.viewMode && d.tableId === this.viewInstanceId)) {
      const next = d.query ?? '';
      if (next === this.localQuery) return;
      this.localQuery = next;
      this.scheduleReload();
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
    // The TABLE's count, not the fetch's and not the filter's — see `tableTotal`.
    // `matchingTotal`/`rows.length` are the floor for a store that cannot count,
    // which keeps the old behaviour rather than reporting zero.
    const total = Math.max(this.tableTotal, this.matchingTotal, this.rows.length);
    if (count === this.lastEmittedCount && total === this.lastEmittedTotal) return;
    this.lastEmittedCount = count;
    this.lastEmittedTotal = total;
    emitVisibleCount(key, count, total);
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
    this.rowColl = ctx.store.rows(this.tableId);
    // `watch` is the change signal on its own; `subscribe` has to read the whole
    // collection to have something to hand its callback, which is the second
    // full fetch this grid used to pay for on every open. Either way the
    // response is the same: re-run OUR query.
    this.unsubscribe = this.rowColl.watch ? this.rowColl.watch(() => void this.loadRows()) : this.rowColl.subscribe(() => void this.loadRows());
    // `watch`/`subscribe` both fire once immediately, so the initial load is
    // already in flight — awaiting it here is what makes `bind()` resolve with
    // rows on screen, which the tests and the loading bar both rely on.
    await this.loadRows();
  }

  /**
   * Ask the store for exactly the rows this grid is showing.
   *
   * The request carries the filter, the search and the sort, so the narrowing
   * happens where the data is (`db/row-reader.ts` decides how much of that the
   * backend can soundly do and finishes the rest here). The grid's own
   * `filteredRows`/`sortedRows` still run over what comes back — that is what
   * keeps typing in a filter box responsive while this refetch is in flight, and
   * it is a no-op once the answer lands.
   */
  private async loadRows(): Promise<void> {
    const coll = this.rowColl;
    if (!coll) return;
    const gen = ++this.loadGeneration;
    // Show a loading bar in the table header, but only if the fetch is slow
    // enough to matter (large local tables, remote sources) — fast local loads
    // resolve before the delay so the bar never flashes.
    const barTimer = window.setTimeout(() => (this.loading = true), LOAD_BAR_DELAY_MS);
    try {
      const page = await readRows(coll, this.rowRequest(), ROW_FETCH_CAP);
      // A slower earlier load must not land on top of a newer one — the same
      // generation guard `subscribeToCollection` uses for the same reason.
      if (gen !== this.loadGeneration) return;
      this.rows = page.rows;
      this.matchingTotal = page.total;
      this.truncated = page.truncated === true;
      // The table count travels separately because the page's `total` is the
      // FILTERED one. Counted, never fetched, and only when the store can do it
      // without reading rows.
      if (coll.count) {
        const n = await coll.count();
        if (gen !== this.loadGeneration) return;
        this.tableTotal = n;
      } else {
        // No cheap count: an unfiltered read already told us, and a filtered one
        // can only report what it matched.
        this.tableTotal = page.total;
      }
    } catch (err) {
      if (gen !== this.loadGeneration) return;
      // A remote-backed table (e.g. a live Datasette source) can fail to load
      // its rows — a blocked cross-origin fetch, a bot challenge, an auth
      // error. Surface it instead of leaving a silently empty grid.
      this.rows = [];
      this.matchingTotal = 0;
      this.tableTotal = 0;
      const ctx = await getContext();
      ctx.api.ui.dialogs.toast(`Couldn't load rows: ${(err as Error)?.message ?? String(err)}`, {
        kind: 'error',
        title: 'Load failed',
      });
    } finally {
      window.clearTimeout(barTimer);
      if (gen === this.loadGeneration) this.loading = false;
    }
  }

  /** The current view, as a request the store can answer. */
  private rowRequest(): RowRequest {
    const search = [this.localQuery.trim(), this.globalQuery.trim()].filter(Boolean).join(' ');
    return {
      columns: this.columns,
      filters: this.filters,
      ...(search ? { search } : {}),
      ...(this.sortSpecs.length > 0 ? { sort: this.sortSpecs } : {}),
    };
  }

  /**
   * Refetch after the view changed, coalescing a burst into one round trip.
   *
   * Typing in a filter box changes the request on every keystroke, and each one
   * would otherwise be its own query. The delay matches the one the filter's own
   * persist already waits, so the refetch and the save land together.
   */
  private scheduleReload(): void {
    if (this.reloadTimer != null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.loadRows();
    }, RELOAD_DEBOUNCE_MS);
  }

  private applyTable(table: Table) {
    // Don't stomp on columns while a resize is live (same precedent as the
    // filter guard below): `onResizeStart` (see freezeColumnWidths) snapshots
    // every visible column's width into `this.columns` so the grid can switch
    // to `table-layout: fixed`, but that's purely in-memory until `onUp`
    // persists it. A store write can land mid-drag from something else
    // entirely — e.g. this panel getting fronted (a pointerdown anywhere in
    // it, including the resize handle, bumps its z-order — see
    // table-window-manager.ts's onfronted) — and re-applying the OLDER `table`
    // record here would overwrite the freeze with widthless columns, so the
    // table never flips to fixed and the drag barely moves anything.
    if (this.resizing == null) this.columns = table.columns;
    this.tableReadonly = !!table.readonly;
    this.sortSpecs = readSortSpecs(table);
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
    this.sortSpecs = readSortSpecs(inst);
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
   * (notnull, max, unique, then its `validate` script) before writing. On
   * rejection: pop a dialog with the reason and re-render so the cell input
   * reverts to its prior value.
   */
  private async commitCell(ctx: import('../app-context.js').AppContext, row: Row, field: string, value: unknown) {
    const col = this.columns.find((c) => c.field === field);
    // The CORE refuses the write, whatever the renderer offered. A renderer is a
    // display concern and may ignore `.readonly` — a third-party one, or a
    // built-in that never honoured it (the `preview` cell opened a Save-able
    // editor on a read-only table). Nothing should be able to write through it.
    if (this.readOnly || col?.readonly === true) {
      ctx.api.ui.dialogs.toast(this.readOnly ? 'This table is read-only.' : `“${col?.label ?? field}” is a read-only column.`, { kind: 'warning', title: 'Not saved' });
      // Re-render so an editor that got this far snaps back to the stored value.
      this.requestUpdate();
      return;
    }
    if (col) {
      const reason = validate(col, value, this.rows, row.id, row);
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
      await ctx.api.ui.dialogs.alert((err as Error)?.message ?? 'Could not save the change.', 'Save failed');
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
    // Same rule as the editable cell: an empty list shows nothing, whichever way
    // the emptiness is spelled (`[]`, `[ ]`, an empty array).
    if (col.type === 'array' && arrayMembers(raw).length === 0) return html``;
    if (col.type === 'date') return html`${toDateIso(raw)}`;
    if (col.type === 'datetime') return html`${toDatetimeLocal(raw).replace('T', ' ')}`;
    return html`${String(raw)}`;
  }

  /**
   * A cell whose column carries a script: the script's return value is what the
   * renderer receives as `value`, so a `link` column can point at a computed
   * URL. A failing script shows an inline chip (title = the message) instead of
   * taking the table down.
   *
   * `readonly` stays true — the computed value itself cannot be edited — but the
   * renderer also gets `rawValue`, the STORED cell, and its `change` event now
   * writes there. `sourceReadonly` is therefore NOT true here unless the table
   * itself is read-only: the pencil must keep opening the source. A renderer that offers an editor can therefore edit the value
   * the script works FROM: the link renderer's pencil used to open the computed
   * URL and then throw the edit away, because this branch wired no `change`
   * handler at all. Renderers that honour `readonly` (boolean, date, datetime)
   * are unaffected and stay display-only.
   *
   * A scripted column with no renderer stays plain read-only text: there is no
   * editor to point at the stored value.
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
      .rawValue=${row.data[col.field] ?? ''}
      .column=${col}
      .row=${row.data}
      .readonly=${true}
      .sourceReadonly=${this.readOnly}
      @change=${this.readOnly ? undefined : (e: Event) => this.setCell(row, col.field, (e as CustomEvent<{ value: unknown }>).detail.value)}
    ></${tag}>`;
  }

  private renderCell(row: Row, col: ColumnSpec) {
    const raw = row.data[col.field];
    // A column can carry a `script` whose `render(row)` output REPLACES the
    // stored value on the way into the renderer — so any renderer (link, image,
    // html, boolean…) or no renderer at all can display something computed
    // from the whole row. There used to be a dedicated `script` renderer that
    // ran the same script a second time and injected the result as raw HTML;
    // it duplicated this generic path and was removed, so a scripted column
    // always takes this branch now regardless of `col.renderer`.
    if (col.script?.trim()) {
      return this.renderScriptedCell(row, col);
    }
    // A cell is non-editable when the whole table/view is read-only OR the
    // column itself is flagged `readonly` (e.g. a Projection's computed and
    // secondary-source columns, which have no unambiguous write target).
    const cellReadonly = this.readOnly || col.readonly === true;
    // Cell rendering is dispatched by the column's `renderer` attribute, not
    // its data type. If a renderer is registered for the column's chosen
    // name we hand off to its custom element; otherwise the cell falls back to
    // a plain editable input on the raw value (see the switch below — only a
    // read-only view renders text). The standard renderers (date, datetime,
    // boolean) each ship as their own built-in plugin
    // (`cell-date`/`cell-datetime`/`cell-boolean`);
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
      // `.row` is the full row data object, passed through for any renderer
      // that wants neighbouring fields (built-ins currently ignore it —
      // `renderScriptedCell` above is where a column's own script gets `.row`).
      // `.readonly` tells editor renderers (date/datetime/boolean) to display,
      // not edit, in a read-only view; display-only renderers (link/image/
      // html/…) just ignore it. `.sourceReadonly` is the other question — may the
      // STORED value be written at all — which is what a renderer with a source
      // editor (`html`, `preview`, `markdown`) asks. They differ only on a
      // scripted column: see `renderScriptedCell`.
      return staticHtml`<${tag}
        .value=${raw ?? ''}
        .column=${col}
        .row=${row.data}
        .readonly=${cellReadonly}
        .sourceReadonly=${cellReadonly}
        @change=${cellReadonly ? undefined : (e: Event) => this.setCell(row, col.field, (e as CustomEvent<{ value: unknown }>).detail.value)}
      ></${tag}>`;
    }
    // Read-only never offers an editor: show the value as plain text
    // (dates/booleans formatted) instead of the native <input>.
    if (cellReadonly) {
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
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
        />`;
      case 'datetime':
        if (isNonEmptyButUnparsed(raw, toDatetimeLocal(raw))) {
          return this.renderInvalidCell(row, col, raw, `Not a valid datetime: "${String(raw)}"`);
        }
        return html`<input
          type="datetime-local"
          .value=${toDatetimeLocal(raw)}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, toDatetimeLocal(raw))}
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value || null)}
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
      case 'array': {
        // A list with no members is an EMPTY cell, not the text it happens to be
        // stored as: `[]` — how an absent list arrives from most exports — would
        // otherwise read as two brackets. The stored value is untouched; only
        // what the cell SHOWS changes, and typing in the box writes text as usual.
        const list = arrayMembers(raw).length === 0 ? '' : String(raw);
        return html`<input
          type="text"
          .value=${list}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, list)}
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value)}
        />`;
      }
      default:
        return html`<input
          type="text"
          .value=${String(raw ?? '')}
          @keydown=${(e: KeyboardEvent) => this.cancelCellEdit(e, String(raw ?? ''))}
          @change=${(e: Event) => this.setCell(row, col.field, (e.target as HTMLInputElement).value)}
        />`;
    }
  }

  private async deleteRow(rowId: string) {
    const ctx = await getContext();
    try {
      await ctx.store.rows(this.tableId).remove(rowId);
    } catch (err) {
      await ctx.api.ui.dialogs.alert((err as Error)?.message ?? 'Could not delete the row.', 'Delete failed');
    }
  }

  /**
   * Click cycle on a column header: none → asc → desc → none.
   * Sort state is persisted on the Table record so it survives reloads
   * and rides along through the dump/restore export path.
   */
  /**
   * Cycle one column's sort. Each click walks asc → desc → off for that column.
   *
   * The rule itself is `sort-cycle.ts` — pure, so which direction a first click
   * takes (the `grid:sortDescFirst` setting) is testable without a grid.
   */
  private async toggleSort(field: string, additive = false) {
    const ctx = await getContext();
    const next = nextSortSpecs(this.sortSpecs, field, {
      additive,
      descFirst: await readSortDescFirst(ctx.api.settings),
    });
    this.sortSpecs = next;
    // The sort travels with the query: on a table bigger than the fetch cap,
    // sorting only the rows already held would show the top of an arbitrary
    // slice rather than the top of the table.
    this.scheduleReload();
    await this.persistSort(next);
  }

  /** Write the sort keys, mirroring the first one into `sortColumn`/`sortAsc`. */
  private async persistSort(specs: SortSpec[]): Promise<void> {
    const first = specs[0];
    const patch = {
      sortBy: specs.length > 0 ? specs : undefined,
      sortColumn: first?.field,
      sortAsc: first ? first.asc : undefined,
      updatedAt: Date.now(),
    };
    const ctx = await getContext();
    if (this.viewMode) await ctx.store.viewInstances.patch(this.viewInstanceId, patch);
    else await ctx.store.tables.patch(this.tableId, patch);
  }

  /**
   * The active per-column filters with each column's TYPE attached — resolved
   * once here rather than per row, since only `array` changes how a cell is read
   * (per member instead of as one value) and finding that out is a column scan.
   */
  private typedFilters(active: Array<[string, string]>): Array<{ field: string; query: string; type: string | undefined }> {
    return active.map(([field, query]) => ({
      field,
      query,
      type: this.columns.find((c) => c.field === field)?.type,
    }));
  }

  private filteredRows(): Row[] {
    // A column flagged `filterable: false` is excluded from free-text search
    // as well as from the per-column funnel. A stored per-column filter that
    // predates the flag being set must not silently keep narrowing the grid.
    const unfilterable = new Set(this.columns.filter((c) => c.filterable === false).map((c) => c.field));
    // ...and a filter on a field no column has is worse than silent: it has no
    // funnel to clear it from and matches nothing, so the grid empties with
    // nothing on screen to explain why. See `row-reader.ts`, which drops the
    // same ones on the store-query path.
    const known = new Set(this.columns.map((c) => c.field));
    const active = Object.entries(this.filters).filter(([field, q]) => q && q.trim().length > 0 && !unfilterable.has(field) && known.has(field));
    const gq = this.globalQuery.trim();
    const lq = this.localQuery.trim();
    if (active.length === 0 && gq.length === 0 && lq.length === 0) return this.rows;
    // Per-column filters first (per-row substring), then the free-text searches.
    let rows = this.rows;
    if (active.length > 0) {
      const typed = this.typedFilters(active);
      rows = rows.filter((r) => typed.every((f) => matchesColumnFilter(r.data[f.field], f.query, { type: f.type })));
    }
    // Free-text search supports `field:value` (with !/^/comma-OR/NULL), boolean
    // AND/OR, and the phrase→AND→OR fallback. Local and global queries each
    // narrow the set independently. Field names resolve against this view's
    // columns (name or label), excluding non-filterable ones.
    const searchable = this.columns.filter((c) => c.filterable !== false);
    if (lq) rows = searchRowsByField(rows, lq, searchable);
    if (gq) rows = searchRowsByField(rows, gq, searchable);
    return rows;
  }

  private sortedRows(): Row[] {
    return sortRowsBySpecs(this.filteredRows(), this.sortSpecs, this.columns);
  }

  private async openFilterPicker(e: Event, field: string) {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const popover = FilterPopover.instance;
    if (!popover) return;
    // Faceted: count values only across rows that pass every OTHER column's
    // filter — so a column's own dropdown isn't pre-narrowed by what's
    // already typed in that column's filter, but other filters do narrow it.
    // The counting rules (blanks, order, the boolean domain) live in
    // `search/facet-values.ts`, which a view window's filter chip shares.
    const { values, blanks } = facetCounts(this.rowsFacetedFor(field), field, {
      type: this.columns.find((c) => c.field === field)?.type,
    });
    // Toggles apply live while the popover stays open (multi-value tri-state);
    // the promise only reports dismissal or an explicit Clear.
    const result = await popover.open(btn.getBoundingClientRect(), values, this.filters[field] ?? '', blanks, (next) => this.onFilterInput(field, next));
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
    // The filter is part of the query now, so the store has to be asked again.
    // Until it answers, the in-memory pass over the rows already held keeps the
    // grid responsive — and it narrows a truncated set, which is why the answer
    // still matters: on a big table those rows are only the first slice.
    this.scheduleReload();
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
    const unfilterable = new Set(this.columns.filter((c) => c.filterable === false).map((c) => c.field));
    const active = Object.entries(this.filters).filter(([f, q]) => q && q.trim().length > 0 && f !== focusField && !unfilterable.has(f));
    if (active.length === 0) return this.rows;
    const typed = this.typedFilters(active);
    return this.rows.filter((r) => typed.every((f) => matchesColumnFilter(r.data[f.field], f.query, { type: f.type })));
  }

  /**
   * The suggestion list each <filter-combobox> gets: column field → sorted
   * unique values. Long-text columns are left out entirely, and each list is
   * FACETED against the OTHER columns' filters, so picking a value in one column
   * narrows what the others offer. Drill-down UX. Both rules live in
   * `search/facet-values.ts`, which a view window's filter chip shares.
   */
  private computeFilterSuggestions(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const c of this.visibleColumns) {
      if (!facetable(this.rows, c.field, { type: c.type })) continue;
      // Faceted source: rows passing every other column's filter. An `array`
      // column suggests its MEMBERS, not the whole comma list.
      out.set(c.field, facetValues(this.rowsFacetedFor(c.field), c.field, { type: c.type }));
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
    this.columns = this.columns.map((c) => (measured.has(c.field) ? { ...c, width: measured.get(c.field)! } : c));
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
      this.columns = this.columns.map((c) => (c.field === this.resizing!.field ? { ...c, width: w } : c));
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
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
    // A touch drag the browser takes over (`.col-resize` sets no
    // touch-action) — or any other pointer interruption — fires
    // `pointercancel` with NO following `pointerup`. Without this, `resizing`
    // latches forever and the `applyTable` guard above then drops every
    // store→grid column update for the rest of this element's life.
    //
    // Cancel runs the SAME handler as a normal release, so the width the drag
    // had reached is committed rather than rolled back. That is deliberate: the
    // grid has already been rendering that width for the whole drag, and every
    // column was frozen at pointerdown, so "undoing" it would need the pre-drag
    // snapshot kept alive purely to spring the column back — a jump the user
    // did not ask for after an interruption they did not cause.
    window.addEventListener('pointercancel', onUp);
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
    const filters: Record<string, string> | undefined = Object.keys(cleaned).length === 0 ? undefined : cleaned;
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
        ? html`<div class="load-bar" role="progressbar" aria-label="Loading rows" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${frac != null ? Math.round(frac * 100) : nothing}>
            <div class="load-bar-fill ${frac != null ? 'determinate' : ''}" style=${frac != null ? `width:${Math.max(2, Math.round(frac * 100))}%` : nothing}></div>
          </div>`
        : nothing}
      ${this.truncated
        ? html`<div class="truncated-note" role="status">
            Showing the first ${this.rows.length.toLocaleString()} of ${this.matchingTotal.toLocaleString()}+ matching rows. Narrow the filter to see the rest.
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
              const canFilter = c.filterable !== false;
              const sortAt = this.sortSpecs.findIndex((s) => s.field === c.field);
              const spec = sortAt >= 0 ? this.sortSpecs[sortAt] : undefined;
              const sorted = spec ? (spec.asc ? 'asc' : 'desc') : null;
              const icon = !canSort ? '' : sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : '⇅';
              // The key's position, shown only when more than one column sorts —
              // with a single key the number would be noise.
              const rankLabel = this.sortSpecs.length > 1 && sortAt >= 0 ? String(sortAt + 1) : '';
              const typeClass = `t-${c.type}`;
              const isSrc = this.dragSourceField === c.field;
              const isTgt = this.dropTargetField === c.field;
              const edgeClass = isTgt && this.dropEdge === 'before' ? ' drop-before' : isTgt && this.dropEdge === 'after' ? ' drop-after' : '';
              const tip =
                (c.description ? `${c.description}\n` : '') +
                (c.units ? `Units: ${c.units}\n` : '') +
                `${c.field} — ${canSort ? 'click to sort, shift-click to add a sort level, ' : 'not sortable · '}drag to reorder` +
                (canFilter ? '' : ' · not filterable');
              return html`
                <th
                  class=${`${typeClass}${sorted ? ' sorted' : ''}${isSrc ? ' drag-source' : ''}${edgeClass}${canSort ? '' : ' no-sort'}`}
                  title=${tip}
                  @click=${(e: MouseEvent) => canSort && this.toggleSort(c.field, e.shiftKey)}
                  @dragover=${(e: DragEvent) => this.onColDragOver(e, c.field, e.currentTarget as HTMLElement)}
                  @dragleave=${() => this.onColDragLeave(c.field)}
                  @drop=${(e: DragEvent) => this.onColDrop(e, c.field)}
                >
                  <div class="col-head">
                    <!-- The grip, sort arrow and funnel glyph are decoration: a
                         Material Icons glyph is its own ligature text, so without
                         aria-hidden a header's accessible name reads
                         "drag_indicator a filter_list" and every column looks
                         alike to a screen reader (and to a by-name query). -->
                    <span
                      class="col-grip mi sm"
                      title="Drag to reorder column"
                      aria-hidden="true"
                      draggable="true"
                      @click=${(e: Event) => e.stopPropagation()}
                      @dragstart=${(e: DragEvent) => this.onColDragStart(e, c.field)}
                      @dragend=${() => {
                        this.dragSourceField = null;
                        this.dropTargetField = null;
                        this.dropEdge = null;
                      }}
                      >drag_indicator</span
                    ><span class="col-label">${c.label}${c.units ? html`<span class="col-units"> (${c.units})</span>` : ''}</span
                    ><span class="sort-icon" aria-hidden="true">${icon}${rankLabel ? html`<span class="sort-rank">${rankLabel}</span>` : nothing}</span>
                    ${canFilter
                      ? html`<button
                          class=${`funnel${this.filters[c.field] ? ' active' : ''}`}
                          title="Filter by value"
                          aria-label=${`Filter ${c.label || c.field}`}
                          @click=${(e: Event) => this.openFilterPicker(e, c.field)}
                        >
                          <span class="mi sm" aria-hidden="true">filter_list</span>
                        </button>`
                      : ''}
                  </div>
                  <span
                    class="col-resize"
                    title="Drag to resize column"
                    @click=${(e: Event) => e.stopPropagation()}
                    @pointerdown=${(e: PointerEvent) => this.onResizeStart(e, c.field, (e.currentTarget as HTMLElement).parentElement as HTMLElement)}
                  ></span>
                </th>
              `;
            })}
            <th style="width:${ACTION_COL_W}px"></th>
          </tr>
          <tr class="filter-row">
            ${cols.map((c) => {
              if (c.filterable === false) return html`<th></th>`;
              const opts = suggestions.get(c.field) ?? [];
              return html`
                <th>
                  <filter-combobox
                    .value=${this.filters[c.field] ?? ''}
                    .options=${opts}
                    placeholder="filter…"
                    title="Filter: text = contains, ^text = starts with, !text = does not contain, NULL = empty, !NULL = has a value. Comma-separate for several values (a,b = a OR b; !a,!b excludes both); quote a value containing a comma."
                    @filter-change=${(e: Event) => this.onFilterInput(c.field, (e as CustomEvent<{ value: string }>).detail.value)}
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
                    html`<td
                      class=${`t-${c.type}${c.renderer ? ` r-${c.renderer}` : ''}${c.renderer && this.cellRenderers?.get(c.renderer) ? ' has-renderer' : ''}${cellStateClass(r, c)}`}
                      title=${cellTooltip(r, c)}
                    >
                      ${this.renderCell(r, c)}
                    </td>`,
                )}
                <td>
                  ${this.readOnly
                    ? nothing
                    : html`<button class="danger" title="Delete row" @click=${() => this.deleteRow(r.id)}>
                        <span class="mi sm">delete</span>
                      </button>`}
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
 * The ` is-null` / ` is-invalid` suffix for a cell's `<td>` class, from the STORED
 * value — so the marking holds whatever renderer the column has, including one
 * that draws a checkbox or an image for an empty value.
 *
 * A scripted column is exempt: its display is computed by the script, so an empty
 * stored value is normal there and pink would flag every row.
 */
/**
 * Longest tooltip we hand a cell. Past a few hundred characters a native
 * tooltip is unreadable anyway, and the browser truncates it at its own
 * (undocumented) limit — better to cut it ourselves with a visible ellipsis.
 */
const MAX_TOOLTIP_CHARS = 500;

/**
 * The `title` for a cell: its full stored value, because a column narrower than
 * its content shows only an ellipsis and there is otherwise no way to read the
 * rest without widening the column or clicking in.
 *
 * A scripted column is skipped — what it shows is computed, so its stored value
 * would explain nothing. An empty cell gets no tooltip.
 */
function cellTooltip(row: Row, col: ColumnSpec): string {
  if (col.script) return '';
  const v = row.data[col.field];
  if (v == null) return '';
  // Nothing to explain about a cell that shows nothing.
  if (col.type === 'array' && arrayMembers(v).length === 0) return '';
  const text = typeof v === 'string' ? v : String(v);
  if (text.trim() === '') return '';
  return text.length > MAX_TOOLTIP_CHARS ? `${text.slice(0, MAX_TOOLTIP_CHARS)}…` : text;
}

function cellStateClass(row: Row, col: ColumnSpec): string {
  if (col.script) return '';
  const state = cellState(row.data[col.field], col.type);
  return state === 'empty' ? ' is-null' : state === 'invalid' ? ' is-invalid' : '';
}

/**
 * Returns a human-readable rejection reason, or null if value is acceptable.
 *
 * The declarative constraints run first and the column's `validate` script
 * last: the boxes are cheap and predictable, and a script author writing
 * "must be a valid IBAN" shouldn't have to re-check emptiness that the
 * Not-null box already covers.
 */
function validate(col: ColumnSpec, value: unknown, allRows: Row[], rowId: string, row: Row): string | null {
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
  if (col.validate?.trim()) {
    // The script sees the row AS IT WOULD BE — a rule comparing this cell to a
    // sibling field must read the pending edit, not the value on disk, or a
    // two-field rule contradicts itself depending on which cell you touch last.
    const proposed = { ...row.data, [col.field]: value };
    const run = runValidateScript(col.validate, value, proposed);
    if (!run.ok) return run.message;
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

/**
 * Toggle the progress bar on the window for `tableId` from outside the grid.
 * An importer shows the window (an empty table record) immediately, calls this
 * with `true`, fetches rows in the background, then calls it with `false` once
 * the rows have landed — so the user sees the window + a progress bar before
 * any data arrives.
 */
export function setTableLoading(tableId: string, loading: boolean, progress?: number): void {
  document.dispatchEvent(new CustomEvent('easydb:table-loading', { detail: { tableId, loading, progress } }));
}

declare global {
  interface HTMLElementTagNameMap {
    'data-table': DataTable;
  }
}
