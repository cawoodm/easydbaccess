import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { SqlDriver, SqlStatement } from '@easydb/shared';

/**
 * `@sqlite.org/sqlite-wasm`'s oo1 API as a {@link SqlDriver}.
 *
 * The whole adapter is this file. Everything else about `.edb` storage — the
 * schema, the relational row mapping, the query builder — is the one shared
 * `EdbStore`, which also runs on `node:sqlite`. Two bindings, one body of
 * storage logic, so the desktop and the browser cannot drift.
 *
 * Runs in a worker, not on the main thread: sqlite-wasm is synchronous, and this
 * app imports 600k-row tables.
 */

/** A value SQLite will accept as a bound parameter. */
type Bindable = string | number | bigint | null | Uint8Array;

/**
 * Statements are cached by SQL text.
 *
 * The store calls `prepare()` once per operation, and a bulk insert runs the
 * same INSERT thousands of times — compiling it afresh each time is pure waste.
 * A cached statement carries state from its last use, so every entry point
 * resets it before binding.
 */
export function wasmDriver(sqlite3: Sqlite3Static, db: Database): SqlDriver & { export(): Uint8Array; close(): void } {
  const cache = new Map<string, ReturnType<Database['prepare']>>();

  function stmtFor(sql: string) {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    } else {
      stmt.reset(true);
    }
    return stmt;
  }

  /** Binds positionally. sqlite-wasm counts parameters from 1; an empty list binds nothing. */
  function bind(stmt: ReturnType<Database['prepare']>, params: unknown[]): void {
    if (params.length === 0) return;
    stmt.bind(params as Bindable[]);
  }

  return {
    exec(sql: string): void {
      db.exec(sql);
    },

    prepare(sql: string): SqlStatement {
      return {
        get(...params: unknown[]) {
          const stmt = stmtFor(sql);
          bind(stmt, params);
          const row = stmt.step() ? (stmt.get({}) as Record<string, unknown>) : undefined;
          stmt.reset(true);
          return row;
        },
        all(...params: unknown[]) {
          const stmt = stmtFor(sql);
          bind(stmt, params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.get({}) as Record<string, unknown>);
          stmt.reset(true);
          return rows;
        },
        run(...params: unknown[]) {
          const stmt = stmtFor(sql);
          bind(stmt, params);
          stmt.step();
          stmt.reset(true);
        },
      };
    },

    /**
     * The database as bytes — what Save writes to the user's file.
     *
     * Serialising the live in-memory database is the whole reason the store can
     * stay in memory: there is no file to flush, only bytes to hand over.
     */
    export(): Uint8Array {
      return sqlite3.capi.sqlite3_js_db_export(db);
    },

    close(): void {
      for (const stmt of cache.values()) stmt.finalize();
      cache.clear();
      db.close();
    },
  };
}
