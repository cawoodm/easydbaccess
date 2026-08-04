import type { ColumnSpec, DataCollection, DataStore, PluginRecord, Row, RowPage, RowQuery, Setting, Table, Unsubscribe, ViewInstance, ViewTemplate, Workspace } from '@easydb/shared';
import { settingId } from './dexie-db.js';

/**
 * Ambient typing for the preload bridge `packages/electron/src/preload.ts`
 * exposes as `window.easydb`. The renderer and electron packages are separate
 * `tsc -b` projects — the renderer cannot import electron's own `declare
 * global` block (see `packages/electron/CLAUDE.md`) — so this mirrors that
 * package's `contextBridge.exposeInMainWorld('easydb', ...)` shape by hand.
 * Keep the two in sync if the preload surface changes.
 */
export interface EasydbStoreBridge {
  /** `limit` caps rows per table; see `findRows` in the main-process store. */
  find(coll: string, query?: Record<string, unknown>, limit?: number): Promise<unknown[]>;
  /** True row count for one table, without fetching any of them. */
  countRows?(tableId: string): Promise<number>;
  /**
   * The narrow read — fields, filter, sort, slice — answered in SQL. Optional
   * because an older preload won't have it; `rowsViewIpc` feature-detects.
   */
  queryRows?(tableId: string, q: RowQuery): Promise<RowPage>;
  findOne(coll: string, key: string): Promise<unknown | null>;
  insert(coll: string, doc: Record<string, unknown>): Promise<unknown>;
  bulkInsert(coll: string, docs: Record<string, unknown>[]): Promise<unknown[]>;
  upsert(coll: string, doc: Record<string, unknown>): Promise<unknown>;
  patch(coll: string, key: string, patch: Record<string, unknown>): Promise<unknown>;
  remove(coll: string, key: string): Promise<void>;
  bulkRemove(coll: string, keys: string[]): Promise<void>;
  count(coll: string): Promise<number>;
  /**
   * Subscribes to `store:changed` broadcasts; returns an unsubscribe function.
   * `scope`, when present, narrows the change to one table's rows (its
   * `tableId`) so unrelated row views don't re-read — see `broadcastChanged`
   * in `packages/electron/src/main.ts`.
   */
  onChanged(cb: (coll: string, scope?: string) => void): () => void;
  dbPath(): Promise<string>;
}

/** One imported table's candidate summary (see `packages/electron/src/db-import.ts`). */
export interface EasydbImportCandidate {
  name: string;
  rowCount: number;
  /** Case-insensitive name clash against an existing table in the target workspace. */
  collides: boolean;
  /** A SQL VIEW: importing snapshots the rows it returns now; the definition doesn't travel. */
  isView?: boolean;
  /** The source object's own column names, in its order — what an append maps FROM. */
  columns?: string[];
  /** A view's `CREATE VIEW … AS SELECT …` — what lets it be imported as a projection. */
  sql?: string;
}

export interface EasydbImportPreview {
  /** Whether the source carries this app's own `_easydb_tables` registry, or is a foreign file. */
  kind: 'easydb' | 'foreign';
  candidates: EasydbImportCandidate[];
  /**
   * The source file's size on disk. Above the renderer's `LARGE_SOURCE_BYTES` it
   * leaves every window it creates minimized. Absent from
   * an older preload; read as 0, which means "small".
   */
  sizeBytes?: number;
}

/** `append` adds rows to the existing table and leaves its schema alone. */
export type EasydbCollisionAction = 'overwrite' | 'rename' | 'skip' | 'append';

export interface EasydbImportDecision {
  action: EasydbCollisionAction;
  /** Final table name to use. Required for 'rename'; ignored otherwise. */
  renameTo?: string;
  /** For 'append': per SOURCE column (in `EasydbImportCandidate.columns` order), the TARGET field it feeds; '' drops it. */
  mapping?: string[];
}

export interface EasydbImportedTableResult {
  sourceName: string;
  action: 'created' | 'overwritten' | 'renamed' | 'skipped' | 'appended';
  finalName: string;
  tableId: string | null;
  rowCount: number;
}

export interface EasydbCurrentDbInfo {
  path: string;
  isDefault: boolean;
  /** True when the remembered path was gone at boot and this session fell back to the default. */
  fellBackToDefault: boolean;
}

type EasydbDialogResult<T> = ({ ok: true } & T) | { ok: false; cancelled: true };

