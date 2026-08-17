/// <reference lib="webworker" />
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { ALL_COLLECTIONS, EdbStore, changeScopeOf } from '@easydb/shared';
import { type EdbRequest, type EdbResponse } from './protocol.js';
import { createAutosavePolicy, type AutosavePolicy } from './dirty.js';
import { readMirror, writeMirror } from './mirror.js';
import { ensurePool, openInPool, poolPath, tunePooledDb } from './substrate.js';
import { wasmDriver } from './wasm-driver.js';

/**
 * The worker that owns the database.
 *
 * SQLite runs here rather than on the main thread for the reason the desktop
 * already learned: this app imports 600k-row tables, and sqlite-wasm is
 * synchronous, so a bulk insert on the main thread would freeze the tab for the
 * length of the import.
 *
 * ## Where the data lives
 *
 * Normally in the `opfs-sahpool` VFS: the database is a real origin-private
 * file and SQLite writes its pages incrementally, so **every COMMIT is
 * durable**. There is nothing to serialise and nothing to flush.
 *
 * Where the pool cannot be installed the database falls back to memory, and
 * whole-database bytes are mirrored out on a debounce. That path loses writes
 * made in the seconds before a reload, which is why it is the fallback and not
 * the default — see `substrate.ts`.
 *
 * Either way the user's own FILE is untouched until they press Save, which asks
 * for the bytes and writes them through a FileSystemAccess handle on the main
 * thread.
 */

let sqlite3: Sqlite3Static | null = null;
let db: Database | null = null;
let driver: ReturnType<typeof wasmDriver> | null = null;
let store: EdbStore | null = null;
let dbName = 'workspace.edb';
let workspaceKey = 'default';
/**
 * The mirror's own debounce, reusing the autosave policy rather than growing a
 * second timer of its own — the requirement is identical (coalesce a burst,
 * write once) and that code is already tested.
 */
let mirror: AutosavePolicy | null = null;
/** Which substrate `open` settled on, so `export` and `flush` know what to do. */
let pooled: { path: string; exportFile: (p: string) => Promise<Uint8Array> } | null = null;

const post = (msg: EdbResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

/**
 * Writes that change data, and therefore need a `changed` broadcast.
 *
 * A type predicate rather than a `Set.has` check, because the caller needs the
 * request NARROWED to the members that carry a `coll` — a Set lookup tells
 * TypeScript nothing.
 */
function isMutation(req: EdbRequest): req is Extract<EdbRequest, { coll: string }> {
  switch (req.op) {
    case 'insert':
    case 'bulkInsert':
    case 'upsert':
    case 'patch':
    case 'remove':
    case 'bulkRemove':
      return true;
    default:
      return false;
  }
}

async function open(bytes: Uint8Array | null, name: string): Promise<void> {
  sqlite3 ??= await sqlite3InitModule();
  driver?.close();
  mirror?.dispose();
  mirror = null;
  pooled = null;
  dbName = name;
  workspaceKey = name;

  const pool = await ensurePool(sqlite3);
  if (pool) {
    // The durable path. The file already holds whatever previous sessions
    // wrote, so there is nothing to restore and nothing to debounce.
    db = await openInPool(pool, name, bytes);
    tunePooledDb(db);
    pooled = { path: poolPath(name), exportFile: (p) => pool.exportFile(p) };
  } else {
    await openInMemory(bytes, name);
  }

  driver = wasmDriver(sqlite3, require(db, 'database opened'));
  store = new EdbStore(driver);
}

/**
 * The fallback: database in RAM, whole-database bytes mirrored on a debounce.
 *
 * Only reached where `opfs-sahpool` cannot be installed. It is NOT equivalent to
 * the pooled path — a reload within the debounce window loses whatever was
 * written in it — so it exists to keep such a browser working rather than to be
 * a second supported way of running.
 */
async function openInMemory(bytes: Uint8Array | null, name: string): Promise<void> {
  const s3 = require(sqlite3, 'sqlite3 used');
  // With no file to open, the last mirror is the only copy there is.
  const source = bytes && bytes.byteLength > 0 ? bytes : ((await readMirror(name))?.bytes ?? null);
  if (source && source.byteLength > 0) {
    // `p` hands SQLite a pointer it then owns, which is why the bytes are copied
    // into WASM memory first rather than passed by reference.
    const p = s3.wasm.allocFromTypedArray(source);
    db = new s3.oo1.DB();
    const rc = s3.capi.sqlite3_deserialize(db.pointer!, 'main', p, source.byteLength, source.byteLength, s3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    db.checkRc(rc);
  } else {
    db = new s3.oo1.DB(':memory:');
  }

  const key = name;
  mirror = createAutosavePolicy({
    debounceMs: 2000,
    save: async () => {
      if (driver) await writeMirror(key, driver.export());
    },
    // A failed mirror write must not break the work it was protecting. The next
    // change schedules another attempt, and the user is told, because the thing
    // that just stopped working is their safety net.
    onError: (err) => post({ warning: `Could not mirror the workspace for crash recovery: ${err instanceof Error ? err.message : String(err)}` }),
  });
  mirror.setEnabled(true);
}

/**
 * Place a database under `name` without touching the open one.
 *
 * The pool is the only place a boot looks, and only this worker can hold it —
 * hence the op. On the memory fallback the mirror plays the same role, so the
 * bytes go there instead.
 */
async function importBytes(name: string, bytes: Uint8Array): Promise<void> {
  sqlite3 ??= await sqlite3InitModule();
  const pool = await ensurePool(sqlite3);
  if (pool) {
    await pool.importDb(poolPath(name), bytes);
    return;
  }
  await writeMirror(name, bytes);
}

/**
 * Make everything written so far durable, now.
 *
 * A near no-op on the pooled path — SQLite already committed it to the file —
 * and the forced mirror write on the fallback, where Open and Convert need the
 * bytes on disk before the reload they trigger.
 */
async function flushNow(): Promise<void> {
  if (pooled) return;
  await writeMirror(workspaceKey, require(driver, 'flush requested').export());
}

/**
 * The database as bytes, for Save.
 *
 * `exportFile` reads the pool's own backing file, where
 * `sqlite3_js_db_export` would allocate the whole database inside the WASM heap
 * and copy it out — twice its size, in a heap that cannot grow past 4 GB and in
 * practice gives up long before. This app's stated case is 600k-row tables.
 */
async function exportBytes(): Promise<Uint8Array> {
  if (pooled) return pooled.exportFile(pooled.path);
  return require(driver, 'export requested').export();
}

function require<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`edb worker: ${what} before the database was opened`);
  return value;
}

