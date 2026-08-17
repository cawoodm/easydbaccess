// packages/renderer/src/viz/viz-panel.ts
//
// `<viz-panel>` — one visualization of one table. The app-side half of the
// drawing: it owns the store, the channels, the aggregation and the honesty about
// capped reads, and hands a registered element plain data.
//
// It is the counterpart of `views/view-window.ts` (an HTML template of one table)
// and reuses that element's row-reading shape deliberately, including
// `readRows` + `watch ?? subscribe`.
//
// **Two ways rows arrive, and the difference matters.**
//
//  - **Docked** (`ViewInstance.dock` set) — the host grid publishes its filtered
//    set through `table/visible-rows.ts` and this element never reads the store.
//    That is what makes a chart agree with the grid beside it structurally rather
//    than by two code paths reimplementing the same filters, and it avoids
//    re-fetching a table the grid has already read.
//  - **Windowed** — nothing is publishing, so it reads rows itself, applying the
//    instance's own filters/sort/limit.
//
// The adapter boundary lives here on purpose: `viz/elements/*` may not import
// `@easydb/shared` (see `elements/chart-data.ts`), so this is the only place that
// knows both a `VizFrame` and a `ChartData`.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';
import type { ColumnSpec, DataCollection, Row, Table, ViewInstance, ViewTemplate, VisualizationSpec, VizAggregate } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { readRows, type RowRequest } from '../db/row-reader.js';
import { ROW_FETCH_CAP } from '../db/data-store-bridge.js';
import { truncationNote } from '../db/truncation-note.js';
import { readSortSpecs } from '../table/row-sort.js';
import { runColumnScript } from '../util/column-script.js';
import { requestVisibleRows, watchVisibleRows, type VisibleRowsDetail } from '../table/visible-rows.js';
import { paneFilter, paneSort } from '../table/pane-actions.js';
import { persistPillFilters, withPillValue } from '../views/pill-filters.js';
import { aggregateRows, type VizFrame } from './viz-aggregate.js';
import { parseWordList, resolveStopWords, wordFrequencies } from './word-frequency.js';
import { effectiveAggregate, effectiveVizOptions } from './viz-options.js';
import { csvFilename, frameToCsv, pointsToCsv, termsToCsv } from './viz-csv.js';
import { emptyChannelNote, emptyChannels, noTermsNote, type MappedChannel } from './viz-diagnose.js';
import { readTileAttribution, readTileUrl, DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL } from './viz-settings.js';
import { defineCharts } from './elements/chart-element.js';
import { definePointMap } from './elements/point-map.js';
import { defineWordCloud } from './elements/word-cloud.js';
import { defineCustomHtml, type VizFilterRequest, type VizSortRequest } from './viz-custom-html.js';
import type { ChartData, CloudTerm, MapPoint } from './elements/chart-data.js';

// Registers the built-in drawing tags once, at module load. The elements
// themselves import nothing heavy — Chart.js, Leaflet and d3-cloud are all
// behind a lazy `import()` inside each element's first draw.
defineCharts();
definePointMap();
defineWordCloud();
defineCustomHtml();

