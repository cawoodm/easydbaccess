/**
 * `array` is a cell holding SEVERAL values — `foo,bar,baz`, `["Foo","Bar"]`, or
 * a real JS array. The stored value is never rewritten; the type only tells the
 * reader (filter matcher, funnel dropdown, renderer) to take the cell apart into
 * its members. See `array-cell.ts` for the three spellings.
 */
/**
 * `text` is prose — a description, a body, an abstract. It is stored exactly as
 * `string` is (same SQL affinity, same coercion); the type exists so the FILTER
 * can behave differently. A funnel offers no value list for a text column: every
 * cell is unique and too long to browse, so the list would be one useless option
 * per row. Import assigns it — see `text-column.ts` for the rule.
 */
export type ColumnType = 'string' | 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'array';

export interface ColumnSpec {
  field: string;
  label: string;
  type: ColumnType;
  /**
   * Optional cell renderer name. Looked up in `registries.cellRenderers` at
   * render time. When unset (or no matching renderer is registered), a cell
   * in the interactive grid falls back to a plain editable input showing the
   * raw stored value (a read-only-text fallback only applies inside a
   * read-only view). Independent of `type`, which still drives coercion /
   * sort / validation / SQL typing.
   */
  renderer?: string;
  /**
   * A JavaScript body that must define `function render(row) { … }`, edited via
   * the column editor's script button. Settable on ANY column: the return value
   * replaces the stored value on its way into `renderer`, so a computed value
   * can be displayed by the link / image / html / boolean renderers, or as text
   * when no renderer is set. A scripted cell is read-only — it is derived, so
   * there is nowhere to write an edit back to.
   *
   * Not part of the CSV mini-language.
   */
  script?: string;
  /**
   * A JavaScript body that must define `function validate(value, row) { … }`,
   * edited via the column editor's second pencil (right of `max`). Run on a
   * MANUAL cell edit only, after the declarative constraints below have
   * passed: **throwing rejects the edit**, and the thrown message is what the
   * user is shown. Returning anything is ignored — a validator that has
   * nothing to say simply returns.
   *
   * Bulk writes (import, refresh, sync) deliberately do not run it: they are
   * not edits, and half-importing a table because row 4 000 fails a rule is
   * worse than importing it and showing the rule's verdict in the grid.
   *
   * Not part of the CSV mini-language.
   */
  validate?: string;
  default?: unknown;
  max?: number;
  unique?: boolean;
  notnull?: boolean;
  /** When true, the column is excluded from the rendered table (data preserved). */
  hidden?: boolean;
  /** Persisted pixel width applied via the data-table's <colgroup>. */
  width?: number;
  /**
   * Human description of the column (e.g. from Datasette `columns` metadata).
   * Shown as a header tooltip. Presentation only.
   */
  description?: string;
  /**
   * Unit of the column's values (e.g. from Datasette `units` metadata, "metres").
   * Shown alongside the header label. Presentation only.
   */
  units?: string;
  /**
   * When explicitly false, the grid does not let the user sort by this column
   * (e.g. a column outside Datasette's `sortable_columns` allowlist). Absent ⇒
   * sortable, preserving existing behaviour.
   */
  sortable?: boolean;
  /**
   * When explicitly false, the grid does not let the user filter or free-text
   * search this column (no funnel button; the field is skipped by table and
   * global search). Absent ⇒ filterable, preserving existing behaviour.
   */
  filterable?: boolean;
  /**
   * When true, the grid shows this column without an editor (display value
   * only). Generalises the existing "scripted cells are read-only" behaviour to
   * an explicit flag; a Projection sets it on its computed and secondary-source
   * columns, which cannot be written back. Absent/false ⇒ editable as before.
   */
  readonly?: boolean;
}

/**
 * One key of a multi-column sort: which column, ascending or not. A list of
 * these is applied in order — the second key only decides rows the first ties on.
 */