function handle(req: EdbRequest): unknown {
  const s = () => require(store, 'store used');
  switch (req.op) {
    case 'find':
      return s().find(req.coll, req.query, req.limit);
    case 'findOne':
      return s().findOne(req.coll, req.key);
    case 'insert':
      return s().insert(req.coll, req.doc);
    case 'bulkInsert':
      return s().bulkInsert(req.coll, req.docs);
    case 'upsert':
      return s().upsert(req.coll, req.doc);
    case 'patch':
      return s().patch(req.coll, req.key, req.patch);
    case 'remove':
      return s().remove(req.coll, req.key);
    case 'bulkRemove':
      return s().bulkRemove(req.coll, req.keys);
    case 'count':
      return s().count(req.coll);
    case 'countRows':
      return s().countRowsIn(req.tableId);
    case 'queryRows':
      return s().queryRows(req.tableId, req.query);
    case 'distinctValues':
      return s().distinctValues(req.tableId, req.query);
    case 'countWorkspaceContents':
      return s().countWorkspaceContents(req.workspaceId, { countRows: req.countRows });
    case 'deleteWorkspace':
      return s().deleteWorkspace(req.workspaceId);
    case 'cloneWorkspace':
      return s().cloneWorkspace({ from: req.from, to: req.to, name: req.name, mode: req.mode });
    case 'runSql':
      return s().runSql(req.sql, { params: req.params, write: req.write, maxRows: req.maxRows });
    case 'dbName':
      return dbName;
    default:
      throw new Error(`edb worker: unknown op`);
  }
}

/** The three operations that touch OPFS, and therefore cannot be synchronous. */
async function handleAsync(req: EdbRequest): Promise<unknown> {
  switch (req.op) {
    case 'open':
      return open(req.bytes, req.name);
    case 'restore':
      // Kept for protocol compatibility only. The pooled database loads itself
      // and the memory fallback reads its own mirror, so nobody needs bytes
      // handed back to pass into `open`.
      return null;
    case 'importBytes':
      return importBytes(req.name, req.bytes);
    case 'flush':
      return flushNow();
    case 'export':
      return exportBytes();
    default:
      return handle(req);
  }
}

self.onmessage = async (e: MessageEvent<EdbRequest>) => {
  const req = e.data;
  try {
    const result = await handleAsync(req);
    post({ id: req.id, ok: true, result });
    if (isMutation(req)) {
      // Scoped from the RESULT, not the request: a remove/bulkRemove names row
      // ids and a patch names only the changed fields, so none of them can say
      // which table they hit until the store has looked. See `changeScopeOf`.
      post({ changed: req.coll, scope: changeScopeOf(req.coll, result) });
      // One call per RPC, so a 600k-row bulkInsert marks the mirror dirty once.
      mirror?.changed();
    } else if ((req.op === 'runSql' && req.write) || req.op === 'deleteWorkspace' || req.op === 'cloneWorkspace') {
      // These say nothing about what they touched — raw SQL could have rewritten
      // the registry itself, and a workspace operation spans every collection —
      // so all of them are announced. Anything narrower would leave a stale
      // panel on screen.
      for (const coll of ALL_COLLECTIONS) post({ changed: coll });
      mirror?.changed();
    }
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
