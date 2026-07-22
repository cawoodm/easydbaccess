/**
 * Single source of truth for the plugin contract.
 *
 * A plugin is a single ES module .js file. The host calls plugin.init(api)
 * once at startup, then plugin.load(api) once the app is ready. Plugins MAY
 * monkey-patch methods on the `api` object to override default behavior; the
 * host treats it as a mutable namespace.
 */

import type { ColumnSpec, PluginRecord, Row, Setting, Table, TableSource, Workspace } from './types.js';

// -- Plugin module shape --------------------------------------------------

export interface PluginModule {
  init?(api: HostApi): void | Promise<void>;
  load?(api: HostApi): void | Promise<void>;
  meta?: {
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    /**
     * Built-in plugins flagged optional are loaded by default but can be
     * disabled from the Plugin Manager. The host stores the disabled state
     * under the synthetic key `builtin:<name>` in the plugins collection.
     */
    optional?: boolean;
  };
}

// -- Events ---------------------------------------------------------------

export interface AppEvents {
  'app:ready': { workspaceId: string };
  'workspace:changed': { workspaceId: string };
  'table:created': { table: Table };
  'table:deleted': { tableId: string };
  'table:rendered': { tableId: string; el: HTMLElement };
  'row:created': { tableId: string; row: Row };
  'row:updated': { tableId: string; row: Row; prev: Row };
  'row:deleted': { tableId: string; rowId: string };
  'drop:files': { files: File[]; event: DragEvent };
  'import:before': { source: string; tableId?: string };
  'import:after': { source: string; tableId: string; rowCount: number };
  'export:before': { format: string; tableId: string };
  'plugin:error': { url: string; phase: 'fetch' | 'init' | 'load' | 'runtime'; error: unknown };
}

export type Unsubscribe = () => void;
export type Unregister = () => void;

export interface EventBus {
  on<K extends keyof AppEvents>(name: K, fn: (e: AppEvents[K]) => void): Unsubscribe;
  emit<K extends keyof AppEvents>(name: K, payload: AppEvents[K]): void;
}

// -- Data store ------------------------------------------------------------

/**
 * Minimal collection contract the plugin API exposes. Plugins should not
 * depend on the underlying storage (currently Dexie); this interface lets us
 * swap storage adapters without breaking plugins.
 */
export interface DataCollection<T> {
  find(query?: Partial<T>): Promise<T[]>;
  findOne(id: string): Promise<T | null>;
  insert(doc: T): Promise<T>;
  /** Batched insert. Always prefer this over a loop of `insert()` in importers. */
  bulkInsert(docs: T[]): Promise<T[]>;
  upsert(doc: T): Promise<T>;
  patch(id: string, patch: Partial<T>): Promise<T>;
  remove(id: string): Promise<void>;
  bulkRemove(ids: string[]): Promise<void>;
  /** Subscribe to changes; returns unsubscribe. */
  subscribe(fn: (docs: T[]) => void): Unsubscribe;
}

export interface DataStore {
  workspaces: DataCollection<Workspace>;
  tables: DataCollection<Table>;
  /** Lazily creates the row collection for a table if it doesn't exist. */
  rows(tableId: string): DataCollection<Row>;
  settings: DataCollection<Setting>;
  plugins: DataCollection<PluginRecord>;
}

// -- Row-source providers (routing seam) ----------------------------------

/**
 * Context handed to a `RowCollectionProvider` when the store instantiates a
 * non-local collection for a sourced table. Deliberately free of DOM/UI
 * surface so providers stay storage-agnostic and unit-testable:
 *  - `backend.fetch` is the CORS-aware fetch (direct, or proxied through the
 *    Hono `/fetch` route when a sync server is configured).
 *  - `events` lets a provider emit `row:*` events on remote mutations.
 *  - `settings` exposes device-local settings (thresholds, connection refs)
 *    — never the workspace dump, so tokens stay off synced data.
 */
export interface RowSourceCtx {
  backend: Backend;
  events: EventBus;
  settings: DataCollection<Setting>;
  workspaceId(): string | null;
}

/**
 * Backs certain tables with a non-local row collection (e.g. a live remote
 * database). Registered via `HostApi.registerRowSource`. When a Table carries
 * a `source` descriptor whose `type` equals this provider's `type`, the store
 * routes `rows(tableId)` to `create(table, ctx)` instead of the default local
 * (Dexie) collection. Tables without a matching `source` are never routed, so
 * registering a provider cannot change how existing local tables behave.
 */
export interface RowCollectionProvider {
  /** Matched against `TableSource.type`. */
  type: string;
  create(table: Table, ctx: RowSourceCtx): DataCollection<Row>;
}

/** Re-export so downstream code can import the descriptor from the contract. */
export type { TableSource };

// -- UI slot registries ---------------------------------------------------

export interface ButtonSpec {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  order?: number;
  /** Visual prominence. `primary` is reserved for the main CTA in a slot. */
  variant?: 'primary';
  onClick(api: HostApi): void | Promise<void>;
}

export interface TableButtonSpec {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  order?: number;
  onClick(api: HostApi, ctx: { tableId: string }): void | Promise<void>;
}

export interface ImporterSpec {
  id: string;
  label: string;
  /** File extensions or MIME types this importer accepts. */
  accept: string[];
  parse(
    input: File | string,
  ): Promise<{ columns: ColumnSpec[]; rows: Array<Record<string, unknown>> }>;
}

export interface ExporterSpec {
  id: string;
  label: string;
  extension: string;
  serialize(table: Table, rows: Row[]): Promise<Blob | string>;
}