export interface SortSpec {
  field: string;
  asc: boolean;
}

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  /**
   * The window is collapsed to its titlebar ("smallified"), content and footer
   * folded away. `w`/`h` stay the PRE-collapse size — the header-only height is
   * below the sanitizer's minimum, so storing it would make the whole record
   * look corrupt. Absent/false ⇒ the window is unfolded.
   */
  smallified?: boolean;
  /**
   * The window was closed by the user, hiding the table without deleting it.
   * A closed table keeps all its data and is reopened from the command palette
   * ("Go to <table>"); permanent deletion is a separate, explicit action.
   * Absent/false ⇒ the window is shown.
   */
  closed?: boolean;
}

/**
 * What a new workspace takes over from the one it was created in.
 *
 *  - `all` — tables with their rows, view templates and instances, settings and
 *    the plugin list. A working copy to experiment in.
 *  - `settings` — settings and the plugin list only: same server, same token,
 *    same plugins, no data.
 *  - `empty` — nothing at all.
 *
 * Device-local `user` settings are never involved: they live outside the store
 * and are global to the device by design.
 */
export type CloneMode = 'all' | 'settings' | 'empty';

/** How much a workspace holds. The delete confirmation quotes these numbers. */
export interface WorkspaceContents {
  tables: number;
  /** `-1` when nobody paid for the count — see `EdbStore.countWorkspaceContents`. */
  rows: number;
  views: number;
  templates: number;
  settings: number;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  pluginUrls: string[];
  /**
   * Optional display title shown in the app header and workspace selector.
   * Presentation only — `id`/`name` remain the technical identifiers used for
   * `?space=` routing. Absent/empty ⇒ the header shows "easyDBAccess".
   */
  title?: string | undefined;
}

/**
 * Optional backing-store descriptor for a table. Absent ⇒ the table is a
 * plain local (Dexie) table and behaves exactly as it always has. When
 * present, the routed DataStore hands `rows(tableId)` to the
 * `RowCollectionProvider` registered for `type` (see plugin-api.ts), letting
 * a plugin back the table with live remote data instead of IndexedDB.
 */
export interface TableSource {
  /** Provider key, matched against a registered `RowCollectionProvider.type` (e.g. 'datasette'). */
  type: string;
  /** Provider-specific connection/config, e.g. `{ base, db, table, pks, connectionId }`. */
  config: Record<string, unknown>;
  /** Resolved write capability; absent ⇒ unknown/treated read-only until probed. */
  writable?: boolean | undefined;
  /**
   * When true, the grid skips its in-memory sort/filter because the provider
   * applies them server-side and the snapshot is only the current window.
   * Absent/false ⇒ the grid sorts/filters the full snapshot as usual.
   */
  serverQuery?: boolean | undefined;
}

/**
 * A "Projection": a virtual table whose rows are DERIVED from one or more other
 * tables (a database view / JOIN). Stored as the `config` of a table's
 * `source` descriptor (`source.type === 'projection'`); the `projection`
 * `RowCollectionProvider` computes the rows on demand and keeps them live.
 *
 * The projection's own `Table.columns` are COMPILED from `columns` below at
 * save time (so the grid, exports and views treat it like any table). The spec
 * here is the editable source of truth the projection editor round-trips.
 */
export interface ProjectionSpec {
  version: 1;
  /** FROM + JOINs. `sources[0]` is the base (FROM) table. */
  sources: ProjectionSource[];
  /** SELECT list; array order is display order. */
  columns: ProjectionColumn[];
  /**
   * Optional WHERE, keyed by OUTPUT field. Reuses the existing filter-substring
   * shape (`Record<field, substring>`), applied to the joined rows.
   */
  filters?: Record<string, string> | undefined;
  /**
   * Cap on how many rows the projection yields (TOP N), applied after the join
   * and filters. Absent or ≤ 0 ⇒ every row. Mirrors `ViewInstance.limit`, and is
   * what the SQL export renders as `SELECT TOP n`.
   */
  limit?: number | undefined;
}

