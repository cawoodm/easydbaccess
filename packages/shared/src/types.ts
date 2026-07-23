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
  updatedAt: number;
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

export interface PluginRecord {
  url: string;
  enabled: boolean;
  lastFetched: number;
  cachedBody?: string;
  lastError?: string;
}
