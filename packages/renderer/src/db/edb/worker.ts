/// <reference lib="webworker" />
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { EdbStore } from '@easydb/shared';
import { ROW_COLLECTION, type EdbRequest, type EdbResponse } from './protocol.js';
import { createAutosavePolicy, type AutosavePolicy } from './dirty.js';
import { readMirror, writeMirror } from './mirror.js';
import { wasmDriver } from './wasm-driver.js';

/**
 * The worker that owns the database.
 *
 * SQLite runs here rather than on the main thread for the reason the desktop
 * already learned: this app imports 600k-row tables, and sqlite-wasm is
 * synchronous, so a bulk insert on the main thread would freeze the tab for the
 * length of the import.
 *
 * The database is held IN MEMORY. Nothing touches the user's file until they
 * press Save, which asks for {@link exportBytes} and writes them through a
 * FileSystemAccess handle on the main thread. Between saves the bytes are
 * mirrored to OPFS so a crashed or closed tab loses nothing.
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
  dbName = name;
  workspaceKey = name;
  if (bytes && bytes.byteLength > 0) {
    // Deserialise the user's file into a fresh in-memory database. `p` hands
    // SQLite a pointer it then owns, which is why the bytes are copied into WASM
    // memory first rather than passed by reference.
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    db = new sqlite3.oo1.DB();
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer!,
      'main',
      p,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    db.checkRc(rc);
  } else {
    db = new sqlite3.oo1.DB(':memory:');
  }
  driver = wasmDriver(sqlite3, db);
  store = new EdbStore(driver);

  const key = workspaceKey;
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

/** The mirrored bytes for a workspace, so a reload can restore without a file permission. */
async function restoreFromMirror(name: string): Promise<Uint8Array | null> {
  const record = await readMirror(name);
  return record?.bytes ?? null;
}

/**
 * Write the mirror at once, ignoring the debounce.
 *
 * Open and Convert both fill a worker and then reload the page. The boot after
 * that reload reads the mirror, so the bytes have to be there before the reload,
 * not two seconds later.
 */
async function flushMirror(): Promise<void> {
  await writeMirror(workspaceKey, require(driver, 'flush requested').export());
}

function require<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`edb worker: ${what} before the database was opened`);
  return value;
}

/** Which table a row write touched, so the broadcast can be scoped to it. */
function rowScope(req: EdbRequest): string | undefined {
  if ('doc' in req && req.doc && typeof req.doc.tableId === 'string') return req.doc.tableId;
  if ('docs' in req && Array.isArray(req.docs)) {
    const first = req.docs[0];
    if (first && typeof first.tableId === 'string') return first.tableId;
  }
  return undefined;
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
    case 'export':
      return require(driver, 'export requested').export();
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
      return restoreFromMirror(req.name);
    case 'flush':
      return flushMirror();
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
      post({ changed: req.coll, scope: req.coll === ROW_COLLECTION ? rowScope(req) : undefined });
      // One call per RPC, so a 600k-row bulkInsert marks the mirror dirty once.
      mirror?.changed();
    }
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
