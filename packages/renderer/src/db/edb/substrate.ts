import type { Database, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';

/**
 * Where the browser's SQLite database actually lives.
 *
 * Two answers, and the difference between them is durability:
 *
 * - **`opfs-sahpool`** — the database is a real file in origin-private storage
 *   and SQLite writes its pages incrementally, so every `COMMIT` is durable.
 *   Nothing has to be serialised, debounced or flushed.
 * - **memory** — the fallback where the pool cannot be installed. The database
 *   is held in RAM and whole-database bytes are mirrored out on a debounce,
 *   which means writes made in the moments before a reload are lost. That is
 *   the behaviour this module exists to stop being the default.
 *
 * The pool is installed once per worker and cached. Its files are exclusive to
 * one tab origin-wide — see `tab-lock.ts` for the election that guarantees only
 * one tab tries.
 */

/**
 * Named for this app rather than left as `opfs-sahpool`, so the pool cannot
 * collide with another SAHPool on the same origin and its OPFS directory is
 * recognisable in devtools.
 */
const VFS_NAME = 'easydb-sahpool';

/**
 * Pool capacity is a COUNT OF FILES, not a size cap, and it reserves no quota.
 * Six covers the local database and its journal, an adopted user file and its
 * journal, and two spare.
 */
const INITIAL_CAPACITY = 6;

/**
 * Slots added when the pool runs out of them.
 *
 * Two per database — the file and its journal — so four covers two more
 * workspaces before the next grow.
 */
const GROW_BY = 4;

/**
 * Installing can fail transiently right after another tab releases the pool:
 * its sync access handles are closed asynchronously relative to the Web Lock it
 * held, so the first attempt can lose that race.
 */
const INSTALL_ATTEMPTS = 5;
const RETRY_MS = 250;

let pool: SAHPoolUtil | null = null;
/** Sticky: once the pool is known to be unavailable, stop paying for retries. */
let unavailable = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The pool, or null where this browser cannot host one.
 *
 * Detection is try-and-catch rather than feature-sniffing: the failures that
 * matter — no OPFS, no `createSyncAccessHandle`, another tab holding the pool —
 * are not otherwise visible.
 */
export async function ensurePool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil | null> {
  if (pool) return pool;
  if (unavailable) return null;
  for (let attempt = 0; attempt < INSTALL_ATTEMPTS; attempt++) {
    try {
      pool = await sqlite3.installOpfsSAHPoolVfs({ name: VFS_NAME, initialCapacity: INITIAL_CAPACITY, clearOnInit: false });
      return pool;
    } catch {
      if (attempt < INSTALL_ATTEMPTS - 1) await sleep(RETRY_MS);
    }
  }
  unavailable = true;
  return null;
}

/** A database name as a path inside the pool. */
export function poolPath(name: string): string {
  return name.startsWith('/') ? name : `/${name}`;
}

/**
 * Connection settings for a pooled database.
 *
 * **No WAL.** SAHPool cannot do it — WAL needs shared memory — so the
 * `journal_mode = WAL` the desktop sets (`electron/src/sqlite-store.ts`) is
 * wrong here. `TRUNCATE` keeps the journal file allocated in its pool slot
 * rather than creating and deleting one per transaction. It is also what keeps
 * `export` honest: a WAL-mode database exported without its `-wal` sidecar
 * silently loses its most recent commits.
 *
 * `temp_store = MEMORY` stops a large `ORDER BY` spilling a temp file into a
 * pool slot.
 */
export function tunePooledDb(db: Database): void {
  db.exec('PRAGMA journal_mode = TRUNCATE');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
}

/**
 * Make room for an import, growing the pool if there is none.
 *
 * `importDb` needs a FREE file slot unless it is overwriting a path the pool
 * already holds — with neither it throws "No available handles to import to.",
 * which is what `?space=NAME` did once a few workspace files had accumulated:
 * capacity is persistent and every Open leaves its file in the pool, so the six
 * initial slots (a database and its journal apiece) run out on the third or
 * fourth file. Nothing was wrong with the file or the workspace.
 *
 * Growing is the whole answer because a slot is a FILE, not a quota: the pool
 * reserves no space, so a bigger pool costs nothing until it is used. Removing
 * old files instead would mean deciding which of the user's workspaces to drop.
 */
export async function ensureRoomToImport(p: SAHPoolUtil, path: string): Promise<void> {
  if (p.getFileNames().includes(path)) return;
  if (Number(p.getFileCount()) < Number(p.getCapacity())) return;
  await p.addCapacity(GROW_BY);
}

/**
 * Open `name` in the pool, replacing its contents with `bytes` when given.
 *
 * `importDb` validates the SQLite header and page size, so a file that is not a
 * database is refused here rather than failing later as a confusing SQL error.
 * A full pool reports `SQLITE_CANTOPEN`, which is a capacity problem and not a
 * quota one — hence the one-shot grow and retry.
 */
export async function openInPool(p: SAHPoolUtil, name: string, bytes: Uint8Array | null): Promise<Database> {
  const path = poolPath(name);
  if (bytes && bytes.byteLength > 0) {
    await ensureRoomToImport(p, path);
    await p.importDb(path, bytes);
  }
  try {
    return new p.OpfsSAHPoolDb(path);
  } catch {
    await p.addCapacity(4);
    return new p.OpfsSAHPoolDb(path);
  }
}