/** One table participating in a projection: the base, or a JOIN onto it. */
export interface ProjectionSource {
  /** Qualifies this source's columns (e.g. "orders"); unique within the spec. */
  alias: string;
  /**
   * The source table, bound by NAME and by name ONLY.
   *
   * There used to be a `tableId` alongside this as a "fast-path hint". It is
   * gone on purpose. A projection has to survive its source being deleted and
   * re-imported — the ordinary refresh loop for anything coming from a URL or
   * a Datasette instance — and a re-imported table is a NEW row with a new id
   * under the same name. Carrying the old id meant every spec accumulated a
   * value that was wrong more often than it was right, and any code that
   * trusted it before falling back to the name silently resolved to nothing.
   * The name is the contract; renames propagate into the specs that reference
   * them (see the columns editor's `submit`).
   */
  tableName: string;
  /** Absent for `sources[0]`; present for each JOIN. */
  join?:
    | {
        type: 'inner' | 'left';
        /**
         * Equijoin keys: this source's `field` must equal the already-introduced
         * source `eqAlias`'s `eqField`. Multiple entries are ANDed.
         */
        on: Array<{ field: string; eqAlias: string; eqField: string }>;
      }
    | undefined;
}

/**
 * One output column of a projection (the SELECT list). This says only WHICH
 * value the column carries — everything about how it LOOKS (label, type,
 * renderer, width, hidden, constraints) lives on the projection table's own
 * `columns`, inherited once from the source table and thereafter edited with the
 * ordinary column editor like any table's.
 */
export interface ProjectionColumn {
  /** Output field name; unique within the spec. Keys the table's ColumnSpec. */
  field: string;
  /** Legacy seed values from specs written before presentation moved to the table. */
  label?: string | undefined;
  type?: ColumnType | undefined;
  from: /** A real stored column of a source — the only writeback candidate. */
    | { kind: 'source'; alias: string; field: string }
    /** Computed via `function render(row) { … }` — always read-only. */
    | { kind: 'script'; script: string };
}

export interface Table {
  id: string;
  workspaceId: string;
  name: string;
  code: string;
  /**
   * Optional display title shown in the panel window title. Presentation only —
   * references (views, exports, filenames) always use the technical `name`.
   * Absent/empty ⇒ the panel shows `name`.
   */
  title?: string | undefined;
  columns: ColumnSpec[];
  view: string;
  windowGeometry?: WindowGeometry | undefined;
  /**
   * Primary sort, kept for everything that reads a single sort (view windows,
   * exports, older workspaces). Always mirrors `sortBy[0]` when that is set.
   */
  sortColumn?: string | undefined;
  sortAsc?: boolean | undefined;
  /**
   * Sort keys in priority order — first is primary, the next break its ties.
   * Absent ⇒ fall back to `sortColumn`/`sortAsc`, so a workspace written before
   * multi-sort keeps sorting exactly as it did.
   */
  sortBy?: SortSpec[] | undefined;
  filters?: Record<string, string> | undefined;
  /** Non-local backing store; absent ⇒ ordinary local table (unchanged behaviour). */
  source?: TableSource | undefined;
  /**
   * The table is read-only: the grid shows values without editors and offers no
   * add/delete row. Set automatically on a reference table (its rows live at the
   * source and every write throws anyway), and toggleable per table in the
   * column editor for a local table someone wants to protect.
   *
   * Presentation + intent only — it is not a security boundary. A plugin writing
   * straight to the store still can; the row source is what actually refuses.
   * Absent/false ⇒ editable, as before.
   */
  readonly?: boolean | undefined;
  /**
   * Where a *snapshot* table's rows were imported from, so it can be refreshed
   * (re-fetched) later. Unlike `source`, this does NOT route reads to a remote
   * — the rows live locally; `origin` just records how to re-pull them. Absent
   * for live (`source`) tables and hand-made local tables.
   */
  origin?: TableOrigin | undefined;
  /**
   * Human-facing table metadata (e.g. from Datasette's description / source /
   * license / about). Presentation only — surfaced via the (i) button in the
   * window title. Absent ⇒ no info button shown.
   */
  info?: TableInfo | undefined;
  /**
   * The column that best labels a row (e.g. Datasette's `label_column`). Used
   * as the default mapping for a view template's title/name token. Absent ⇒ no
   * designated label.
   */
  labelColumn?: string | undefined;
  /**
   * Fields the user explicitly removed via the column editor. A re-import or
   * refresh must NOT re-add these, even though the source still returns them —
   * otherwise a deleted column reappears on every refresh. Cleared for a field
   * if the user later re-adds a column with that name.
   */
  deletedColumns?: string[] | undefined;
  /**
   * Set when a snapshot import stopped part-way (e.g. the source rate-limited
   * us): the cursor to resume paging from and how many rows already landed. The
   * footer shows a red "resume" button while this is present; a completed import
   * clears it. Absent ⇒ the import finished (or never started).
   */
  importResume?: ImportResume | undefined;
  updatedAt: number;
}