/**
 * File-operations bridge: Open / Save As / Import a `.db` (see
 * `packages/electron/src/db-files.ts` / `db-import.ts`). Mirrors that
 * package's `preload.ts` `db` object by hand, same as `EasydbStoreBridge`
 * above — the renderer and electron packages are separate `tsc -b` projects,
 * so this can't just import electron's own ambient types.
 */
/**
 * What a picked file turned out to be (`packages/electron/src/db-import.ts`'s
 * `probeDatabaseFile`). Only `easydb` can be opened; the other two are why
 * Open asks before doing anything.
 */
export type EasydbDatabaseFileKind = 'easydb' | 'foreign' | 'unreadable';

/** One table or view offered by "Browse .db file" (`packages/electron/src/db-browse.ts`). */
export interface EasydbBrowsableObject {
  name: string;
  kind: 'table' | 'view';
  /** Null for a view — counting one means running it, which Browse defers. */
  rowCount: number | null;
  columns: ColumnSpec[];
}

export interface EasydbBrowseRow {
  id: string;
  data: Record<string, unknown>;
}

/** One table created by phase 1 of an import, waiting for its rows. */
export interface EasydbImportPlanEntry {
  sourceName: string;
  finalName: string;
  tableId: string;
  sqlTable: string;
  total: number;
  kind: 'easydb' | 'foreign';
  action: 'created' | 'overwritten' | 'renamed' | 'appended';
  /** Append only: SOURCE field -> TARGET field, resolved when the plan was made. */
  fieldMap?: Record<string, string>;
}

export interface EasydbImportPlan {
  plan: EasydbImportPlanEntry[];
  skipped: EasydbImportedTableResult[];
}

/** Progress for one table's row import; `done` marks the final message. */
export interface EasydbImportProgress {
  tableId: string;
  table: string;
  rows: number;
  total: number;
  done?: boolean;
}

export interface EasydbDbBridge {
  openDb(): Promise<EasydbDialogResult<{ path: string; kind: EasydbDatabaseFileKind }>>;
  openDbCommit(newPath: string): Promise<{ ok: true; path: string }>;
  saveDbAs(): Promise<EasydbDialogResult<{ path: string }>>;
  /** `sourcePath` skips the OS picker — used when Open fell through to Import. */
  importDb(workspaceId: string, sourcePath?: string): Promise<EasydbDialogResult<{ path: string; preview: EasydbImportPreview }>>;
  importDbCommit(sourcePath: string, workspaceId: string, decisions: Record<string, EasydbImportDecision>): Promise<EasydbImportedTableResult[]>;
  /**
   * Write a foreign file's tables into a NEW easydb file and open that; the
   * source is untouched. `only` names the source objects to take — omitted
   * means every table (views excluded).
   */
  convertDb(sourcePath: string, only?: string[]): Promise<EasydbDialogResult<{ path: string; tables: EasydbImportedTableResult[]; pending: number }>>;
  /** Classify a path the renderer already has (a dropped file) — no picker involved. */
  probeDb(sourcePath: string): Promise<EasydbDatabaseFileKind>;
  /** Phase 1: create the chosen tables EMPTY and minimized. Cheap at any file size. */
  importPrepare(sourcePath: string, workspaceId: string, decisions: Record<string, EasydbImportDecision>): Promise<EasydbImportPlan>;
  /** Phase 2: fill ONE prepared table, reporting progress via `onImportProgress`. */
  importRows(sourcePath: string, entry: EasydbImportPlanEntry): Promise<number>;
  onImportProgress(cb: (p: EasydbImportProgress) => void): () => void;
  /** Tables AND views in a file, read-only — nothing is written to it. */
  browseList(sourcePath: string): Promise<EasydbBrowsableObject[]>;
  browseRows(sourcePath: string, objectName: string, columns: ColumnSpec[]): Promise<EasydbBrowseRow[]>;
  /** Real filesystem path of a dropped `File` (Electron 32 removed `File.path`); '' when it has none. */
  pathForFile(file: File): string;
  currentDb(): Promise<EasydbCurrentDbInfo>;
  /** Whether the last workspace reopens on startup (default true) — app-level, not per workspace. */
  autoLoadLast?(): Promise<boolean>;
  setAutoLoadLast?(on: boolean): Promise<void>;
}

