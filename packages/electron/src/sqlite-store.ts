/**
 * Main-process SQLite store.
 *
 * **The storage logic is not here.** It lives once, in
 * `packages/shared/src/edb-store.ts`, and this file is the desktop's binding to
 * it: a `node:sqlite` driver, plus the connection tuning and file-level controls
 * that only a real database on disk needs. The browser binds the same store to
 * sqlite-wasm in a worker.
 *
 * Until v0.0.355 this file carried its own 860-line copy of that logic and its
 * own on-disk layout (format v1: an `_easydb_tables` registry plus a per-table
 * `_easydb_meta_<name>`). The two drifted — the desktop grew `distinctValues`
 * that the shared store lacked, the shared store grew a format stamp the desktop
 * lacked — and a file written by one would not open in the other. Format v1 is
 * gone, with no migration: see `docs/tech/EDB.md`.
 *
 * Pure Node — no `electron` import — so it is unit-testable under plain Node and
 * safe to `require` from the main process.
 */

import { copyFileSync } from 'node:fs';
import { EdbStore, type DistinctPage, type DistinctQuery, type RowPage, type RowQuery, type SqlRunOptions, type SqlRunResult } from '@easydb/shared';
import { nodeSqlDriver, type NodeSqlDriver } from './node-sqlite-driver';

export interface SqliteStoreOptions {
  path: string;
}

export class SqliteStore {
  readonly filePath: string;
  private readonly driver: NodeSqlDriver;
  private readonly store: EdbStore;

  constructor(opts: SqliteStoreOptions) {
    this.filePath = opts.path;
    this.driver = nodeSqlDriver(opts.path);
    // Tuned BEFORE the store is built: `EdbStore`'s constructor creates the
    // schema, and doing that under the default 2 MB page cache on a large
    // existing file is exactly the case the cache size below exists for.
    this.tune();
    this.store = new EdbStore(this.driver);
  }

  /**
   * Connection tuning. `cache_size` is the load-bearing one: SQLite's default
   * page cache is 2 MB, and every row's primary key is a random UUID, so once a
   * table outgrows that cache each insert lands in an uncached B-tree page.
   * Measured on a 5-column table with random-UUID keys: ~22,000 rows/s at 20k
   * rows, collapsing to ~1,400 rows/s by 400k — a 44 MB file, far too small for
   * disk pressure to explain it. Importing a 609,283-row table took over 10
   * minutes at that rate, which is what made the window look hung.
   *
   * Negative means kibibytes rather than pages, so this asks for 64 MB.
   */
  private tune(): void {
    this.driver.exec('PRAGMA cache_size = -65536');
    // WAL lets a SECOND connection write this file while this one keeps reading
    // it, which is what the import worker needs (`import-runner.ts`): under the
    // default rollback journal a writer locks the whole database, so every
    // `store:*` call would block for the length of the import — the freeze the
    // worker exists to remove.
    //
    // Tolerated rather than required: a file on read-only media cannot be
    // converted, and the store must still open it. The worker checks the mode it
    // actually got and stays on the main thread if WAL was refused.
    try {
      this.driver.exec('PRAGMA journal_mode = WAL');
    } catch {
      /* keeps whatever mode the file has */
    }
    // With two connections, one can find the other mid-write. Waiting briefly
    // beats surfacing SQLITE_BUSY to the user, and a batch is ~40ms.
    this.driver.exec('PRAGMA busy_timeout = 10000');
  }

  /** The journal mode actually in force — `wal` once {@link tune} succeeded. */
  journalMode(): string {
    const r = this.driver.prepare('PRAGMA journal_mode').get();
    return String(r?.['journal_mode'] ?? '').toLowerCase();
  }

  /**
   * Folds the `-wal` sidecar back into the main file.
   *
   * Required before the file is COPIED. In WAL mode a committed row can live in
   * `<name>.db-wal` and not yet in `<name>.db`, so copying only the `.db` — which
   * is what Save As does — would silently produce a database missing its most
   * recent writes.
   */
  checkpoint(): void {
    try {
      this.driver.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* not in WAL, or nothing to fold — either way there is nothing to do */
    }
  }

  /**
   * Trades crash-durability for insert speed, for the length of a bulk import.
   *
   * `synchronous = OFF` stops SQLite waiting for the OS to flush on each commit.
   * The risk it accepts is narrow and, here, acceptable: a power loss or kernel
   * panic mid-import can corrupt the database. A process crash cannot — the OS
   * still has the writes. An interrupted import is already something the user
   * must redo, and the destination is either a fresh file (Convert) or a table
   * they can re-import, so there is nothing irreplaceable in flight.
   *
   * Always restore with `'safe'` when the import ends, including on failure.
   */
  setDurability(mode: 'safe' | 'bulk'): void {
    this.driver.exec(mode === 'bulk' ? 'PRAGMA synchronous = OFF' : 'PRAGMA synchronous = FULL');
  }

  // -- the store, verbatim ------------------------------------------------
  //
  // Straight delegation on purpose. A wrapper that "improved" any of these would
  // be the drift this change removed.

  find(coll: string, query?: Record<string, unknown>, limit?: number): unknown[] {
    return this.store.find(coll, query, limit);
  }

  findOne(coll: string, key: string): unknown | null {
    return this.store.findOne(coll, key);
  }

  insert(coll: string, doc: Record<string, unknown>): unknown {
    return this.store.insert(coll, doc);
  }

  bulkInsert(coll: string, docs: Record<string, unknown>[]): unknown[] {
    return this.store.bulkInsert(coll, docs);
  }

  upsert(coll: string, doc: Record<string, unknown>): unknown {
    return this.store.upsert(coll, doc);
  }

  patch(coll: string, key: string, patch: Record<string, unknown>): unknown {
    return this.store.patch(coll, key, patch);
  }

  /** For `rows`, the table the row came out of — see `EdbStore.remove`. */
  remove(coll: string, key: string): string | undefined {
    return this.store.remove(coll, key);
  }

  /** For `rows`, the distinct tables the rows came out of. */
  bulkRemove(coll: string, keys: string[]): string[] {
    return this.store.bulkRemove(coll, keys);
  }

  /** One arbitrary SQL statement. Read-only unless `write` — see `EdbStore.runSql`. */
  runSql(sql: string, opts?: SqlRunOptions): SqlRunResult {
    return this.store.runSql(sql, opts);
  }

  count(coll: string): number {
    return this.store.count(coll);
  }

  countRowsIn(tableId: string): number {
    return this.store.countRowsIn(tableId);
  }

  queryRows(tableId: string, q: RowQuery = {}): RowPage {
    return this.store.queryRows(tableId, q);
  }

  distinctValues(tableId: string, q: DistinctQuery): DistinctPage {
    return this.store.distinctValues(tableId, q);
  }

  /** The physical SQL table behind a logical table, for code that reads it directly. */
  sqlTableOf(tableId: string): string | null {
    return this.store.sqlTableOf(tableId);
  }

  close(): void {
    // Fold the WAL back in first. A store closed with a `-wal` beside it is still
    // correct, but anything that then COPIES the file (Save As) would miss the
    // most recent writes.
    this.checkpoint();
    this.driver.close();
  }
}

/**
 * Copy a database file. Callers must {@link SqliteStore.checkpoint} the source
 * store first, or the copy can be missing its newest rows.
 */
export function copyDatabase(fromPath: string, toPath: string): void {
  copyFileSync(fromPath, toPath);
}
