/**
 * Running arbitrary SQL against a workspace.
 *
 * The point of keeping a workspace in a real SQLite database is that it can be
 * queried like one. This is the type surface for that — shared, because the same
 * shape crosses three transports: the browser worker's postMessage protocol,
 * Electron's IPC, and (later) the Hono server.
 *
 * **Read-only is the default, and it is enforced by SQLite, not by inspecting
 * the statement.** `PRAGMA query_only = ON` makes the connection reject every
 * write, which is the only check worth trusting: classifying a statement by its
 * leading keyword gets `WITH x AS (...) INSERT ...` wrong, and a SQL console is
 * exactly where someone will type that.
 */

export interface SqlRunOptions {
  /** Bound parameters, positional. Always prefer these to string interpolation. */
  params?: unknown[] | undefined;
  /**
   * Allow the statement to write.
   *
   * Off by default. A caller that turns this on is taking responsibility for
   * the workspace's integrity: raw SQL bypasses every rule `EdbStore` enforces
   * — the physical table name a `tables` doc points at, additive-only column
   * reconciliation, `_extra` overflow — so a `DROP TABLE` here leaves a
   * registered table with nothing behind it.
   */
  write?: boolean | undefined;
  /** Stop returning rows after this many. Omitted means every row. */
  maxRows?: number | undefined;
}

export interface SqlRunResult {
  /**
   * Column names in result order.
   *
   * Empty for a statement that returned no rows at all — including a SELECT
   * that matched nothing, because the driver seam reports rows and not a
   * description of the shape a query would have had.
   */
  columns: string[];
  /** One array per row, aligned to `columns`. */
  rows: unknown[][];
  /** Rows the statement changed. `null` for a read. */
  changes: number | null;
  /** True when `maxRows` cut the result short. */
  truncated: boolean;
  elapsedMs: number;
}

/** The async face of the above, as a plugin or the chrome sees it. */
export interface SqlRunner {
  /** Runs ONE statement. Use `splitStatements` first for a script. */
  run(sql: string, opts?: SqlRunOptions): Promise<SqlRunResult>;
}