declare global {
  interface Window {
    easydb?: {
      platform: 'electron';
      version: string;
      store: EasydbStoreBridge;
      db: EasydbDbBridge;
    };
  }
}

/**
 * IPC-backed DataStore. Implements `DataCollection<T>` from the plugin API
 * exactly like `data-store-dexie.ts`, but every operation is a round trip to
 * the main-process `SqliteStore` (see `packages/electron/src/sqlite-store.ts`)
 * through `window.easydb.store`. Plugins never see this distinction — they
 * only ever hold a `DataStore`.
 *
 * Subscriptions have no local equivalent of Dexie's `liveQuery`: the bridge
 * only tells us WHICH collection changed (`onChanged`), not what changed, so
 * every notification re-reads the whole collection over IPC — matching
 * Dexie's own "re-run the query on any write" granularity, just coarser (an
 * unrelated table's row write still re-runs a `rows(otherTableId)` view,
 * exactly as an unrelated Dexie write would re-run its `liveQuery`). See
 * `subscribeToCollection` for how a slow re-run is kept from clobbering a
 * faster, newer one.
 */

/** Every collection name the main-process store recognises (mirrors `dexie-db.ts`). */
type CollName = 'workspaces' | 'tables' | 'rows' | 'settings' | 'plugins' | 'viewTemplates' | 'viewInstances';

/**
 * Re-reads `collName` and delivers the fresh result set to `fn`, matching
 * `liveQuery`'s "initial value, then one per write" behaviour:
 *  - Runs once immediately on subscribe (liveQuery's initial emission).
 *  - Re-runs whenever `onChanged` names THIS collection; a broadcast for any
 *    other collection is ignored.
 *  - `scope` opts this subscription out of broadcasts that name a DIFFERENT
 *    scope. A `rows(tableId)` view passes its `tableId`, so an import filling
 *    one table stops making every other open table re-read its rows —
 *    quadratic work that dominated a 13-table import. A broadcast with no
 *    scope still reaches every subscriber, which is what an ordinary write is.
 *
 * Every run is an IPC round trip, so two runs can resolve out of order (a
 * slow run started before a fast one can resolve after it). A monotonic
 * generation counter fixes this: each `run()` claims the next generation
 * before awaiting, and a resolution only reaches `fn` if its generation is
 * still the latest one issued — an older, slower run's result is discarded
 * once a newer run has been kicked off, never delivered late over a fresher
 * state.
 */
function subscribeToCollection<T>(bridge: EasydbStoreBridge, collName: CollName, query: () => Promise<T[]>, fn: (docs: T[]) => void, scope?: string): Unsubscribe {
  let latest = 0;
  let disposed = false;
  const run = (): void => {
    const gen = ++latest;
    void query().then((docs) => {
      if (disposed || gen !== latest) return; // superseded by a newer run, or unsubscribed
      fn(docs);
    });
  };
  run();
  const off = bridge.onChanged((changed, changedScope) => {
    if (changed !== collName) return;
    // A scoped broadcast is only for the matching subscription; an unscoped one
    // is for all of them.
    if (changedScope && scope && changedScope !== scope) return;
    run();
  });
  return () => {
    disposed = true;
    off();
  };
}

/**
 * Plain (non-scoped, non-view) collection over the bridge. The bridge's own
 * `find` already does the equality filtering `matchesAll` does in the Dexie
 * wrapper (see `sqlite-store.ts`'s `find`), so a query object is passed
 * straight through instead of re-filtering client-side.
 */
function wrapIpc<T>(bridge: EasydbStoreBridge, collName: CollName): DataCollection<T> {
  const queryAll = (query?: Partial<T>): Promise<T[]> => bridge.find(collName, query as Record<string, unknown> | undefined) as Promise<T[]>;
  return {
    find: (query) => queryAll(query),
    async findOne(id) {
      const doc = await bridge.findOne(collName, id);
      return (doc as T | undefined) ?? null;
    },
    async insert(doc) {
      await bridge.insert(collName, doc as unknown as Record<string, unknown>);
      return doc;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      await bridge.bulkInsert(collName, docs as unknown as Record<string, unknown>[]);
      return docs;
    },
    async upsert(doc) {
      await bridge.upsert(collName, doc as unknown as Record<string, unknown>);
      return doc;
    },
    async patch(id, patch) {
      // sqlite-store's patch already merges+persists+returns the full updated
      // doc (and throws if `id` doesn't exist, propagated over IPC as a
      // rejected promise) — no separate re-fetch needed, unlike the Dexie
      // wrapper which has to `update` then `get` as two calls.
      return (await bridge.patch(collName, id, patch as Record<string, unknown>)) as T;
    },
    async remove(id) {
      await bridge.remove(collName, id);
    },
    async bulkRemove(ids) {
      if (ids.length === 0) return;
      await bridge.bulkRemove(collName, ids);
    },
    subscribe(fn): Unsubscribe {
      return subscribeToCollection(bridge, collName, () => queryAll(), fn);
    },
  };
}

