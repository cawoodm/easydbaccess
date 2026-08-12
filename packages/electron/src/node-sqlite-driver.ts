/**
 * `node:sqlite` as a {@link SqlDriver}, so the desktop runs the SAME store body
 * as the browser.
 *
 * This is the whole payoff of the driver seam: `packages/shared/src/edb-store.ts`
 * holds the storage logic once, and the two platforms differ only in the ~40
 * lines below and in `renderer/src/db/edb/wasm-driver.ts`. Before this the
 * desktop had its own 860-line copy of the same rules.
 *
 * Pure Node — no `electron` import — so it stays unit-testable under plain Node.
 */

import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import type { SqlDriver, SqlStatement } from '@easydb/shared';

// node:sqlite is a Node builtin (unflagged on Electron 43's bundled Node 24).
// Vite — which vitest uses to run this package's tests — does not recognise it
// and fails trying to statically resolve an `import`, so it is loaded with a
// plain `require()` that the analyser leaves alone. This package compiles to
// CommonJS anyway, so that is what the built output would contain regardless.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** A driver plus the file-level controls only a real database on disk has. */
export interface NodeSqlDriver extends SqlDriver {
  /** The underlying handle, for the pragma work `EdbStore` has no business knowing about. */
  readonly raw: DatabaseSyncType;
  close(): void;
}

/**
 * Every bind parameter the store builds is already a plain string, number or
 * null. This asserts that to `node:sqlite`'s narrower type in ONE place, rather
 * than threading `SQLInputValue` through the shared store — which must stay free
 * of Node types.
 */
function params(values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

export function nodeSqlDriver(path: string): NodeSqlDriver {
  const db = new DatabaseSync(path);
  return {
    raw: db,
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const stmt = db.prepare(sql);
      return {
        get: (...p) => stmt.get(...params(p)) as Record<string, unknown> | undefined,
        all: (...p) => stmt.all(...params(p)) as Record<string, unknown>[],
        run: (...p) => void stmt.run(...params(p)),
      };
    },
    close(): void {
      db.close();
    },
  };
}
