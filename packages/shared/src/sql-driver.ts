/**
 * The minimum a SQLite binding has to offer for {@link EdbStore} to run on it.
 *
 * Deliberately tiny, and deliberately SYNCHRONOUS. Both bindings this app uses
 * are synchronous already — `node:sqlite`'s `DatabaseSync` on the desktop and
 * `@sqlite.org/sqlite-wasm`'s oo1 API in a browser worker — so the store can be
 * one body of straight-line code instead of two async reimplementations that
 * drift. Asynchrony belongs at the edge (the worker message bridge), not here.
 *
 * `node:sqlite` satisfies this as-is. sqlite-wasm needs a thin shim, because it
 * spells the same three operations differently.
 */

export interface SqlStatement {
  /** First matching row, or undefined when there is none. */
  get(...params: unknown[]): Record<string, unknown> | undefined;
  /** Every matching row. */
  all(...params: unknown[]): Record<string, unknown>[];
  /** Run for effect. */
  run(...params: unknown[]): void;
  /**
   * Rows one at a time, so a caller can stop early.
   *
   * The reason this exists rather than `all().slice()`: a console running
   * `SELECT * FROM` a 609k-row table would otherwise materialise all 609k as JS
   * objects before keeping 500 of them. Stopping at the row you need is the
   * difference between a capped READ and a capped RENDER.
   *
   * Optional so a driver can omit it; callers fall back to `all`.
   */
  iterate?(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}

export interface SqlDriver {
  /** Run one or more statements with no parameters and no result. */
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}