/**
 * `rows(tableId)` returns a view scoped to one logical table, mirroring
 * `data-store-dexie.ts`'s `rowsView`: inserts auto-stamp `tableId`, queries
 * auto-filter by it. There is one logical `rows` collection on the main-
 * process side too (see `sqlite-store.ts`'s `COLLECTIONS.rows`) — `tableId`
 * is a promoted column there, so filtering by it is a real SQL WHERE, not a
 * client-side scan.
 */
/**
 * Most rows a single table view will pull over IPC.
 *
 * Unbounded crashed the app. A grid asks for its whole table the moment it
 * mounts, and the reply crosses IPC as one structured-clone payload: a workspace
 * converted from `northwind.db` restored 18 open windows wanting 1,893,366 rows
 * between them, three of the tables holding 609,283 each, and the app died on
 * boot before drawing anything. The renderer also filters and sorts in memory,
 * so a table this size was never going to be workable there whole.
 *
 * 20,000 is chosen to be far above any table a person scrolls and far below what
 * hurts: it clones in well under a second. The true total still comes from
 * `countRows`, so a truncated view reports itself as truncated rather than
 * quietly passing 20,000 rows off as the whole table.
 */
export const ROW_FETCH_CAP = 20_000;

function rowsViewIpc(bridge: EasydbStoreBridge, tableId: string): DataCollection<Row> {
  const fetchAll = (query?: Partial<Row>): Promise<Row[]> => bridge.find('rows', { ...(query as Record<string, unknown> | undefined), tableId }, ROW_FETCH_CAP) as Promise<Row[]>;
  const queryRows = bridge.queryRows?.bind(bridge);
  return {
    find: (query) => fetchAll(query),
    // Present only when the preload offers it, because `DataCollection.query`
    // is feature-detected by its callers and an implementation that silently
    // fell back to `find()` would hide the cost it exists to avoid.
    ...(queryRows ? { query: (q: RowQuery): Promise<RowPage> => queryRows(tableId, q) } : {}),
    async findOne(id) {
      const doc = (await bridge.findOne('rows', id)) as Row | undefined;
      return doc && doc.tableId === tableId ? doc : null;
    },
    async insert(doc) {
      const stamped = { ...doc, tableId };
      await bridge.insert('rows', stamped as unknown as Record<string, unknown>);
      return stamped;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      const stamped = docs.map((d) => ({ ...d, tableId }));
      await bridge.bulkInsert('rows', stamped as unknown as Record<string, unknown>[]);
      return stamped;
    },
    async upsert(doc) {
      const stamped = { ...doc, tableId };
      await bridge.upsert('rows', stamped as unknown as Record<string, unknown>);
      return stamped;
    },
    async patch(id, patch) {
      return (await bridge.patch('rows', id, patch as Record<string, unknown>)) as Row;
    },
    async remove(id) {
      await bridge.remove('rows', id);
    },
    async bulkRemove(ids) {
      if (ids.length === 0) return;
      await bridge.bulkRemove('rows', ids);
    },
    subscribe(fn): Unsubscribe {
      // An ordinary write broadcasts 'rows' with no scope, so any write to any
      // table re-runs this view — coarse but never wrong, matching the Dexie
      // view's own `liveQuery` granularity. An import scopes its broadcast to
      // the table it filled, and passing `tableId` here is what lets the other
      // open tables sit that one out.
      return subscribeToCollection(bridge, 'rows', () => fetchAll(), fn, tableId);
    },
    /**
     * The same notification `subscribe` acts on, minus the fetch.
     *
     * This is the cheap half of the broadcast: the bridge already tells us WHICH
     * collection changed, and `subscribe` only reads the rows in order to have
     * something to pass. A consumer running its own `query` does not want them,
     * so it gets the bare signal and nothing crosses IPC at all.
     *
     * Fires once immediately, matching `subscribe`'s initial emission, so a
     * caller has one code path for "load now" and "load again".
     */
    /**
     * The table's own row count, straight from SQL's `COUNT(*)` — no rows decoded
     * and none cloned over IPC. This is the denominator a panel title needs once
     * the grid stopped fetching the whole table to measure it.
     */
    ...(bridge.countRows ? { count: (): Promise<number> => bridge.countRows!(tableId) } : {}),
    watch(fn): Unsubscribe {
      fn();
      return bridge.onChanged((changed, changedScope) => {
        if (changed !== 'rows') return;
        // A scoped broadcast is only for the table it names; an unscoped one is
        // an ordinary write and reaches everybody.
        if (changedScope && changedScope !== tableId) return;
        fn();
      });
    },
  };
}

