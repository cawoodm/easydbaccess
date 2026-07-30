/**
 * Single source of truth for the plugin contract.
 *
 * A plugin is a single ES module .js file. The host calls plugin.init(api)
 * once at startup, then plugin.load(api) once the app is ready. Plugins MAY
 * monkey-patch methods on the `api` object to override default behavior; the
 * host treats it as a mutable namespace.
 */

import type {
  ColumnSpec,
  PluginRecord,
  Row,
  Setting,
  Table,
  TableSource,
  ViewInstance,
  ViewTemplate,
  Workspace,
} from './types.js';

// -- Plugin module shape --------------------------------------------------

/**
 * Broad functional category a plugin belongs to. Drives the Plugin Manager's
 * "by type" filter. A plugin declares its single primary type via `meta.type`.
 */
export type PluginType = 'importer' | 'exporter' | 'cell-renderer' | 'sync' | 'source' | 'ui';

export interface PluginModule {
  init?(api: HostApi): void | Promise<void>;
  load?(api: HostApi): void | Promise<void>;
  meta?: {
    /** Kebab-case technical id. Stable — used as the `builtin:<id>` disabled-state key. */
    id: string;
    /** Human-readable display name. */
    name: string;
    /** Primary functional category — powers the "by type" filter in the Plugin Manager. */
    type?: PluginType;
    version?: string;
    description?: string;
    author?: string;
    /** Inline `<svg>` markup shown next to the plugin in the manager UI. */
    icon?: string;
    /** GitHub URL to this plugin's source file. */
    repo?: string;
    /**
     * Always-on & non-disableable. Fixed plugins are never shown with a
     * toggle in the Plugin Manager and the loader never skips them. Every
     * other built-in is user-toggleable and defaults to enabled; the host
     * stores the disabled state under the synthetic key `builtin:<id>` in
     * the plugins collection.
     */
    fixed?: boolean;
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
  /**
   * Optional: force a re-read from the backing store and notify subscribers.
   * Local (Dexie) collections are always live so they don't implement it;
   * remote-backed collections (e.g. Datasette) that cache reads expose it so a
   * user "Refresh" can bypass the cache. Callers must feature-detect it.
   */
  refresh?(): Promise<void>;
}

export interface DataStore {
  workspaces: DataCollection<Workspace>;
  tables: DataCollection<Table>;
  /** Lazily creates the row collection for a table if it doesn't exist. */
  rows(tableId: string): DataCollection<Row>;
  settings: DataCollection<Setting>;
  plugins: DataCollection<PluginRecord>;
  /** Workspace-global display templates (header/row/footer HTML). */
  viewTemplates: DataCollection<ViewTemplate>;
  /** Per-table view instances rendered read-only in their own windows. */
  viewInstances: DataCollection<ViewInstance>;
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
  /**
   * Visual prominence. `primary` is reserved for the main CTA in a slot.
   * `secondary` renders as a muted icon-only button; in the header it is pinned
   * to the far right (used for utility actions like Settings).
   */
  variant?: 'primary' | 'secondary';
  /**
   * `ctx.anchor` is the button's own DOM element when the host can supply it
   * (header/footer slot buttons) — use it to anchor a popover/menu under the
   * button. Absent otherwise. Optional + additive: existing plugins ignore it.
   */
  onClick(api: HostApi, ctx?: { anchor?: HTMLElement | undefined }): void | Promise<void>;
}

export interface TableButtonSpec {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  order?: number;
  /** Render the button in a red/danger style (e.g. an interrupted-import resume). */
  danger?: boolean;
  /**
   * Optional per-table visibility predicate. Called with the table record;
   * return false to hide the button for that table. Omitted ⇒ always shown.
   */
  visible?(table: Table): boolean;
  onClick(
    api: HostApi,
    ctx: { tableId: string; anchor?: HTMLElement | undefined },
  ): void | Promise<void>;
}

// -- Importers -------------------------------------------------------------
//
// An importer describes ONE data format (csv, json, datasette, sqlite, …). The
// import kernel owns everything common — the dialog, the fetch, the row cap,
// the table picker, the column editor, naming, collision policy, resume,
// refresh and the toasts — and calls into the spec for the format-specific
// parts only. An importer never writes to the store itself.
//
// Design note: `read` returns an async iterable rather than one result, so the
// kernel has a single place to apply the row cap, drive the progress bar, save
// a resume cursor and tolerate a mid-read failure. Single-shot formats (csv,
// json) simply yield one batch; paged ones (datasette) yield one per page.

/** What the user gave us: a URL, an uploaded file, or pasted text. */
export interface ImportSourceInput {
  kind: 'url' | 'file' | 'text';
  url?: string | undefined;
  file?: File | undefined;
  text?: string | undefined;
  /**
   * Name to propose for the table, when the input alone does not carry one.
   * A `url` or `file` names itself; a `text` body does not, so a caller that
   * already read the body (to sniff its shape, say) passes the original name
   * here rather than letting every importer fall back to "imported".
   */
  name?: string | undefined;
}

/**
 * One table a source offers. `handle` is opaque to the kernel and private to
 * the importer that produced it — the kernel only passes it back to `read`.
 */
export interface ImportCandidate {
  /** Proposed table name. The kernel still applies its own naming policy. */
  name: string;
  /** Row count when the source reports one, else null (drives the picker). */
  rowCount: number | null;
  /** Secondary text in the picker, e.g. the database a table belongs to. */
  detail?: string | undefined;
  /** Source marks this as internal (FTS shadow tables, Datasette `hidden`). */
  hidden?: boolean | undefined;
  handle: unknown;
}

/** One chunk of rows from `read`. The FIRST batch must carry `columns`. */
export interface ImportBatch {
  columns?: ColumnSpec[] | undefined;
  rows: Array<Record<string, unknown>>;
  /** Cursor to resume from if the read stops early; persisted as `importResume`. */
  nextCursor?: string | undefined;
  /** Known total, when the source reports one, for a proportional bar. */
  totalCount?: number | undefined;
}

/** Services the kernel lends an importer. Deliberately no store access. */
export interface ImportCtx {
  api: HostApi;
  /**
   * Fetch text with the CORS rewrite, the size ceiling, the informative errors
   * and the slow-read progress bar already applied. Importers should use this
   * instead of `api.backend.fetch` for a whole-body read.
   */
  fetchText(url: string, label?: string): Promise<string>;
  /** Values reported by this importer's own `panel` element, if it has one. */
  panel: Record<string, unknown>;
  /** Resume cursor, when the user is continuing an interrupted import. */
  cursor?: string | undefined;
  /**
   * The user's row cap, as an ADVISORY hint. The kernel enforces it regardless,
   * so an importer may ignore it — but one that can cheaply read less should
   * honour it. Reading a 150 MB CSV whole and then discarding all but 100 rows
   * can kill a memory-limited tab, which is why the cap is visible here at all.
   */
  maxRows?: number | undefined;
  /**
   * The columns of the table being appended to or overwritten. Absent when
   * importing into a NEW table, where the source defines the schema.
   *
   * Present so an importer can map its values onto an existing schema in the
   * way that is correct FOR ITS FORMAT — the kernel cannot do this generically.
   * A CSV maps cells by POSITION, because its header names need not match the
   * target's fields (`Person Name,Years` into `[name, age]` must still land in
   * `name` and `age`, not create `person_name`/`years` and drop the data). A
   * JSON dump, whose rows are already objects, maps by field NAME instead.
   */
  targetColumns?: ColumnSpec[] | undefined;
}

/** A curated starting point this importer contributes to the dialog's picker. */
export interface ImportSample {
  label: string;
  url: string;
}

export interface ImporterSpec {
  /** Stable id, also the `origin.type` stamped on tables this importer makes. */
  id: string;
  /** Shown in the Import menu and the dialog's format selector. */
  label: string;
  /** Material Icons ligature or inline `<svg>` for the menu entry. */
  icon?: string | undefined;
  /** Menu sort order; lower first. Absent ⇒ registration order. */
  order?: number | undefined;
  /** File extensions / MIME types, unioned into the dialog's file input. */
  accept?: string[] | undefined;
  /** Sample sources merged into the dialog's picker. */
  samples?: ImportSample[] | undefined;
  /**
   * Custom element tag rendered in the dialog's panel slot for this
   * importer's own fields. The element MAY expose a `value` property the
   * kernel reads into `ImportCtx.panel`, and SHOULD dispatch `change` when it
   * edits. Registering a tag keeps the kernel free of plugin imports.
   */
  panel?: string | undefined;
  /** Which source kinds and modes this format can do. Absent ⇒ url + file. */
  supports?:
    | {
        url?: boolean | undefined;
        file?: boolean | undefined;
        text?: boolean | undefined;
        /** Can back a live read-only reference table (needs `reference`). */
        reference?: boolean | undefined;
        /** One source can yield several tables (`list` may return many). */
        multiTable?: boolean | undefined;
        /**
         * This importer runs through the import kernel (`runImport`), so the
         * host drives it: the dialog picks the destination BEFORE the read
         * starts (new table / append / overwrite) instead of a modal
         * interrupting it partway, and the kernel does the writing.
         *
         * Absent ⇒ the importer still owns its own route and its own collision
         * prompt, and the dialog hides the Target control rather than offering
         * a choice nobody will honour. Each importer sets this as it moves
         * across — see the phase table in
         * `.claude/plans/2026-07-28-importer-architecture.md`.
         */
        kernel?: boolean | undefined;
      }
    | undefined;
  /**
   * Confidence from 0 to 1 that this input belongs to this importer. Drives
   * "Auto-detect" and dropped files/URLs; the highest scorer wins. Absent ⇒
   * matched on `accept` alone.
   */
  detect?(input: ImportSourceInput): number;
  /** The tables this source offers. A single-table format returns exactly one. */
  list(ctx: ImportCtx, input: ImportSourceInput): Promise<ImportCandidate[]>;
  /** Stream one candidate's columns + rows. */
  read(ctx: ImportCtx, candidate: ImportCandidate): AsyncIterable<ImportBatch>;
  /** Build the live `TableSource` for Reference mode. */
  reference?(ctx: ImportCtx, candidate: ImportCandidate): TableSource;
  /**
   * True when this importer emits its own toasts, so the kernel stays quiet.
   * Replaces the hard-coded `source === 'datasette'` check the host used to
   * carry.
   */
  ownToasts?: boolean | undefined;
}

// -- Connectors ------------------------------------------------------------
//
// A connector is the CONNECT counterpart to an importer. An importer copies
// data in and you own the copy; a connector points a window at a live remote
// table and stores nothing. They are separate contracts because they are
// separate user intents with separate consequences — see
// `.claude/plans/2026-07-28-importer-architecture.md`.
//
// A connector owns its whole flow: it asks for a URL and credentials however
// its backend requires, then creates tables carrying a `source` descriptor that
// a matching `RowCollectionProvider` (registered via `registerRowSource`) backs.
// There is nothing generic to factor out, so unlike `ImporterSpec` this is a
// thin contract: it exists so the Connect menu can list what is available
// without the host knowing any backend.

export interface ConnectorSpec {
  /** Stable id, matching the `TableSource.type` this connector produces. */
  id: string;
  /** Shown in the Connect menu. */
  label: string;
  /** Material Icons ligature or inline `<svg>` for the menu entry. */
  icon?: string | undefined;
  /** Menu sort order; lower first. Absent ⇒ registration order. */
  order?: number | undefined;
  /** One line under the label, saying what connecting to this backend means. */
  description?: string | undefined;
  /** Run the connect flow: prompt, authenticate, create the live table(s). */
  connect(api: HostApi): Promise<void>;
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

// -- Settings -------------------------------------------------------------

export type SettingScope = 'workspace' | 'user';

export type SettingsFieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'secret'
  | 'option'
  | 'selection';

/**
 * One declarative field in a plugin's settings tab. Stored under the key
 * `${pluginId}:${key}`. `scope` is the DEFAULT layer; the user may promote a
 * value to the device-local `user` layer from the dialog. Omitted ⇒ workspace.
 */
export interface SettingsFieldSpec {
  key: string;
  label: string;
  type: SettingsFieldType;
  default?: unknown;
  /** For 'option' (radio) and 'selection' (checkbox group). */
  options?: string[];
  /** Shown as field help below the control. */
  description?: string;
  /**
   * Longer explanation, behind an (i) icon next to the label — for what a
   * `description` line cannot carry, e.g. which scopes a token needs. Shown only
   * when the user asks for it, so a field with a long story stays compact.
   */
  help?: string;
  /** Page that lets the user act on the help, linked from the (i) panel. */
  helpUrl?: string;
  /** Link text for `helpUrl`. Defaults to the URL's host. */
  helpLinkLabel?: string;
  scope?: SettingScope;
}

export interface RegisteredSettings {
  name: string;
  fields: SettingsFieldSpec[];
}

/**
 * Layer-aware settings accessor. The resolver reads the user layer first,
 * then the workspace layer, then the field default. String values may embed
 * `${secret:name}` references, which resolve against the device-local secrets
 * store.
 */
export interface SettingsApi {
  /** Resolved value: user layer wins over workspace, else the field default. */
  get<T = unknown>(pluginId: string, key: string): Promise<T | undefined>;
  /** Writes to `scope` (defaults to the field's declared scope, else workspace). */
  set(pluginId: string, key: string, value: unknown, scope?: SettingScope): Promise<void>;
  /** Which layer currently holds the key ('user' | 'workspace' | null). */
  placement(pluginId: string, key: string): Promise<SettingScope | null>;
}

/**
 * A command surfaced in the Ctrl+K command palette. Plugins register these via
 * `UiRegistry.registerCommand`; the palette also auto-aggregates existing
 * header/footer buttons and a "Go to <table>" entry per table, so registering a
 * command is only needed for actions that aren't already a button.
 */
export interface CommandSpec {
  /** Stable unique id (e.g. 'windows:close-all'). */
  id: string;
  /** Text shown (and matched) in the palette. */
  title: string;
  /** Optional group heading the palette buckets this under (e.g. 'Windows'). */
  group?: string;
  /** Material Icons ligature name, or inline `<svg>` markup. */
  icon?: string;
  /** Extra search terms that match this command but aren't shown. */
  keywords?: string[];
  /** Invoked when the user picks the command. */
  run(api: HostApi): void | Promise<void>;
}

/**
 * A button the column editor offers above its column list, for an action that
 * rewrites the columns being edited — "give every column a renderer that suits
 * its values", say.
 *
 * `run` receives the columns AS CURRENTLY EDITED (not the saved ones) and returns
 * the new list, or null to change nothing. Nothing is written to the store: the
 * result lands in the editor, so the user still reviews it and presses Save. That
 * is what keeps an action from being a surprise the user cannot undo.
 */
export interface ColumnEditorActionSpec {
  id: string;
  label: string;
  /** Material Icons ligature name, or inline `<svg>` markup. */
  icon?: string;
  tooltip?: string;
  /** The table being edited; absent while a brand-new table is defined. */
  run(
    api: HostApi,
    ctx: { columns: ColumnSpec[]; tableId?: string | undefined },
  ): Promise<ColumnSpec[] | null> | ColumnSpec[] | null;
}

export interface UiRegistry {
  registerHeaderButton(spec: ButtonSpec): Unregister;
  registerFooterButton(spec: ButtonSpec): Unregister;
  registerTableButton(spec: TableButtonSpec): Unregister;
  /** Add a button to the column editor that rewrites the columns being edited. */
  registerColumnEditorAction(spec: ColumnEditorActionSpec): Unregister;
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
  /**
   * Register a live-backend connector. The Connect menu lists these; the
   * matching row-source provider is registered separately via
   * `HostApi.registerRowSource`, because one is UI and the other is data.
   */
  registerConnector(spec: ConnectorSpec): Unregister;
  registerExporter(spec: ExporterSpec): Unregister;
  registerDropHandler(fn: DropHandler): Unregister;
  registerUrlSource(spec: UrlSourceSpec): Unregister;
  /** Opens the shell's "new table" dialog. Plugins use this to drive table creation. */
  openNewTableDialog(): void;
  /** Opens the shell's "paste CSV" dialog. */
  openCsvPasteDialog(): void;
  /** Opens the Plugin Manager dialog (add/disable third-party plugin URLs). */
  openPluginManager(): void;
  /** Opens the Settings dialog. */
  openSettings(): void;
  /** Registers a command for the Ctrl+K command palette. Returns an unregister fn. */
  registerCommand(spec: CommandSpec): Unregister;
  /** Opens the command palette (also bound to Ctrl+K / Cmd+K). */
  openCommandPalette(): void;
  /**
   * Registers a plugin's settings tab. The Settings dialog renders one tab per
   * registration, in registration order. Returns an unregister fn.
   */
  registerSettings(pluginId: string, name: string, fields: SettingsFieldSpec[]): Unregister;
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
  /** Layer-aware settings accessor (user layer shadows workspace layer). */
  settings: SettingsApi;
  /** The current workspace id, when one is selected. */
  workspaceId(): string | null;
  /** Plugin's own URL — useful for relative resource loads. */
  selfUrl(): string;
}