export type DropHandler = (event: DragEvent, api: HostApi) => Promise<boolean> | boolean; // return true if handled

export interface UrlSourceSpec {
  id: string;
  label: string;
  /** Called when the user invokes this URL source; should add rows via the api. */
  run(api: HostApi, opts: { url?: string }): Promise<void>;
}

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface ToastOpts {
  kind?: ToastKind | undefined;
  title?: string | undefined;
  /** Auto-dismiss after this many ms. Defaults: 4000 for info/success, 7000 for warning/error. */
  durationMs?: number | undefined;
}

/**
 * Promise-returning replacements for the native window.alert/prompt/confirm.
 * Plugins should use these instead of touching window.* so behavior stays
 * consistent across browser and Electron (where native dialogs may differ)
 * and so plugins are testable without intercepting global modals.
 */
export interface Dialogs {
  /** Modal message + OK button. Resolves when dismissed. */
  alert(message: string, title?: string): Promise<void>;
  /** Modal Yes/No question. Resolves to true if confirmed, false otherwise. */
  confirm(message: string, title?: string): Promise<boolean>;
  /** Modal text input. Resolves to the entered string, or null if cancelled. */
  prompt(message: string, defaultValue?: string, title?: string): Promise<string | null>;
  /**
   * Modal vertical button list. Each option becomes a button labelled with
   * the string. Resolves to the chosen option, or null if cancelled.
   * Useful for "Append / Overwrite / Cancel"-style decisions.
   */
  choice(message: string, options: string[], title?: string): Promise<string | null>;
  /**
   * Non-modal status notification stacked at the top of the workspace. Auto-
   * dismisses; use kind='error'/'warning' for sticky-ish (7s) messages.
   */
  toast(message: string, opts?: ToastOpts): void;
}

export interface UiRegistry {
  registerHeaderButton(spec: ButtonSpec): Unregister;
  registerFooterButton(spec: ButtonSpec): Unregister;
  registerTableButton(spec: TableButtonSpec): Unregister;
  /**
   * Register a cell renderer under a name. Columns opt in to it by setting
   * `column.renderer` to this name (independent of the column's data type).
   * `tag` is the custom element name (must contain a hyphen). The element
   * receives `value` and `column` properties and dispatches a `change` event
   * with `{ detail: { value } }` on edit. Columns without a renderer (or
   * pointing at an unregistered name) fall back to read-only text.
   *
   * The element MAY also receive a `row` property (the full row's
   * `data` object) for renderers that need neighbouring fields — for
   * example the built-in `script` renderer. Renderers that only care
   * about a single value can ignore it.
   */
  registerCellRenderer(name: string, tag: string): Unregister;
  registerRowRenderer(viewName: string, tag: string): Unregister;
  registerTableRenderer(viewName: string, tag: string): Unregister;
  registerImporter(spec: ImporterSpec): Unregister;
  registerExporter(spec: ExporterSpec): Unregister;
  registerDropHandler(fn: DropHandler): Unregister;
  registerUrlSource(spec: UrlSourceSpec): Unregister;
  /** Opens the shell's "new table" dialog. Plugins use this to drive table creation. */
  openNewTableDialog(): void;
  /** Opens the shell's "paste CSV" dialog. */
  openCsvPasteDialog(): void;
  /** Opens the Plugin Manager dialog (add/disable third-party plugin URLs). */
  openPluginManager(): void;
  /** Promise-based alert/prompt/choice replacements for the native window.* APIs. */
  dialogs: Dialogs;
}

// -- Window manager -------------------------------------------------------

export interface WindowSpec {
  id: string;
  title: string;
  content: HTMLElement;
  geometry?: Partial<{ x: number; y: number; w: number; h: number }>;
  resizable?: boolean;
  closable?: boolean;
}

export interface WindowHandle {
  id: string;
  close(): void;
  focus(): void;
  setTitle(title: string): void;
  setGeometry(g: Partial<{ x: number; y: number; w: number; h: number }>): void;
}

export interface WindowManager {
  open(spec: WindowSpec): WindowHandle;
  list(): WindowHandle[];
  find(id: string): WindowHandle | null;
}

// -- Backend access -------------------------------------------------------

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  /** Maximum response size in bytes; backend enforces a hard ceiling too. */
  maxBytes?: number;
}

export interface Backend {
  /** URL fetch that works in both modes — proxied through Hono in the browser. */
  fetch(url: string, opts?: FetchOpts): Promise<Response>;
  /**
   * Save bytes/text to a file the user picks. Browser mode triggers a download;
   * Electron mode will route through a native save dialog. Plugins should call
   * this instead of constructing their own <a download> so behavior stays
   * consistent across browser and desktop.
   */
  saveFile(filename: string, body: Blob | string, mimeType?: string): Promise<void>;
}

// -- The HostApi the plugin receives --------------------------------------

export interface HostApi {
  store: DataStore;
  events: EventBus;
  ui: UiRegistry;
  windows: WindowManager;
  backend: Backend;
  /**
   * Register a provider that backs `source`-carrying tables with a non-local
   * row collection (e.g. a live remote database). Returns an unregister fn.
   * This is a data-layer seam, not a UI slot — hence it sits on the HostApi
   * rather than `ui`. Tables without a matching `source` are unaffected.
   */
  registerRowSource(provider: RowCollectionProvider): Unregister;
  /** The current workspace id, when one is selected. */
  workspaceId(): string | null;
  /** Plugin's own URL — useful for relative resource loads. */
  selfUrl(): string;
}