/**
 * A view over the settings of ONE workspace — same contract and physical-key
 * scheme as `data-store-dexie.ts`'s `settingsView`. Callers address a setting
 * by its logical `name`; this maps it to the physical `<workspaceId>::<name>`
 * key (`settingId`, shared with the Dexie implementation and with
 * `sqlite-store.ts`'s `settings` collection, whose primary key IS that
 * composite string) so the same name can exist once per workspace.
 *
 * `workspaceId` is a getter, not a value — see `createIpcDataStore` below.
 * An incoming `key`/`workspaceId` on a write is ignored and re-derived, same
 * as the Dexie version.
 */
function settingsViewIpc(bridge: EasydbStoreBridge, workspaceId: () => string): DataCollection<Setting> {
  const stamp = (doc: Partial<Setting> & { name: string }): Setting => ({
    ...doc,
    workspaceId: workspaceId(),
    key: settingId(workspaceId(), doc.name),
    name: doc.name,
    value: doc.value,
  });
  // `workspaceId` is a promoted column on the `settings` collection (see
  // `sqlite-store.ts`), so this is a real SQL WHERE, not a client-side scan.
  const queryMine = (query?: Partial<Setting>): Promise<Setting[]> =>
    bridge.find('settings', {
      ...(query as Record<string, unknown> | undefined),
      workspaceId: workspaceId(),
    }) as Promise<Setting[]>;
  return {
    find: (query) => queryMine(query),
    async findOne(name) {
      const doc = (await bridge.findOne('settings', settingId(workspaceId(), name))) as Setting | undefined;
      return doc ?? null;
    },
    async insert(doc) {
      const stamped = stamp(doc as Setting);
      await bridge.insert('settings', stamped as unknown as Record<string, unknown>);
      return stamped;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      const stamped = docs.map((d) => stamp(d as Setting));
      await bridge.bulkInsert('settings', stamped as unknown as Record<string, unknown>[]);
      return stamped;
    },
    async upsert(doc) {
      const stamped = stamp(doc as Setting);
      await bridge.upsert('settings', stamped as unknown as Record<string, unknown>);
      return stamped;
    },
    async patch(name, patch) {
      const key = settingId(workspaceId(), name);
      return (await bridge.patch('settings', key, patch as Record<string, unknown>)) as Setting;
    },
    async remove(name) {
      await bridge.remove('settings', settingId(workspaceId(), name));
    },
    async bulkRemove(names) {
      if (names.length === 0) return;
      await bridge.bulkRemove(
        'settings',
        names.map((n) => settingId(workspaceId(), n)),
      );
    },
    subscribe(fn): Unsubscribe {
      return subscribeToCollection(bridge, 'settings', () => queryMine(), fn);
    },
  };
}

/**
 * `workspaceId` is a getter, not a value, for the same reason as the Dexie
 * store: `app-context.ts` builds the store before the active workspace is
 * resolved, so the id isn't known yet here.
 */
export function createIpcDataStore(bridge: EasydbStoreBridge, workspaceId: () => string): DataStore {
  return {
    workspaces: wrapIpc<Workspace>(bridge, 'workspaces'),
    tables: wrapIpc<Table>(bridge, 'tables'),
    settings: settingsViewIpc(bridge, workspaceId),
    plugins: wrapIpc<PluginRecord>(bridge, 'plugins'),
    viewTemplates: wrapIpc<ViewTemplate>(bridge, 'viewTemplates'),
    viewInstances: wrapIpc<ViewInstance>(bridge, 'viewInstances'),
    rows: (tableId: string) => rowsViewIpc(bridge, tableId),
  };
}
