import type { DistinctPage, DistinctQuery, RowPage, RowQuery, SqlRunResult, WorkspaceContents } from '@easydb/shared';
import type { EasydbStoreBridge } from '../data-store-bridge.js';
import type { EdbCall, EdbRequest, EdbResponse } from './protocol.js';

/**
 * The main-thread half of the worker bridge.
 *
 * Implements `EasydbStoreBridge` — the same interface Electron's preload
 * satisfies — so `createIpcDataStore` builds the whole `DataStore` on top of it
 * with no change. The windowed row view, the row-fetch cap and the change
 * plumbing all come along for free.
 */

export interface EdbBridge extends EasydbStoreBridge {
  /** Told when the worker hits a non-fatal problem worth showing the user. */
  onWarning(cb: (message: string) => void): () => void;
  /** The database as bytes, for Save to write to the user's file. */
  export(): Promise<Uint8Array>;
  /** Replace the contents — a fresh workspace, or a file the user just opened. */
  open(bytes: Uint8Array | null, name: string): Promise<void>;
  /**
   * Put a database under `name` where the next boot will find it, without
   * switching to it.
   *
   * Open and Convert both end in a reload, and the bytes have to be in place
   * first. Only this worker can put them there: the `opfs-sahpool` VFS is
   * exclusive origin-wide, so the throwaway worker that BUILT them never got the
   * pool and wrote its copy where no boot looks.
   */
  importBytes(name: string, bytes: Uint8Array): Promise<void>;
  /**
   * The OPFS mirror's bytes for a workspace, or null.
   *
   * What a reload uses: the mirror needs no file permission, so the workspace
   * comes back without the user gesture a `FileSystemFileHandle` would demand.
   */
  restore(name: string): Promise<Uint8Array | null>;
  /**
   * Write the OPFS mirror now.
   *
   * Call this before a reload that is meant to land on these bytes. Open and
   * Convert both do, because the boot reads the mirror and nothing else.
   */
  flush(): Promise<void>;
  /**
   * Does this browser already hold a database of that name?
   *
   * `?space=NAME` resolution asks before adopting anything, so a link can reach a
   * workspace this browser has but the OPEN database has never heard of.
   */
  hasDatabase(name: string): Promise<boolean>;
  /**
   * The workspace records inside a `.edb`'s bytes, without adopting the file.
   *
   * A folder scan calls this once per file. Nothing is imported and the live
   * session is untouched — see the worker's own note.
   */
  peekWorkspaces(bytes: Uint8Array): Promise<Record<string, unknown>[]>;
  terminate(): void;
}

export function createEdbBridge(): EdbBridge {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(coll: string, scope?: string) => void>();
  const warners = new Set<(message: string) => void>();
  let nextId = 1;

  worker.onmessage = (e: MessageEvent<EdbResponse>) => {
    const msg = e.data;
    if ('warning' in msg) {
      for (const fn of warners) fn(msg.warning);
      return;
    }
    if ('changed' in msg) {
      for (const fn of listeners) fn(msg.changed, msg.scope);
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.result);
    else slot.reject(new Error(msg.error));
  };

  // A worker that dies takes every in-flight call with it. Rejecting them beats
  // leaving the UI waiting on promises that can never settle.
  worker.onerror = (e) => {
    const err = new Error(`edb worker failed: ${e.message}`);
    for (const [, slot] of pending) slot.reject(err);
    pending.clear();
  };

  function call<T>(req: EdbCall): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...req, id } as EdbRequest);
    });
  }

  return {
    open: (bytes, name) => call<void>({ op: 'open', bytes, name }),
    restore: (name) => call<Uint8Array | null>({ op: 'restore', name }),
    importBytes: (name, bytes) => call<void>({ op: 'importBytes', name, bytes }),
    flush: () => call<void>({ op: 'flush' }),
    hasDatabase: (name) => call<boolean>({ op: 'hasDatabase', name }),
    peekWorkspaces: (bytes) => call<Record<string, unknown>[]>({ op: 'peekWorkspaces', bytes }),
    export: () => call<Uint8Array>({ op: 'export' }),
    find: (coll, query, limit) => call<unknown[]>({ op: 'find', coll, query, limit }),
    findOne: (coll, key) => call<unknown | null>({ op: 'findOne', coll, key }),
    insert: (coll, doc) => call<unknown>({ op: 'insert', coll, doc }),
    bulkInsert: (coll, docs) => call<unknown[]>({ op: 'bulkInsert', coll, docs }),
    upsert: (coll, doc) => call<unknown>({ op: 'upsert', coll, doc }),
    patch: (coll, key, patch) => call<unknown>({ op: 'patch', coll, key, patch }),
    remove: (coll, key) => call<void>({ op: 'remove', coll, key }),
    bulkRemove: (coll, keys) => call<void>({ op: 'bulkRemove', coll, keys }),
    count: (coll) => call<number>({ op: 'count', coll }),
    countRows: (tableId) => call<number>({ op: 'countRows', tableId }),
    queryRows: (tableId, q: RowQuery) => call<RowPage>({ op: 'queryRows', tableId, query: q }),
    // Feature-detected by the caller, so declaring it here is what turns a
    // funnel's value list from a client-side scan into a SQL GROUP BY.
    distinctValues: (tableId, q: DistinctQuery) => call<DistinctPage>({ op: 'distinctValues', tableId, query: q }),
    // Also feature-detected: its presence is what tells the chrome this
    // workspace is a real database it can offer a SQL console for.
    runSql: (sql, opts) => call<SqlRunResult>({ op: 'runSql', sql, params: opts?.params, write: opts?.write, maxRows: opts?.maxRows }),
    countWorkspaceContents: (workspaceId, opts) => call<WorkspaceContents>({ op: 'countWorkspaceContents', workspaceId, countRows: opts?.countRows }),
    deleteWorkspace: (workspaceId) => call<WorkspaceContents>({ op: 'deleteWorkspace', workspaceId }),
    cloneWorkspace: (opts) => call<string>({ op: 'cloneWorkspace', ...opts }),
    dbPath: () => call<string>({ op: 'dbName' }),
    onWarning(cb) {
      warners.add(cb);
      return () => warners.delete(cb);
    },
    onChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    terminate() {
      worker.terminate();
      pending.clear();
      listeners.clear();
      warners.clear();
    },
  };
}
