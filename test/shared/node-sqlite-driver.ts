import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { SqlDriver, SqlStatement } from '../../packages/shared/src/sql-driver.js';

// `node:sqlite` is a Node builtin that Vite's static analyser does not know, so
// a plain `import` of it fails to resolve under vitest. Loading it through
// `createRequire` leaves the analyser alone and lets Node resolve it natively —
// the same escape hatch `packages/electron/src/sqlite-store.ts` uses, for the
// same reason.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/**
 * `node:sqlite` as a {@link SqlDriver}.
 *
 * This is the point of the driver interface: the store under test is the same
 * code the browser worker runs on sqlite-wasm, exercised here against a real
 * SQLite with no WASM to boot and no DOM to fake. If a method here needed more
 * than a cast, the abstraction would be leaking.
 */
export function nodeSqliteDriver(path = ':memory:'): SqlDriver & { close(): void; export(): Uint8Array | null } {
  const db = new DatabaseSync(path);
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...(params as never[])) as Record<string, unknown> | undefined,
        all: (...params) => stmt.all(...(params as never[])) as Record<string, unknown>[],
        run: (...params) => void stmt.run(...(params as never[])),
      };
    },
    close(): void {
      db.close();
    },
    export(): Uint8Array | null {
      return null; // only the WASM build exports bytes; unused by these suites
    },
  };
}
