import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { ColumnSpec, DataCollection, Row, ViewInstance, ViewTemplate } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { openViewsDialog } from '../dialogs/views-dialog.js';
import { openViewColumnsDialog } from '../dialogs/view-columns-dialog.js';
import { CELL_SLOT_CLASS, cyclePillValue, evaluateRows, extractFilterTokens, hasRowHtml, removePillValue, substituteRow, tokenValue, viewRows } from './view-render.js';
import { persistPillFilters, withPillValue } from './pill-filters.js';
import { viewColumnSpecs } from './view-columns.js';
import { parseColumnFilter } from '@easydb/shared';
import { facetable, facetCounts } from '../search/facet-values.js';
import { FilterPopover } from '../chrome/filter-popover.js';
import { searchRowsByField } from '../search/text-search.js';
import { emitVisibleCount } from '../window-mgr/panel-title.js';
import { readRows, type RowRequest } from '../db/row-reader.js';
import { ROW_FETCH_CAP } from '../db/data-store-bridge.js';
import { truncationNote } from '../db/truncation-note.js';
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
      /* Says the view is showing a slice of its table. Mirrors the grid's
         .truncated-note — same colours, same job. (No backticks in here: this
         is a template literal, and one would end it.) */
      .vw-note {
        flex: 0 0 auto;
        padding: 0.25rem 0.5rem;
        background: #fef3c7;
        border-bottom: 1px solid #fcd34d;
        color: #92400e;
        font-size: 0.75rem;
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
      /* $filter.TOKEN pill rendered inline in a template's row HTML — looks
         clickable, sits in the flow of the text around it. */
      .eda-filter-pill {
        font: inherit;
        display: inline;
        padding: 0.05rem 0.5rem;
        margin: 0 0.1rem;
        border: none;
        border-radius: 1rem;
        background: #e0f2fe;
        color: #0369a1;
        cursor: pointer;
      }
      .eda-filter-pill:hover {
        background: #bae6fd;
      }
      /* A token script that will not compile, or that throws. Marked in place —
         a blank card would read as "no data" and hide the broken script. */
      .eda-script-error {
        display: inline-block;
        padding: 0 0.35rem;
        border-radius: 0.25rem;
        background: #fee2e2;
        color: #b91c1c;
        font-size: 0.8rem;
        cursor: help;
      }
      .eda-pill-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.1rem 0.3rem 0.1rem 0.55rem;
        border-radius: 1rem;
        background: #e0f2fe;
        color: #0369a1;
        font-size: 0.8rem;
      }
      /* A chip is two buttons, because it does two things: the FIELD (with the
         operator) cycles = / != / off, and the VALUE opens the field's other
         values as a checklist. */
      .eda-pill-chip-field,
      .eda-pill-chip-value {
        padding: 0;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .eda-pill-chip-field {
        font-weight: 600;
      }
      .eda-pill-chip-field:hover,
      .eda-pill-chip-value:hover {
        text-decoration: underline;
      }
      /* Idle: the template offers this filter, nothing is filtering on it. Quiet
         and dashed so it reads as an offer, not as an active filter. */
      .eda-pill-chip.off {
        background: transparent;
        border: 1px dashed #7dd3fc;
        color: #0369a1;
        opacity: 0.75;
        padding: 0 0.3rem;
      }
      .eda-pill-chip.off:hover {
        opacity: 1;
        border-style: solid;
      }
      /* An excluded value reads as excluded at a glance, not only by its ≠. */
      .eda-pill-chip.not {
        background: #fee2e2;
        color: #b91c1c;
      }
      .eda-pill-chip.not .eda-pill-chip-remove:hover {
        background: rgba(185, 28, 28, 0.15);
      }
      .eda-pill-chip-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.1rem;
        height: 1.1rem;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: inherit;
        cursor: pointer;
        line-height: 1;
      }
      .eda-pill-chip-remove:hover {
        background: rgba(3, 105, 161, 0.15);
      }
      /* One toolbar at the top of a view: the sort controls (template mode) and
         the active filter chips, which used to sit in a second bar of their own. */
      .vw-sortbar {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
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
  private allRows: Row[] = [];
  private rowColl: DataCollection<Row> | null = null;
  /** Monotonic id per read, so a slow one cannot deliver over a fresher one. */
  private loadGeneration = 0;
  private rowsUnsub?: () => void;
  private instUnsub?: () => void;
  /** Free-text search from this view's own header search box. */
  @state() private searchQuery = '';
  /** The app-wide global search (header search bar), applied to every window. */
  @state() private globalQuery = '';

  /** Renderer name → custom-element tag, snapshotted from the registries. */
  @state() private cellRenderers: Map<string, string> = new Map();

  /**
   * The read stopped at the row cap, so what the view shows is a slice of its
   * table. The grid has said this for a while; a template view said nothing, and
   * a search inside one looked complete when it had only covered the slice.
   */
  @state() private truncated = false;

  /** Is a free-text query part of what is on screen — this view's, or the app's? */
  private get searchIsActive(): boolean {
    return this.searchQuery.trim() !== '' || this.globalQuery.trim() !== '';
  }

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
    // The template's HTML went in through `unsafeHTML`, so any cell-renderer
    // slot in it is an empty element until this fills it. Every render, because
    // `unsafeHTML` replaces the whole block whenever the string changes.
    this.mountCellRenderers();
    if (changed.has('viewInstanceId')) {
      this.rowsUnsub?.();
      this.loaded = false;
      await this.load();
    }
  }

  /**
   * Put the real cell-renderer element inside each slot `substituteRow` left.
   *
   * This exists because a renderer is a custom element driven by PROPERTIES
   * (`.value`, `.column`, `.row` — see `data-table.ts`), and a property cannot be
   * written into an HTML string. So the string pass marks the spot and this pass
   * mounts into it, with the same values `data-table` would pass.
   *
   * Read-only in both senses: a plain `$TOKEN` displays, it never edits — that is
   * what `$input.TOKEN` is for — so no `change` listener is wired up.
   */
  private mountCellRenderers(): void {
    const slots = this.renderRoot?.querySelectorAll?.(`.${CELL_SLOT_CLASS}:not([data-eda-mounted])`);
    if (!slots?.length) return;
    const byId = new Map(this.rows.map((r) => [r.id, r]));
    const specs = new Map(this.tableColumns.map((c) => [c.field, c]));
    const scripts = this.instance?.tokenScripts ?? {};
    for (const slot of slots) {
      const el = slot as HTMLElement;
      el.dataset.edaMounted = '1';
      const row = byId.get(el.dataset.edaRow ?? '');
      const field = el.dataset.edaField ?? '';
      const tag = el.dataset.edaTag ?? '';
      const spec = specs.get(field);
      if (!row || !spec || !tag) continue;
      const cell = document.createElement(tag) as HTMLElement & {
        value?: unknown;
        column?: ColumnSpec;
        row?: Record<string, unknown>;
        readonly?: boolean;
        sourceReadonly?: boolean;
        expanded?: boolean;
      };
      cell.value = tokenValue(row, field, scripts[el.dataset.edaToken ?? '']) ?? '';
      cell.column = spec;
      cell.row = row.data;
      cell.readonly = true;
      cell.sourceReadonly = true;
      // Not a grid row: a renderer that flattens its value to one line for the
      // grid (`preview`, `markdown` — see `plugins/preview-cell.ts`) renders it
      // properly here instead. A markdown column showed its text with the markers
      // stripped, which reads as the renderer not having been applied.
      cell.expanded = true;
      el.replaceChildren(cell);
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
    // Which renderers exist, so a `$TOKEN` can go through the column's own —
    // re-snapshotted on `app:ready`, like the grid does, because a hot-installed
    // plugin can add one after this view is already open.
    this.cellRenderers = new Map(ctx.registries.cellRenderers);
    ctx.events.on('app:ready', () => (this.cellRenderers = new Map(ctx.registries.cellRenderers)));
    this.template = (await ctx.store.viewTemplates.findOne(inst.templateId)) ?? null;
    const table = await ctx.store.tables.findOne(inst.tableId);
    this.tableColumns = table?.columns ?? [];
    // Keep the table-name snapshot current while the table exists, so the
    // reconnect-by-name path (view-window-manager) has an up-to-date value to
    // match against after a delete + recreate.
    if (table && inst.tableName !== table.name) {
      void ctx.store.viewInstances.patch(inst.id, { tableName: table.name });
    }
    // The same rule the grid uses (`data-table`'s `applyView`), so a per-view
    // renderer applies to a `$TOKEN` exactly as it does to a cell.
    this.columns = viewColumnSpecs(this.tableColumns, inst.visibleColumns, { renderers: inst.columnRenderers });
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
      const before = pushedSignature(this.instance);
      this.instance = me;
      // Only the parts that TRAVEL need a re-read. A pill click or a column
      // toggle is applied here over the rows already held, but a change to the
      // stored filters or the sort changes what the store was asked for — and on
      // a table past the fetch cap, re-filtering the old slice would be wrong.
      if (pushedSignature(me) !== before) void this.loadRows();
      else this.recompute();
    });
    this.rowColl = ctx.store.rows(inst.tableId);
    // `watch` is the change signal on its own; `subscribe` has to read the table
    // to have something to hand its callback, which is a second full read the
    // view throws away — it re-asks for its own narrowed set anyway.
    this.rowsUnsub = this.rowColl.watch ? this.rowColl.watch(() => void this.loadRows()) : this.rowColl.subscribe(() => void this.loadRows());
    await this.loadRows();
    this.loaded = true;
  }

  /**
   * Read the rows this view shows, letting the store do the narrowing it can.
   *
   * Only the instance's STORED filters and its sort travel. The pill filters, the
   * free-text search and the display `limit` stay here: `viewRows` applies the
   * pills as a second layer over the same fields (which one `RowQuery.filters`
   * entry per field cannot express), and a slice on top of a predicate this side
   * still has to apply would count off the wrong rows. Everything held back only
   * ever narrows FURTHER, so what comes back is a superset and `recompute` — which
   * re-applies the whole pipeline regardless — stays correct either way.
   */
  private loadRows(): Promise<void> {
    // Collapse overlapping reads. The rows subscription delivers once on connect —
    // the same read `reload` has already started — and once per write after that,
    // and every delivery costs a full read of the table. A
    // 20 000-row view read it FOUR times over while it opened, which is seconds.
    // A request that arrives mid-read is not dropped: it becomes one more read
    // after this one, so the last state still wins.
    if (this.loadInFlight) {
      this.loadAgain = true;
      return this.loadInFlight;
    }
    this.loadInFlight = this.readRows().finally(() => {
      this.loadInFlight = null;
      if (this.loadAgain) {
        this.loadAgain = false;
        void this.loadRows();
      }
    });
    return this.loadInFlight;
  }

  private loadInFlight: Promise<void> | null = null;
  private loadAgain = false;

  private async readRows(): Promise<void> {
    const coll = this.rowColl;
    const inst = this.instance;
    if (!coll || !inst) return;
    const gen = ++this.loadGeneration;
    // A SCRIPTED column is filtered and sorted on its COMPUTED value: `recompute`
    // runs `evaluateRows` before `viewRows`. The store knows nothing about that —
    // the stored cell behind a script is empty — so handing it such a predicate
    // (or letting `readRows` re-apply it here over un-evaluated rows) drops every
    // row. Those fields stay entirely with the view.
    const scripted = new Set(this.tableColumns.filter((c) => c.script).map((c) => c.field));
    const filters = Object.fromEntries(Object.entries(inst.filters ?? {}).filter(([f]) => !scripted.has(f)));
    const sortKeys = inst.sortBy?.length ? inst.sortBy : inst.sortColumn ? [{ field: inst.sortColumn, asc: inst.sortAsc !== false }] : [];
    const sort = sortKeys.filter((k) => !scripted.has(k.field));
    const req: RowRequest = {
      columns: this.tableColumns,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(sort.length > 0 ? { sort } : {}),
    };
    const page = await readRows(coll, req, ROW_FETCH_CAP);
    // A slower earlier read must not land over a newer one.
    if (gen !== this.loadGeneration) return;
    this.truncated = page.truncated === true;
    this.allRows = page.rows;
    this.recompute();
  }

  private recompute() {
    if (!this.instance) return;
    // The view's OWN data: the instance's stored filters and pill filters applied
    // to the table's rows, sorted, but not yet narrowed by a live search or the
    // display limit. This is the denominator of the window title — the source
    // table's row count says nothing about a view that deliberately shows a
    // slice of it.
    // Scripted columns first: a view shows, filters, sorts and searches the
    // values the grid computes, not the (empty) stored cells behind them.
    const evaluated = evaluateRows(this.allRows, this.tableColumns);
    const viewData = viewRows(evaluated, this.instance, this.tableColumns);
    let rows = viewData;
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
    // for the view window's title — shown / in this view, NOT / in the table.
    // Template-OFF renders <data-table>, which emits its own count (keyed by the
    // same view-instance id) against the grid's own rows — so we skip here to
    // avoid two producers fighting over the title.
    if (this.templateOn) emitVisibleCount(this.viewInstanceId, rows.length, viewData.length);
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

  /**
   * A `$filter.TOKEN` pill was clicked in the template. Adds an exact-match
   * pill filter for that field/value (OR-appended to any existing value on the
   * same field) and persists it on the instance's SEPARATE `pillFilters`
   * layer — never touching the view's snapshotted `filters`. Filtering is not
   * editing, so this runs even on a readonly view.
   */
  private onPillClick = async (e: Event): Promise<void> => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains('eda-filter-pill')) return;
    if (!this.instance) return;
    const field = t.getAttribute('data-eda-filter-field');
    const value = t.getAttribute('data-eda-filter-value');
    if (!field || value == null) return;
    await this.addPill(field, value);
  };

  /** Add one exact value to a field's pill filter, OR-ed with what is there. */
  private async addPill(field: string, value: string) {
    if (!this.instance) return;
    const pillFilters = withPillValue(this.instance.pillFilters, field, value);
    await persistPillFilters(this.instance.id, pillFilters);
    this.instance = { ...this.instance, pillFilters };
    this.recompute();
  }

  /**
   * The rows a chip's value list is built from: everything the view shows with
   * this ONE field's pill filter lifted, the view's own snapshotted filters and
   * the other fields' pills still applied.
   *
   * Lifting the field is the point. With its own filter still on, the only value
   * left in the rows is the one already selected — which is exactly why the
   * sibling values were unreachable by clicking.
   */
  private rowsFacetedFor(field: string): Row[] {
    if (!this.instance) return [];
    const pills = { ...(this.instance.pillFilters ?? {}) };
    delete pills[field];
    return viewRows(evaluateRows(this.allRows, this.tableColumns), { ...this.instance, pillFilters: pills }, this.tableColumns);
  }

  /** Write a field's whole pill-filter string (the value checklist applies live). */
  private async setPillFilter(field: string, next: string) {
    if (!this.instance) return;
    const pillFilters = { ...(this.instance.pillFilters ?? {}) };
    if (next.trim() === '') delete pillFilters[field];
    else pillFilters[field] = next;
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(this.instance.id, { pillFilters, updatedAt: Date.now() });
    this.instance = { ...this.instance, pillFilters };
    this.recompute();
  }

  /**
   * Clicking a chip's FIELD cycles that value: `=` → `≠` → off. The other values
   * OR-ed onto the same field are untouched.
   */
  private async cyclePill(field: string, value: string) {
    await this.setPillFilter(field, cyclePillValue(this.instance?.pillFilters?.[field], value));
  }

  /**
   * Clicking a chip's VALUE opens the field's other values as a CHECKLIST — the
   * same tri-state popover the grid's funnel uses, so several values can be
   * included or excluded in one visit. Toggles apply live.
   *
   * The list comes from the rows that pass everything EXCEPT this field's own
   * pill filter. Lifting that one filter is the point: with it applied, the only
   * value left in the rows is the one already selected, which is why the
   * siblings could not be reached by clicking at all.
   */
  private async openPillValues(field: string, anchor: HTMLElement) {
    const popover = FilterPopover.instance;
    if (!popover) return;
    const rows = this.rowsFacetedFor(field);
    const type = this.tableColumns.find((c) => c.field === field)?.type;
    if (!facetable(rows, field, { type })) return;
    const { values, blanks } = facetCounts(rows, field, { type });
    if (values.length === 0) return;
    const result = await popover.open(
      anchor.getBoundingClientRect(),
      values,
      this.instance?.pillFilters?.[field] ?? '',
      blanks,
      (next) => void this.setPillFilter(field, next),
      // A chip's tokens are exact: it came from clicking one cell's value, not
      // from someone typing a substring.
      { exact: true },
    );
    if (result === null) return;
    if (typeof result === 'object' && 'clear' in result) await this.setPillFilter(field, '');
    else if (typeof result === 'string') await this.setPillFilter(field, result);
  }

  /** Remove one pill-filter chip (the `×` in the header bar). Drops the field
   * entirely once its last value is removed. */
  private async removePill(field: string, value: string) {
    if (!this.instance) return;
    const next = removePillValue(this.instance.pillFilters?.[field], value);
    const pillFilters = { ...(this.instance.pillFilters ?? {}) };
    if (next === '') delete pillFilters[field];
    else pillFilters[field] = next;
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(this.instance.id, { pillFilters, updatedAt: Date.now() });
    this.instance = { ...this.instance, pillFilters };
    this.recompute();
  }

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
    const ok = await ctx.api.ui.dialogs.confirm(`Delete the view "${this.instance.name}"? The table and its rows stay.`, 'Delete view');
    if (!ok) return;
    await ctx.store.viewInstances.remove(this.instance.id);
  }

  /**
   * This view's own column editor: visibility and renderer, per column.
   *
   * Offered in BOTH modes, unlike the checkbox popover it replaces. Visibility is
   * what the grid shows, and the renderer is what a `$TOKEN` goes through too — so
   * a template view has the same reason to reach it. See `view-columns-dialog.ts`.
   */
  private editColumns() {
    if (!this.instance) return;
    openViewColumnsDialog(this.instance.id);
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
      // Per-token scripts format what a token SHOWS (a date in the reader's
      // locale, markdown as HTML) without touching the stored value.
      const scripts = this.instance?.tokenScripts ?? {};
      // A `$TOKEN` shows what the grid shows, so the column's renderer is
      // offered the value; `tokenRaw` and `$raw.` are the two ways out.
      const raw = this.instance?.tokenRaw ?? {};
      const body = this.rows.map((r) => substituteRow(t.rowHtml, r, mapping, { columns: colMap, readonly, scripts, renderers: this.cellRenderers, raw })).join('');
      const full = (t.headerHtml ?? '') + body + (t.footerHtml ?? '');
      return html`<div class="vw-root">${unsafeHTML(full)}</div>`;
    }
    // Table mode: header/footer HTML above and below a read-only table.
    return html`<div class="vw-root">
      ${t.headerHtml?.trim() ? html`<div class="vw-html">${unsafeHTML(t.headerHtml)}</div>` : nothing} ${this.renderTable()}
      ${t.footerHtml?.trim() ? html`<div class="vw-html">${unsafeHTML(t.footerHtml)}</div>` : nothing}
    </div>`;
  }

  /**
   * The view's one top toolbar: the sort controls, then the active filter chips.
   *
   * The chips used to have a bar of their own directly below this one, which
   * spent a second row of a window that is often only a few hundred pixels tall
   * — and put the two controls that narrow a view in two different places. The
   * sort controls are template-mode only (the grid has sortable headers of its
   * own), so in grid mode the toolbar is chips alone, and nothing at all when
   * there are none.
   */
  private renderSortBar() {
    if (!this.instance) return nothing;
    const chips = this.renderPillChips();
    const hasChips = Array.isArray(chips) && chips.length > 0;
    if (!this.templateOn) {
      return hasChips ? html`<div class="vw-sortbar">${chips}</div>` : nothing;
    }
    // Offer every column the source lets us sort by (a provider can mark some
    // unsortable via `sortable: false`).
    const cols = this.tableColumns.filter((c) => c.sortable !== false);
    const cur = this.instance.sortColumn ?? '';
    const asc = this.instance.sortAsc ?? true;
    return html`<div class="vw-sortbar">
      <span class="mi" title="Sort">sort</span>
      <select aria-label="Sort by" @change=${(e: Event) => void this.setSortColumn((e.target as HTMLSelectElement).value)}>
        <option value="" ?selected=${!cur}>— unsorted —</option>
        ${cols.map((c) => html`<option value=${c.field} ?selected=${cur === c.field}>${c.label || c.field}</option>`)}
      </select>
      <button aria-label="Toggle sort direction" title=${asc ? 'Ascending (click for descending)' : 'Descending (click for ascending)'} ?disabled=${!cur} @click=${() => void this.toggleSortDir()}>
        <span class="mi">${asc ? 'arrow_upward' : 'arrow_downward'}</span>
      </button>
      ${chips}
    </div>`;
  }

  /**
   * The fields the TEMPLATE offers a filter on: one per `$filter.TOKEN`, mapped
   * through the instance's token→column map. They get a chip whether or not they
   * are filtering.
   *
   * Grid mode has no template body, so it offers none — its chips are whatever
   * is actually filtering, as before.
   */
  private get chipFields(): string[] {
    if (!this.template || !this.templateOn) return [];
    const mapping = this.instance?.mapping ?? {};
    const fields = extractFilterTokens(this.template.headerHtml ?? '', this.template.rowHtml ?? '', this.template.footerHtml ?? '')
      .map((token) => mapping[token])
      .filter((f): f is string => !!f);
    return [...new Set(fields)];
  }

  /**
   * The filter chips: one per pill-filter token — so two values OR-ed onto the
   * same field each get their own chip — plus an IDLE chip for every field the
   * template offers a filter on and nothing is filtering on yet. Shows ONLY the
   * `pillFilters` layer, never the view's snapshotted `filters`.
   *
   * Two things this fixes. A filter used to be reachable only by finding a row
   * that shows the value and clicking its pill — the toolbar said nothing about
   * what could be filtered. And cycling a chip to "off" removed it, so the way
   * back was gone with it; now the chip stays as its idle self.
   *
   * An active chip is `field <op> value`, and each half is a button: the field
   * (with its operator) cycles `=` / `≠` / off, the value opens the field's other
   * values as a checklist, and `×` drops the token. An idle chip is `field ▾`
   * alone — no operator to cycle and nothing to remove, so it is the checklist
   * button and nothing else.
   */
  private renderPillChips() {
    const pf = this.instance?.pillFilters ?? {};
    const offered = this.chipFields;
    if (Object.keys(pf).length === 0 && offered.length === 0) return nothing;
    const chips: Array<{ field: string; value: string; state: 'on' | 'not' }> = [];
    const filtering = new Set<string>();
    // Offered fields first, in template order, so the toolbar does not reshuffle
    // as filters come and go; any other field that filters follows.
    for (const field of [...new Set([...offered, ...Object.keys(pf)])]) {
      const raw = pf[field];
      if (!raw) continue;
      for (const tok of parseColumnFilter(raw)) {
        if (!tok.term) continue;
        filtering.add(field);
        chips.push({ field, value: tok.term, state: tok.negate ? 'not' : 'on' });
      }
    }
    const idle = offered
      .filter((f) => !filtering.has(f))
      .map(
        (field) =>
          html`<span class="eda-pill-chip off">
            <button type="button" class="eda-pill-chip-value" title=${`Filter this view by ${field}`} @click=${(e: Event) => void this.openPillValues(field, e.currentTarget as HTMLElement)}>
              ${field} ▾
            </button>
          </span>`,
      );
    return [
      ...idle,
      ...chips.map(
        (c) =>
          html`<span class=${`eda-pill-chip${c.state === 'not' ? ' not' : ''}`}>
            <button
              type="button"
              class="eda-pill-chip-field"
              title=${c.state === 'not' ? `Excluding this value — click to stop filtering on ${c.field}` : `Only this value — click to EXCLUDE it instead`}
              @click=${() => void this.cyclePill(c.field, c.value)}
            >
              ${c.field}${c.state === 'not' ? ' ≠' : ' ='}
            </button>
            <button type="button" class="eda-pill-chip-value" title=${`Other values of ${c.field}`} @click=${(e: Event) => void this.openPillValues(c.field, e.currentTarget as HTMLElement)}>
              ${c.value}
            </button>
            <button type="button" class="eda-pill-chip-remove" aria-label=${`Remove filter ${c.field}: ${c.value}`} title="Remove this filter" @click=${() => void this.removePill(c.field, c.value)}>
              ×
            </button>
          </span>`,
      ),
    ];
  }

  private renderFooter() {
    if (!this.instance) return nothing;
    const on = this.templateOn;
    return html`<div class="vw-footer">
      <button title="Columns in this view: which ones show, and what draws them" aria-label="Columns" @click=${() => this.editColumns()}>
        <span class="mi">view_column</span>
      </button>
      <button aria-label="Edit view" title="Edit this view (rename, re-map columns)" @click=${() => this.editView()}>
        <span class="mi">edit</span>
      </button>
      ${this.template
        ? html`<button class="edit-template" aria-label="Edit template" title=${`Edit the "${this.template.name}" template`} @click=${() => this.editTemplate()}>
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
      <button class="danger" aria-label="Delete view" title="Delete this view (the table stays)" @click=${() => void this.deleteView()}>
        <span class="mi">delete</span>
      </button>
    </div>`;
  }

  override render() {
    if (!this.loaded) return html`<div class="vw-body scroll"><div class="vw-loading">Loading…</div></div>`;
    if (this.error) return html`<div class="vw-body scroll"><div class="vw-empty">${this.error}</div></div>`;

    const on = this.templateOn;
    const body = on
      ? html`<div class="vw-body scroll" @change=${this.onInputChange} @click=${this.onPillClick}>${this.renderTemplated()}</div>`
      : html`<div class="vw-body grid">
          <data-table .tableId=${this.instance?.tableId ?? ''} .viewInstanceId=${this.viewInstanceId}></data-table>
        </div>`;
    // One toolbar for both: sort controls in template mode, filter chips in
    // either (pill filters apply to the grid too). It renders nothing in grid
    // mode with no chips.
    //
    // The truncation note is template-mode only: grid mode IS a `<data-table>`,
    // which carries its own.
    const note = on && this.truncated ? truncationNote({ shown: this.rows.length, total: this.allRows.length, searching: this.searchIsActive, searched: ROW_FETCH_CAP }) : null;
    return html`${this.renderSortBar()}${note ? html`<div class="vw-note" role="status">${note}</div>` : nothing}${body}${this.renderFooter()}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'view-window': ViewWindow;
  }
}

/**
 * The parts of a view instance that are handed to the STORE — its stored filters
 * and its sort. Compared as a string so an instance update can tell "re-ask the
 * store" from "just re-render what we hold".
 */
function pushedSignature(inst: ViewInstance | null): string {
  if (!inst) return '';
  const sort = inst.sortBy?.length ? inst.sortBy.map((s) => `${s.field}:${s.asc !== false}`).join(',') : `${inst.sortColumn ?? ''}:${inst.sortAsc !== false}`;
  return `${JSON.stringify(inst.filters ?? {})}|${sort}`;
}