@customElement('viz-panel')
export class VizPanel extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      box-sizing: border-box;
      /* The default palette the elements read. Overridable per host. */
      --viz-palette: #2563eb, #0891b2, #7c3aed, #db2777, #ea580c, #16a34a, #ca8a04, #dc2626;
      font:
        12px/1.4 system-ui,
        sans-serif;
    }
    .chart {
      flex: 1;
      min-height: 0;
      padding: 4px 6px;
    }
    .chart.bleed {
      padding: 0;
    }
    .note,
    .error {
      flex: none;
      padding: 3px 8px;
      font-size: 11px;
      line-height: 1.35;
      border-top: 1px solid rgba(127, 127, 127, 0.25);
    }
    .note {
      color: #92400e;
      background: #fffbeb;
    }
    .error {
      color: #b91c1c;
      background: #fef2f2;
    }
    @media (prefers-color-scheme: dark) {
      .note {
        color: #fcd34d;
        background: rgba(120, 53, 15, 0.35);
      }
      .error {
        color: #fca5a5;
        background: rgba(127, 29, 29, 0.35);
      }
    }
    .placeholder {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      text-align: center;
      color: rgba(127, 127, 127, 0.95);
    }
  `;

  /** The instance to draw. Everything else is resolved from it. */
  @property({ type: String }) viewInstanceId = '';

  @state() private instance: ViewInstance | null = null;
  @state() private template: ViewTemplate | null = null;
  @state() private columns: ColumnSpec[] = [];
  @state() private frame: VizFrame | null = null;
  @state() private error = '';
  @state() private loaded = false;

  private rows: Row[] = [];
  private rowColl: DataCollection<Row> | null = null;
  private matchingTotal = 0;
  private truncated = false;
  private searching = false;
  private tileUrl = DEFAULT_TILE_URL;
  private tileAttribution = DEFAULT_TILE_ATTRIBUTION;

  // `| undefined` spelled out: `exactOptionalPropertyTypes` is on, so an
  // optional property is not implicitly assignable from `undefined`.
  private instUnsub?: (() => void) | undefined;
  private rowsUnsub?: (() => void) | undefined;
  private tableUnsub?: (() => void) | undefined;
  private dockUnsub?: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardown();
  }

  private teardown(): void {
    this.instUnsub?.();
    this.rowsUnsub?.();
    this.tableUnsub?.();
    this.dockUnsub?.();
    this.instUnsub = undefined;
    this.rowsUnsub = undefined;
    this.tableUnsub = undefined;
    this.dockUnsub = undefined;
    this.rowColl = null;
  }

  /**
   * The data behind the picture, as a CSV file.
   *
   * Returns null when there is nothing drawn yet — the caller hides its button
   * rather than offering an export of an empty chart. Which shape is written
   * follows the SAME question the render does (`spec.data` and the declared
   * channel kinds), so the file always matches what is on screen.
   */
  exportCsv(): { filename: string; text: string } | null {
    const name = this.instance?.name ?? 'visualization';
    const filename = csvFilename(name);
    if (this.spec?.data === 'rows') {
      const points = this.mapPoints();
      if (points.length > 0) return { filename, text: pointsToCsv(points) };
      const terms = this.cloudTerms();
      if (terms.length > 0) return { filename, text: termsToCsv(terms) };
      return null;
    }
    const frame = this.frame;
    if (!frame || frame.categories.length === 0) return null;
    return { filename, text: frameToCsv(frame) };
  }

  /**
   * Re-read the data behind this visualization, bypassing any cache.
   *
   * `reload()` re-reads the store; this additionally calls the collection's own
   * `refresh()` where it has one, which is what makes it meaningful for a
   * source-backed table (a live Datasette connection caches its reads, so a plain
   * re-read would hand back the same rows).
   *
   * A DOCKED pane is fed by the grid rather than the store, so its refresh asks
   * the GRID to re-read — otherwise the button would appear to do nothing on
   * exactly the tables where refreshing matters.
   */
  async refreshNow(): Promise<void> {
    const tableId = this.instance?.tableId;
    if (tableId) {
      const ctx = await getContext();
      // Bypasses a caching provider where there is one (a live Datasette
      // connection would otherwise hand back the rows it already has). A local
      // collection has no `refresh` and is already live, so this is a
      // deliberate no-op there rather than a missing case.
      await ctx.store
        .rows(tableId)
        .refresh?.()
        .catch(() => {
          /* a provider that cannot refresh is not an error */
        });
    }
    const dock = this.instance?.dock;
    if (dock) {
      // Docked: the GRID owns the read and republishes on its own subscription,
      // so re-binding here would fight it. Pull its current set instead — a
      // re-render it had no reason to do would otherwise leave this pane on stale
      // rows — then recompute, which also redoes the drawing: a word cloud
      // re-lays-out, which is the visible half of what pressing refresh asks for.
      const key = dock.host.kind === 'view' ? dock.host.viewInstanceId : dock.host.tableId;
      const now = requestVisibleRows(key);
      if (now) this.acceptPublishedRows(now);
      else this.recompute();
      this.requestUpdate();
      return;
    }
    await this.reload();
  }

  /** Re-read everything. Called by the window manager on an instance edit. */
  async reload(): Promise<void> {
    this.teardown();
    await this.load();
  }

  private get spec(): VisualizationSpec | null {
    const kind = this.template?.viz?.kind;
    if (!kind) return null;
    return this.registries?.visualizations.get(kind) ?? null;
  }

  private registries: { visualizations: Map<string, VisualizationSpec> } | null = null;

  private async load(): Promise<void> {
    if (!this.viewInstanceId) return;
    const ctx = await getContext();
    this.registries = ctx.registries;

    // An instance edit (remap, rename, option change) refreshes in place.
    this.instUnsub = ctx.store.viewInstances.subscribe((all) => {
      const inst = all.find((i) => i.id === this.viewInstanceId);
      if (!inst) return;
      const rebind = inst.tableId !== this.instance?.tableId || inst.templateId !== this.instance?.templateId;
      // A WINDOWED visualization reads rows itself and folds `pillFilters` into
      // that read, so a pill clicked in a custom template has to re-read — a
      // recompute alone would redraw the same rows. Docked, the grid owns the
      // read and republishes on its own.
      const pillsChanged = !inst.dock && pillKey(inst.pillFilters) !== pillKey(this.instance?.pillFilters);
      this.instance = inst;
      this.publishTableAttr();
      if (rebind) void this.bind();
      else if (pillsChanged) void this.loadRows();
      else void this.refreshTemplateThenRecompute();
    });

    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) {
      this.error = 'This visualization no longer exists.';
      this.loaded = true;
      return;
    }
    this.instance = inst;
    this.publishTableAttr();
    await this.bind();
  }

  private async refreshTemplateThenRecompute(): Promise<void> {
    const ctx = await getContext();
    const inst = this.instance;
    if (!inst) return;
    this.template = (await ctx.store.viewTemplates.findOne(inst.templateId)) ?? null;
    this.recompute();
  }

  private async bind(): Promise<void> {
    const ctx = await getContext();
    const inst = this.instance;
    if (!inst) return;
    this.rowsUnsub?.();
    this.tableUnsub?.();
    this.dockUnsub?.();

    this.tileUrl = await readTileUrl(ctx.api.settings);
    this.tileAttribution = await readTileAttribution(ctx.api.settings);

    this.template = (await ctx.store.viewTemplates.findOne(inst.templateId)) ?? null;
    if (!this.template) {
      this.error = 'The template this visualization uses is gone.';
      this.loaded = true;
      return;
    }
    if (this.template.kind !== 'viz' || !this.template.viz) {
      this.error = 'This template is not a visualization.';
      this.loaded = true;
      return;
    }

    const table = await ctx.store.tables.findOne(inst.tableId);
    if (!table) {
      this.error = 'The table this visualization reads is gone.';
      this.loaded = true;
      return;
    }
    this.applyTable(table);
    // A column rename / type change / added script has to reach the chart, the
    // same way it reaches the grid.
    this.tableUnsub = ctx.store.tables.subscribe((all) => {
      const t = all.find((x) => x.id === this.instance?.tableId);
      if (!t) return;
      this.applyTable(t);
      this.recompute();
    });

    if (inst.dock) {
      // Docked: the host grid is the source of rows. Keyed by the grid's own
      // key — a view window's grid publishes under its view-instance id, a table
      // window's under the table id.
      const key = inst.dock.host.kind === 'view' ? inst.dock.host.viewInstanceId : inst.dock.host.tableId;
      this.dockUnsub = watchVisibleRows(key, (d) => this.acceptPublishedRows(d));
      // Then PULL, because the grid publishes only when somebody is already
      // listening and we just became that somebody — one render too late. Without
      // this the pane says "No data" beside a full grid until something happens to
      // make the grid re-render, which for a table nobody is touching is never.
      // Then PULL, because the grid publishes only when somebody is already
      // listening and we just became that somebody — one render too late. Without
      // this the pane said "No data" beside a full grid until something happened to
      // make the grid re-render, which for a table nobody is touching is never.
      //
      // A null answer means the grid is not mounted YET (on a reload both mount at
      // once and the order is not ours to choose), so stay on "Loading…" rather
      // than claim to be loaded with no rows — that is what made a reloaded word
      // cloud say "No words to show." until it was resized. Its own render is what
      // finally published, and `acceptPublishedRows` sets `loaded` then.
      const now = requestVisibleRows(key);
      if (now) this.acceptPublishedRows(now);
      return;
    }

    // Windowed: read for ourselves.
    this.rowColl = ctx.store.rows(inst.tableId);
    this.rowsUnsub = this.rowColl.watch ? this.rowColl.watch(() => void this.loadRows()) : this.rowColl.subscribe(() => void this.loadRows());
    await this.loadRows();
  }

  private applyTable(table: Table): void {
    this.columns = table.columns ?? [];
  }

  /**
   * Advertise the table this visualization is about, as a plain data attribute.
   *
   * A commandlet clicked inside a pane needs to know which table it is in — that
   * is what a target-less `#goto?Country==CH` acts on — and `tableIdAtNode` only
   * finds a TABLE window. A windowed visualization is not inside one, and a
   * `#goto` from it failed with "name the table" even though a visualization
   * always has exactly one.
   *
   * An attribute rather than a property or an import: `plugins/commandlets.ts`
   * walks the composed path of the click and reads `data-eda-table` off whatever
   * it passes, so any element can answer the question without that module
   * learning what a viz-panel is.
   */
  private publishTableAttr(): void {
    const id = this.instance?.tableId;
    if (id) this.dataset.edaTable = id;
    else delete this.dataset.edaTable;
  }

  private acceptPublishedRows(d: VisibleRowsDetail): void {
    this.rows = [...d.rows];
    this.matchingTotal = d.total;
    this.truncated = d.truncated;
    this.searching = d.searching;
    this.loaded = true;
    this.recompute();
  }

  /**
   * Read the rows a windowed visualization draws.
   *
   * Filters and sort are pushed down where they provably mean the same thing to
   * the backend (`readRows` decides); `limit` is the instance's own row cap.
   */
  private async loadRows(): Promise<void> {
    const coll = this.rowColl;
    const inst = this.instance;
    if (!coll || !inst) return;
    const req: RowRequest = {
      columns: this.columns,
      filters: { ...(inst.filters ?? {}), ...(inst.pillFilters ?? {}) },
      sort: readSortSpecs(inst),
      ...(inst.limit && inst.limit > 0 ? { limit: inst.limit } : {}),
    };
    const page = await readRows(coll, req, ROW_FETCH_CAP);
    this.rows = page.rows;
    this.matchingTotal = page.total;
    this.truncated = page.truncated === true;
    this.searching = false;
    this.loaded = true;
    this.recompute();
  }

  /**
   * The aggregation spec actually used: the template's (else the
   * visualization's declared default), with THIS view's overrides on top.
   *
   * The same two-layer shape `options` already had — a template says "count rows
   * per category" and one view of it may say "sum the amount" without forking the
   * template. See `viz-options.ts` for why the override is a delta.
   */
  private get aggregate(): VizAggregate | null {
    const base = this.template?.viz?.aggregate ?? this.spec?.defaultAggregate ?? null;
    return effectiveAggregate(base, this.instance?.vizAggregate);
  }

  /**
   * Evaluate scripted columns before aggregating.
   *
   * A scripted column stores nothing — its value is computed at render time — so
   * aggregating the STORED cell would sum a column of blanks. The grid and the
   * view window both evaluate before they display; a chart has to as well, or
   * charting a computed column silently yields nothing.
   */
  private evaluatedRows(): Row[] {
    const scripted = this.columns.filter((c) => typeof c.script === 'string' && c.script.trim() !== '');
    if (scripted.length === 0) return this.rows;
    return this.rows.map((r) => {
      const data = { ...r.data };
      for (const c of scripted) {
        const run = runColumnScript(c.script, r.data);
        // A broken script is one empty column, not a broken chart — the column
        // editor is where that error belongs, and it already reports it there.
        data[c.field] = run.ok ? run.value : null;
      }
      return { ...r, data };
    });
  }

  private recompute(): void {
    const inst = this.instance;
    // A `data: 'rows'` visualization plots one mark per row, so there is nothing
    // to group — building a frame for it would be wasted work on every render.
    if (this.spec?.data === 'rows') {
      this.frame = null;
      this.requestUpdate();
      return;
    }
    const agg = this.aggregate;
    if (!agg || !inst) {
      this.frame = null;
      return;
    }
    this.frame = aggregateRows(this.evaluatedRows(), this.columns, inst.mapping ?? {}, agg, { truncated: this.truncated });
  }

  /** `VizFrame` → the neutral shape the element takes. The adapter boundary. */
  private chartData(): ChartData {
    const f = this.frame;
    if (!f) return { categories: [], series: [] };
    return {
      categories: f.categories.map((c) => c.label),
      series: f.series.map((s) => ({ label: s.label, points: s.points })),
    };
  }

  /**
   * The options actually in force: the template's, with this instance's overrides
   * on top. Every reader below goes through here rather than reaching into
   * `template.viz.options` — see `viz-options.ts` for why the instance stores
   * only its differences.
   */
  private get options(): Record<string, unknown> {
    return effectiveVizOptions(this.template?.viz?.options, this.instance?.vizOptions);
  }

  /** The field a channel is mapped to, or '' when unmapped. */
  private fieldFor(channelKey: string): string {
    return this.instance?.mapping?.[channelKey] ?? '';
  }

  /**
   * The first channel declared with a given `kind`.
   *
   * Derivations below key off the declared KIND rather than off
   * `VisualizationSpec.id`, so this host stays generic: a third-party
   * visualization declaring a `lat`/`lon` pair gets points built for it without
   * this file learning its name.
   */
  private channelOfKind(kind: string): string | null {
    return this.spec?.channels.find((c) => c.kind === kind)?.key ?? null;
  }

  /** Rows → map points, for any visualization declaring `lat` and `lon` channels. */
  private mapPoints(): MapPoint[] {
    const latCh = this.channelOfKind('lat');
    const lonCh = this.channelOfKind('lon');
    if (!latCh || !lonCh) return [];
    const lat = this.fieldFor(latCh);
    const lon = this.fieldFor(lonCh);
    if (!lat || !lon) return [];
    const labelCh = this.channelOfKind('text');
    const weightCh = this.channelOfKind('weight');
    const labelField = labelCh ? this.fieldFor(labelCh) : '';
    const weightField = weightCh ? this.fieldFor(weightCh) : '';
    const num = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const points: MapPoint[] = [];
    for (const r of this.rows) {
      const la = num(r.data[lat]);
      const lo = num(r.data[lon]);
      // A row missing either coordinate is not a point at (0,0) — the Gulf of
      // Guinea is where bad geodata goes to be mistaken for real data.
      if (la === null || lo === null) continue;
      if (la < -90 || la > 90 || lo < -180 || lo > 180) continue;
      const label = labelField ? r.data[labelField] : undefined;
      const weight = weightField ? num(r.data[weightField]) : null;
      points.push({
        lat: la,
        lon: lo,
        ...(label == null || label === '' ? {} : { label: String(label) }),
        ...(weight === null ? {} : { weight }),
      });
    }
    return points;
  }

  /** Rows → ranked terms, for any visualization declaring a `text` channel and no coordinates. */
  private cloudTerms(): CloudTerm[] {
    const textCh = this.channelOfKind('text');
    if (!textCh || this.channelOfKind('lat')) return [];
    const field = this.fieldFor(textCh);
    if (!field) return [];
    const o = this.options;
    const numOpt = (k: string): number | undefined => {
      const n = Number(o[k]);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const keep = parseWordList(typeof o['keepWords'] === 'string' ? (o['keepWords'] as string) : '');
    return wordFrequencies(
      this.rows.map((r) => r.data[field]),
      {
        ...(numOpt('minLength') === undefined ? {} : { minLength: numOpt('minLength') }),
        ...(numOpt('maxTerms') === undefined ? {} : { maxTerms: numOpt('maxTerms') }),
        includeNumbers: o['includeNumbers'] === true,
        // `resolveStopWords` owns the three shapes this can hold — absent, a
        // deliberately empty list, or a boolean from before the option became
        // editable text.
        stopWords: resolveStopWords(o['stopWords']),
        ...(keep.size > 0 ? { keepWords: keep } : {}),
      },
    ).map((t): CloudTerm => ({ term: t.term, count: t.count }));
  }

  /**
   * The channels this visualization actually reads, resolved to their columns.
   *
   * Only channels with a mapping are included: an UNMAPPED required channel is
   * already reported separately, and a blank entry here would read as "the column
   * is empty" when the real problem is that no column was chosen.
   */
  private mappedChannels(): MappedChannel[] {
    const spec = this.spec;
    if (!spec) return [];
    const agg = this.aggregate;
    const out: MappedChannel[] = [];
    for (const ch of spec.channels) {
      const field = this.fieldFor(ch.key);
      if (!field) continue;
      // For an aggregate viz, only the channels the SPEC reads matter. A VALUE
      // channel is irrelevant to a plain `count`, so an empty column there is not
      // why the chart is blank and must not be blamed for it.
      if (spec.data === 'aggregate' && agg) {
        const used = new Set<string>([...(agg.groupBy ?? []), ...(agg.measures ?? []).filter((m) => m.fn !== 'count').map((m) => m.channel)]);
        if (!used.has(ch.key)) continue;
      }
      out.push({ channel: ch.key, label: ch.label, field });
    }
    return out;
  }

  /**
   * "Why is this blank?" — the empty-column case.
   *
   * The aggregator already names a channel pointing at a field no column carries.
   * This is the commoner mistake it cannot see: a column that exists and holds
   * nothing. Both render identically, so both have to say so.
   */
  private emptyNote(): string | null {
    if (this.rows.length === 0) return null; // an empty TABLE is its own obvious case
    return emptyChannelNote(emptyChannels(this.rows, this.columns, this.mappedChannels()), this.rows.length);
  }

  /** Options handed to the element, with app-level settings filled in. */
  private elementOptions(): Record<string, unknown> {
    const o = { ...this.options };
    // A map with no per-instance tile URL falls back to the workspace setting.
    if (this.channelOfKind('lat') && (typeof o['tileUrl'] !== 'string' || (o['tileUrl'] as string).trim() === '')) {
      o['tileUrl'] = this.tileUrl;
      o['attribution'] = this.tileAttribution;
    }
    return o;
  }

  /**
   * The key the host grid publishes and listens under, or null when this
   * visualization is in its own window. The same key `visible-rows.ts` uses, so
   * rows in and requests out travel over one identity.
   */
  private hostKey(): string | null {
    const dock = this.instance?.dock;
    if (!dock) return null;
    return dock.host.kind === 'view' ? dock.host.viewInstanceId : dock.host.tableId;
  }

  /**
   * "Narrow what I am showing" — the pane's half of the two-way street.
   *
   * Docked, the request goes to the HOST GRID (`table/pane-actions.ts`): one
   * filter layer, shown and cleared in the grid's own funnel. A docked pane has
   * a 22px strip and nowhere to display a filter of its own, so a pane-local
   * pill could have been switched on with no way to see or clear it.
   *
   * Two cases have no grid to ask. A pane docked to a view window that renders
   * an HTML template has no `data-table` registered under its key, and a
   * WINDOWED visualization has no host at all; both write the instance's own
   * `pillFilters`, which is the layer a view already filters by and which
   * `loadRows` already applies.
   */
  private onFilterRequest = async (e: Event): Promise<void> => {
    const { field, value } = (e as CustomEvent<VizFilterRequest>).detail;
    const inst = this.instance;
    if (!inst || !field) return;
    const key = this.hostKey();
    if (key && paneFilter(key, field, value)) return;
    // Docked to a table whose grid is gone (minimized) — there is nothing to
    // narrow, and writing our own pill layer would filter rows the grid is still
    // pushing us, so the two would disagree the moment it comes back.
    if (key && inst.dock?.host.kind === 'table') return;
    const target = inst.dock?.host.kind === 'view' ? inst.dock.host.viewInstanceId : inst.id;
    // Read the target's CURRENT pills rather than assuming they are ours: docked
    // to a view, the layer being added to belongs to the view window, and
    // overwriting it would drop every pill already clicked over there.
    const ctx = await getContext();
    const current = target === inst.id ? inst.pillFilters : (await ctx.store.viewInstances.findOne(target))?.pillFilters;
    await persistPillFilters(target, withPillValue(current, field, value));
  };

  /** "Sort what I am showing." Only a host grid can honour this. */
  private onSortRequest = (e: Event): void => {
    const { field, additive } = (e as CustomEvent<VizSortRequest>).detail;
    const key = this.hostKey();
    if (key && field) paneSort(key, field, additive === true);
  };

  private note(): string | null {
    const f = this.frame;
    if (!f) return null;
    const parts: string[] = [];
    if (f.truncated) {
      const t = truncationNote({ shown: f.rowCount, total: this.matchingTotal, searching: this.searching, searched: ROW_FETCH_CAP });
      if (t) parts.push(t);
    }
    if (f.skipped > 0) {
      // Said out loud: a bar that is short because 12 cells could not be read as
      // numbers is indistinguishable from a bar that is genuinely short.
      parts.push(`${f.skipped.toLocaleString()} ${f.skipped === 1 ? 'value was' : 'values were'} not numeric and were left out.`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  override render() {
    if (this.error) return html`<div class="error" role="status">${this.error}</div>`;
    if (!this.loaded) return html`<div class="placeholder">Loading…</div>`;

    const spec = this.spec;
    if (!spec) {
      const kind = this.template?.viz?.kind ?? '?';
      // Mirrors an unregistered cell renderer falling back to text rather than
      // erroring: the plugin may simply be switched off in the Plugin Manager.
      return html`<div class="error" role="status">No visualization registered for “${kind}”. Its plugin may be disabled.</div>`;
    }
    if (spec.data === 'aggregate') {
      if (!this.aggregate) return html`<div class="error" role="status">This visualization has no measure configured.</div>`;
      if (this.frame?.error) return html`<div class="error" role="status">${this.frame.error}</div>`;
    } else {
      const unmapped = spec.channels.filter((c) => c.required && !this.fieldFor(c.key));
      if (unmapped.length > 0) {
        return html`<div class="error" role="status">No column mapped for ${unmapped.map((c) => c.label).join(', ')}.</div>`;
      }
    }

    // An empty mapped column is the commonest reason a chart looks broken, and it
    // is indistinguishable from one. Reported before drawing, because there is
    // nothing to draw and a blank pane teaches the user nothing.
    const empty = this.emptyNote();
    if (empty) return html`<div class="error" role="status">${empty}</div>`;

    // A cloud whose column DOES hold text but yielded no terms is a different
    // problem with a different fix — the word rules, not the mapping.
    if (this.channelOfKind('text') && !this.channelOfKind('lat') && this.rows.length > 0 && this.cloudTerms().length === 0) {
      const o = this.options;
      const minLength = Number(o['minLength']);
      return html`<div class="error" role="status">
        ${noTermsNote({
          minLength: Number.isFinite(minLength) && minLength > 0 ? minLength : 3,
          // Empty list ⇒ nothing is being dropped, so don't blame the stop list.
          stopWordsOn: resolveStopWords(o['stopWords']).size > 0,
          numbersExcluded: o['includeNumbers'] !== true,
        })}
      </div>`;
    }

    const tag = unsafeStatic(spec.tag);
    const note = this.note();
    const opts = this.elementOptions();
    // Every property is set on every kind: a Lit element ignores a property it
    // does not declare, and branching the template per kind would mean this host
    // knowing which kinds exist — the thing `channelOfKind` avoids.
    return html`
      <div class="chart ${spec.bleed ? 'bleed' : ''}" @viz-filter-request=${this.onFilterRequest} @viz-sort-request=${this.onSortRequest}>
        ${staticHtml`<${tag}
          .data=${this.chartData()}
          .points=${this.mapPoints()}
          .terms=${this.cloudTerms()}
          .rows=${this.evaluatedRows()}
          .columns=${this.columns}
          .options=${opts}
        ></${tag}>`}
      </div>
      ${note ? html`<div class="note" role="status">${note}</div>` : nothing}
    `;
  }
}

/**
 * A comparable form of a pill-filter map, so an instance write that changed
 * something else does not read as a filter change.
 *
 * Sorted by field: the map is rebuilt by spread on every click, so its key order
 * follows the order values were clicked in and two identical filter sets could
 * otherwise serialise differently.
 */
function pillKey(pills: Record<string, string> | undefined): string {
  const entries = Object.entries(pills ?? {}).filter(([, v]) => v !== '');
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}
