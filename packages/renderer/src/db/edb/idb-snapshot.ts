import { EDB_FORMAT_VERSION } from '@easydb/shared';

/**
 * The database, dumped whole into IndexedDB as one opaque blob.
 *
 * **This is not a store and nothing queries it.** The workspace lives in
 * SQLite — a file in the `opfs-sahpool` VFS, or in memory where the pool cannot
 * be installed. IndexedDB holds a copy of that database's BYTES, and the only
 * two things anyone does with the record are write it and hand it back to
 * SQLite. There is no schema here beyond "one slab per slot" on purpose: the
 * moment a field of the workspace is readable from IndexedDB, something starts
 * reading it from there, and then there are two stores again.
 *
 * ## When it is written
 *
 * On Save, when there is no file to save to. A browser without the FileSystem
 * Access API, or one where the user has not granted a folder, otherwise has
 * nowhere durable to put a save except a download — and a download is a file
 * the app can never read back. So the bytes also go here, where the app CAN
 * read them back, and the File menu can offer to restore them.
 *
 * It matters most on the memory fallback, where the live database is in RAM and
 * a save with no file access would otherwise leave nothing behind at all.
 *
 * ## Its own database, and why
 *
 * Not `easydb` — every user from before the SQLite flip still has an IndexedDB
 * database under that name, and reusing it would collide with its version and
 * its stores. Not `easydb-edb-handles` either, though the shape is the same:
 * handles and snapshots have different lifetimes and different failure modes,
 * and a quota abort while writing a 200 MB slab must not be able to take the
 * user's remembered folder handle with it.
 */

const DB_NAME = 'easydb-snapshots';
const STORE = 'snapshots';
const VERSION = 1;

/**
 * One saved copy of a workspace's database.
 *
 * `bytes` is a `Blob`, not an `ArrayBuffer`: Firefox and Safari store a Blob as
 * a file reference rather than inline in the record, which is what keeps a big
 * workspace clear of the structured-clone size ceiling. `byteLength` is
 * redundant with it so that listing the slots never has to touch the blob.
 *
 * `formatVersion` is stamped so a newer build's slab is recognised rather than
 * handed to SQLite blindly. There is no app version: the format is what decides
 * whether these bytes can be opened, and `EDB_FORMAT_VERSION` is what says so.
 */
export interface Snapshot {
  /** Matches the key: the `.edb` name this tab is using. */
  slot: string;
  bytes: Blob;
  byteLength: number;
  at: number;
  formatVersion: number;
}

/** A snapshot's particulars without its bytes — enough to describe it in a menu. */
export type SnapshotInfo = Omit<Snapshot, 'bytes'>;

/**
 * The origin ran out of room.
 *
 * Its own type because it is the one failure the user can do something about,
 * and the message for it is different in kind from "the write broke".
 */
export class SnapshotQuotaError extends Error {
  constructor() {
    super('This browser is out of storage, so the copy could not be saved.');
    this.name = 'SnapshotQuotaError';
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      // Out-of-line keys: the slot is a routing label, not a field of the payload.
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the snapshot store'));
  });
}

/**
 * Run one transaction and resolve on its **completion**, not on the request's.
 *
 * A request succeeding does not mean the data is committed, and the failure
 * that matters here — a full origin — aborts the TRANSACTION. Resolving on
 * `onsuccess` would report a save that never landed, which is the one thing a
 * safety net must not do.
 */
async function inTransaction<T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = body(tx.objectStore(STORE));
      let result: T;
      req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      const fail = () => {
        const err = tx.error ?? req.error;
        reject(err?.name === 'QuotaExceededError' ? new SnapshotQuotaError() : (err ?? new Error('the snapshot store failed')));
      };
      tx.onabort = fail;
      tx.onerror = fail;
    });
  } finally {
    db.close();
  }
}

/**
 * Write `bytes` as the copy for `slot`, replacing whatever was there.
 *
 * One record per slot, and `put` replaces — so this store cannot grow by
 * writing to it, only by using more slots, and a slot is a workspace file the
 * user named. Throws {@link SnapshotQuotaError} when the origin is full.
 */
export async function putSnapshot(slot: string, bytes: Uint8Array): Promise<SnapshotInfo> {
  const record: Snapshot = {
    slot,
    bytes: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/x-sqlite3' }),
    byteLength: bytes.byteLength,
    at: Date.now(),
    formatVersion: EDB_FORMAT_VERSION,
  };
  await inTransaction('readwrite', (s) => s.put(record, slot));
  const { bytes: _dropped, ...info } = record;
  return info;
}

/** What is stored for `slot`, without reading the blob. Null when there is none. */
export async function snapshotInfo(slot: string): Promise<SnapshotInfo | null> {
  try {
    const found = await inTransaction<Snapshot | undefined>('readonly', (s) => s.get(slot));
    if (!found) return null;
    const { bytes: _dropped, ...info } = found;
    return info;
  } catch {
    return null; // private mode, or a store that never existed
  }
}

/**
 * The stored bytes for `slot`, ready to hand to SQLite. Null when there is none.
 *
 * A slab stamped with a format this build does not know is refused rather than
 * opened: it was written by a newer version, and guessing at it is how a
 * workspace gets corrupted instead of merely being unavailable.
 */
export async function readSnapshot(slot: string): Promise<Uint8Array | null> {
  const found = await inTransaction<Snapshot | undefined>('readonly', (s) => s.get(slot));
  if (!found) return null;
  if (found.formatVersion !== EDB_FORMAT_VERSION) {
    throw new Error(`That copy was saved by a newer version of easyDBAccess (format ${found.formatVersion}), so it cannot be opened here.`);
  }
  return new Uint8Array(await found.bytes.arrayBuffer());
}

/** Forget the copy for `slot`. */
export async function deleteSnapshot(slot: string): Promise<void> {
  await inTransaction('readwrite', (s) => s.delete(slot));
}
