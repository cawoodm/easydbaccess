export type ColumnType = 'string' | 'number' | 'date' | 'datetime' | 'boolean';

export interface ColumnSpec {
  field: string;
  label: string;
  type: ColumnType;
  /**
   * Optional cell renderer name. Looked up in `registries.cellRenderers` at
   * render time. When unset (or no matching renderer is registered), cells
   * render as read-only HTML-encoded text. Independent of `type`, which
   * still drives coercion / sort / validation / SQL typing.
   */
  renderer?: string;
  /**
   * Source for the `script` renderer — a JavaScript body that must define
   * `function render(row) { … }`. Edited via the column editor pencil and
   * ignored when `renderer !== 'script'`. Not part of the CSV mini-language.
   */
  script?: string;
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
}

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
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
  sortColumn?: string | undefined;
  sortAsc?: boolean | undefined;
  filters?: Record<string, string> | undefined;
  /** Non-local backing store; absent ⇒ ordinary local table (unchanged behaviour). */
  source?: TableSource | undefined;
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
}

export interface Row {
  id: string;
  tableId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

/**
 * A workspace-global display template — three HTML fragments that decide how a
 * table's data is shown in a read-only view window.
 *
 * If `rowHtml` is blank the view falls back to a read-only columns table with
 * `headerHtml` above and `footerHtml` below. If `rowHtml` is present, no table
 * is drawn: `rowHtml` is repeated once per row (between header and footer) with
 * `$TOKEN` placeholders substituted from the row's mapped columns.
 */
export interface ViewTemplate {
  id: string;
  workspaceId: string;
  name: string;
  headerHtml: string;
  rowHtml: string;
  footerHtml: string;
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
  sortColumn?: string | undefined;
  sortAsc?: boolean | undefined;
  /** Column-field → filter substring, snapshotted from the table. */
  filters: Record<string, string>;
  /** Column fields to show, in order (snapshotted from the table). */
  visibleColumns: string[];
  /** Template token (without the leading `$`) → column field. */
  mapping: Record<string, string>;
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
   * plugin can reopen open windows on boot (jsPanel itself has no cross-reload
   * memory — table windows are likewise re-created from persisted state).
   */
  open?: boolean | undefined;
  /** Max rows to show (TOP N). Absent or ≤0 ⇒ show all. */
  limit?: number | undefined;
  updatedAt: number;
}

export interface PluginRecord {
  url: string;
  enabled: boolean;
  lastFetched: number;
  cachedBody?: string;
  lastError?: string;
}