/** Where an interrupted snapshot import should pick back up. */
export interface ImportResume {
  /** The backend page URL to resume fetching from (the hop that was interrupted). */
  nextUrl: string;
  /** Rows already imported before the interruption — the append offset + progress base. */
  loadedRows: number;
  /** Known total row count, when the source reported one, for a proportional bar. */
  totalCount?: number | undefined;
}

/** Descriptive table metadata shown in the window's info dialog. */
export interface TableInfo {
  description?: string;
  descriptionHtml?: string;
  source?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
  about?: string;
  aboutUrl?: string;
}

/** Records the backend a snapshot table was imported from, for later refresh. */
export interface TableOrigin {
  /** Backend kind, e.g. 'datasette'. */
  type: string;
  /** Canonical source URL to re-import from (e.g. a Datasette table URL). */
  url: string;
  /**
   * Remote primary-key column field name(s), when the source reported them. A
   * "copy" refresh matches its current local rows to the freshly-fetched remote
   * rows by these keys, so values in columns the user ADDED locally survive the
   * refresh (and rows deleted locally return). Absent ⇒ refresh falls back to
   * wipe-and-replace, with no per-row preservation.
   */
  pks?: string[] | undefined;
}

export interface Row {
  id: string;
  tableId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

/**
 * One stored setting of ONE workspace. Settings belong to a workspace and travel
 * with it on export/import; the only device-global layer is the `user` one, which
 * lives outside this collection (see `db/user-settings.ts`).
 *
 * `key` is the physical primary key `<workspaceId>::<name>` — two workspaces hold
 * the same `name` at the same time. Plugins never build it: they address settings
 * by `name` through `store.settings`, which is scoped to the active workspace.
 */
export interface Setting {
  /** The logical name a plugin uses, e.g. `gist-sync:gist_token`. */
  name: string;
  value: unknown;
  /** Physical primary key `<workspaceId>::<name>` — filled in by the store. */
  key?: string;
  /** Owning workspace — filled in by the store, from the active workspace. */
  workspaceId?: string;
}

/** How a group of rows collapses into one number. */
export type VizMeasureFn = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';

/** Bucket width for a `date`/`datetime` group key. */
export type VizBinUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * How rows collapse into the categories and series a visualization plots.
 *
 * Keyed by CHANNEL, never by field: the channel → field indirection lives in
 * `ViewInstance.mapping`, so one template works on any table whose columns can
 * be mapped onto it. That is the whole reason a viz is a kind of View — the
 * mapping record already existed for `$TOKEN`s.
 */
export interface VizAggregate {
  /** Group by these channel keys, in order. Empty ⇒ one group (a single number). */
  groupBy: string[];
  /** One measure per series drawn. */
  measures: Array<{ channel: string; fn: VizMeasureFn }>;
  /**
   * Bucket a numeric or date group key instead of grouping on exact values.
   * `width` applies to numbers, `unit` to dates; a spec carrying neither bins
   * nothing.
   */
  bin?: { channel: string; width?: number | undefined; unit?: VizBinUnit | undefined } | undefined;
  /** Keep the top N groups by the first measure; the rest fold into "Other". */
  topN?: number | undefined;
  sort?: 'category' | 'value' | 'valueDesc' | undefined;
}

/**
 * What ONE VIEW may differ on, over and above the template's `VizAggregate`.
 *
 * Deliberately three named fields rather than `Partial<VizAggregate>`. `groupBy`,
 * `measures[].channel` and `bin` are STRUCTURE — they say which channel means
 * what — and a view that restructured them would no longer be a view of the same
 * chart; it would be a different chart wearing its name. What genuinely varies
 * per table is the question asked of the value column (count these, sum those),
 * the order, and how many groups are worth showing.
 *
 * Absent keys inherit, and an absent object inherits everything — the same
 * delta rule `vizOptions` follows, and for the same reason: a stored full copy
 * would silently stop tracking later edits to the definition.
 */
export interface VizAggregateOverride {
  /** Replaces the function on every measure. */
  fn?: VizMeasureFn | undefined;
  sort?: 'category' | 'value' | 'valueDesc' | undefined;
  /** 0 ⇒ show every group; that is a real choice, not "unset". */
  topN?: number | undefined;
}

/** The drawing half of a viz template: which visualization, and how configured. */
export interface VizSpec {
  /** Which registered visualization draws this — a `VisualizationSpec.id`. */
  kind: string;
  /** How rows become series. Absent ⇒ the visualization's `defaultAggregate`. */
  aggregate?: VizAggregate | undefined;
  /** Values for the visualization's declared `options`, keyed by field key. */
  options?: Record<string, unknown> | undefined;
}

/**
 * Where a view instance is shown. Absent ⇒ its own floating window, which is
 * what every instance did before visualizations existed.
 *
 * `host` is deliberately explicit rather than implied by `ViewInstance.tableId`.
 * They are usually the same table, but not always, and the difference is the
 * interesting case: a chart OF a projection docked INTO the raw table's window
 * is how a KPI strip gets built.
 */
export interface ViewDock {
  host: { kind: 'table'; tableId: string } | { kind: 'view'; viewInstanceId: string };
  edge: 'above' | 'below';
  /** Pane height in px, written by the splitter drag. */
  size: number;
  /** Order among the panes on the same edge, ascending. */
  order: number;
}

/**
 * A workspace-global display template. Two kinds, discriminated by `kind`:
 *
 * - `'html'` (the default, and every template that predates visualizations) —
 *   three HTML fragments. If `rowHtml` is blank the view falls back to a
 *   read-only columns table with `headerHtml` above and `footerHtml` below. If
 *   `rowHtml` is present, no table is drawn: it repeats once per row with
 *   `$TOKEN` placeholders substituted from the row's mapped columns.
 * - `'viz'` — draws instead of laying out HTML. `viz` carries the spec and the
 *   three HTML fields stay `''`.
 */
export interface ViewTemplate {
  id: string;
  workspaceId: string;
  name: string;
  headerHtml: string;
  rowHtml: string;
  footerHtml: string;
  /** Absent ⇒ `'html'`. No migration: an existing template is already valid. */
  kind?: 'html' | 'viz' | undefined;
  /** Present when `kind === 'viz'`. */
  viz?: VizSpec | undefined;
  /** True for templates seeded by the app (e.g. the default RSS feed). */
  builtin?: boolean | undefined;
  updatedAt: number;
}

/**
 * A view of ONE table through a `ViewTemplate`, shown read-only in its own
 * window. Snapshots the table's sort / filter / visible-columns at creation and
 * maps the template's `$TOKEN`s to the table's column fields. Templates are
 * global to the workspace; instances are tied to a single table.
 */
export interface ViewInstance {
  id: string;
  workspaceId: string;
  tableId: string;
  /**
   * The bound table's name, snapshotted when the view was created and kept in
   * sync while the table exists. Lets a view reconnect to a same-named table
   * after the original is deleted and recreated (which mints a fresh
   * `tableId`). See `window-mgr/view-window-manager.ts`.
   */
  tableName?: string | undefined;
  templateId: string;
  name: string;
  /** Primary sort — mirrors `sortBy[0]`; see the same fields on `Table`. */
  sortColumn?: string | undefined;
  sortAsc?: boolean | undefined;
  /** Sort keys in priority order; absent ⇒ use `sortColumn`/`sortAsc`. */
  sortBy?: SortSpec[] | undefined;
  /** Column-field → filter substring, snapshotted from the table. */
  filters: Record<string, string>;
  /**
   * The pill-filter layer: field → column-filter string, built by clicking
   * `$filter.TOKEN` pills in the template. Kept SEPARATE from `filters` (which
   * is snapshotted from the table) so the view's header bar can list only what
   * the user clicked. Both layers apply, ANDed.
   */
  pillFilters?: Record<string, string> | undefined;
  /** Column fields to show, in order (snapshotted from the table). */
  visibleColumns: string[];
  /** Template token (without the leading `$`) → column field. */
  mapping: Record<string, string>;
  /**
   * Template token → a script that computes what the token SHOWS, in the same
   * `function render(row) { … }` shape a column script uses.
   *
   * This is how a view formats a value it must not change in the table:
   * `markdownToHtml(row.body)`, or a date as the reader's locale wants it. The
   * script's result is substituted as-is (the template is raw HTML anyway), so a
   * script may return markup.
   *
   * Only a plain `$TOKEN` runs it. An `$input.TOKEN` writes back to the cell and
   * a `$filter.TOKEN`'s text must equal the stored value to match anything, so
   * both keep reading the mapped field. A scripted token needs no mapping at all
   * — it can compute from the whole row.
   */
  tokenScripts?: Record<string, string> | undefined;
  /**
   * Template token → true when the token must show PLAIN TEXT rather than go
   * through the mapped column's cell renderer.
   *
   * A `$TOKEN` renders like the grid's cell by default, so a view of a `link`
   * column shows links and a `tags` column shows pills without the template
   * saying so. Absent (the normal case) ⇒ rendered. This is the mapping dialog's
   * per-token toggle; `$raw.TOKEN` says the same thing in the template itself.
   */
  tokenRaw?: Record<string, boolean> | undefined;
  /**
   * When false, the template is bypassed and the view shows the data in the
   * standard interactive grid (sort / filter / show-hide / reorder columns),
   * with those presentation choices stored on THIS instance rather than the
   * underlying table. Absent/true ⇒ render through the template. DB-level column
   * definitions (uniqueness, notnull, defaults, max) are never edited from a view.
   */
  templateEnabled?: boolean | undefined;
  /** Per-column pixel widths for the grid (template-off mode), field → width. */
  columnWidths?: Record<string, number> | undefined;
  windowGeometry?: WindowGeometry | undefined;
  /**
   * Whether this view's window is currently open. Persisted so the `views`
   * plugin can reopen open windows on boot (the panel shell itself has no
   * cross-reload memory — table windows are likewise re-created from
   * persisted state).
   *
   * With a `dock` set this means the same thing for a docked pane: shown or not.
   * One flag, one reconciler — see `window-mgr/view-window-manager.ts`.
   */
  open?: boolean | undefined;
  /**
   * Docked above/below a host panel instead of floating in its own window.
   * Absent ⇒ own window, which is what every instance did before this existed.
   */
  dock?: ViewDock | undefined;
  /**
   * Per-instance overrides of the viz template's `options`, merged OVER them.
   *
   * The template is the shared definition — one "Top words" chart used against
   * five tables — and the options that matter most in practice are the ones that
   * differ per table: which words to ignore in THIS column, how short is too
   * short for THIS data. Without this layer the only way to vary one option was
   * to copy the whole template.
   *
   * Only keys the user actually changed are stored. A key absent here inherits
   * from the template and keeps inheriting when the template is edited, which is
   * the whole point of it being a layer rather than a copy.
   */
  vizOptions?: Record<string, unknown> | undefined;
  /**
   * This view's aggregate overrides — the measure, the order and the group cap.
   *
   * The same layer `vizOptions` is, for the part of the definition that is not an
   * "option": a template says "count rows per category" and one view of it can
   * say "sum the amount instead" without forking the template. Only the keys the
   * user actually changed are stored; see {@link VizAggregateOverride}.
   */
  vizAggregate?: VizAggregateOverride | undefined;
  /** Max rows to show (TOP N). Absent or ≤0 ⇒ show all. */
  limit?: number | undefined;
  /**
   * When true, the grid (template-off) view is read-only: cells display their
   * values with no editors (no date picker, disabled checkboxes). Absent/false
   * ⇒ the grid is editable, as normal. Set from the "Readonly" option when
   * creating/editing the view.
   */
  readonly?: boolean | undefined;
  updatedAt: number;
}

export interface PluginRecord {
  url: string;
  enabled: boolean;
  lastFetched: number;
  cachedBody?: string;
  lastError?: string;
}
