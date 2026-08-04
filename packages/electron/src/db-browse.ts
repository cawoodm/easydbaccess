/**
 * "Browse a .db" — a read-only look at a SQLite file we are NOT opening as a
 * workspace, and NOT importing. Its tables **and its views** are listed, and
 * their rows are read on demand.
 *
 * Every function here opens the file `readOnly` and closes it again. Nothing is
 * ever written, so browsing a stranger's database leaves it byte-identical (not
 * even a `-wal` sidecar) — which is the whole point of offering Browse next to
 * Open in the first place.
 *
 * Unlike Import, views are included. A view is exactly what someone browsing a
 * database wants to see, and since nothing is written there is no question of
 * how to persist one.
 *
 * Pure Node — unit-testable like `sqlite-store.ts` and `db-import.ts`.
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { quoteIdent, type ColumnSpec } from '@easydb/shared';
import { fromRawSqlValue, inferForeignColumns } from './db-import';

// Same require-not-import trick as sqlite-store.ts — see the comment there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** Hard ceiling on one browse read, so a huge table cannot hang the window. */
export const BROWSE_ROW_CAP = 5000;

export interface BrowsableObject {
  /** SQL object name, used verbatim as the table name shown to the user. */
  name: string;
  kind: 'table' | 'view';
  /** Row count, or null for a view too expensive to count (see `countOf`). */
  rowCount: number | null;
  columns: ColumnSpec[];
}

/**
 * Counting a VIEW means running it, which for an expensive view is exactly the
 * work Browse is trying to defer. Tables are counted; views report `null` and
 * the UI shows their count once the rows are actually read.
 */
function countOf(db: DatabaseSyncType, name: string, kind: 'table' | 'view'): number | null {
  if (kind === 'view') return null;
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number };
    return r.n;
  } catch {
    return null;
  }
}

/**
 * Lists what a file offers for browsing: its tables and views, with inferred
 * columns. `_easydb*` objects are skipped — they are our bookkeeping, not the
 * user's data, and showing them in a browse of our OWN file would be noise.
 */
export function listBrowsable(sourcePath: string): BrowsableObject[] {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '\\_easydb%' ESCAPE '\\'
         ORDER BY type, name`,
      )
      .all() as Array<{ name: string; type: 'table' | 'view' }>;
    return rows.map((r) => ({
      name: r.name,
      kind: r.type,
      rowCount: countOf(db, r.name, r.type),
      // `PRAGMA table_info` works on a view too; a view's columns often have no
      // declared type, which `columnTypeFromSqlType` maps to a string.
      columns: inferForeignColumns(db, r.name),
    }));
  } finally {
    db.close();
  }
}

export interface BrowseRow {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Reads up to `BROWSE_ROW_CAP` rows of one table or view.
 *
 * Row ids come from `rowid` where SQLite provides one, so they are stable across
 * re-reads; a view (and a WITHOUT ROWID table) has none, and falls back to the
 * row's position. That is good enough because browse rows are never written —
 * nothing addresses one of these ids later.
 */
export function readBrowseRows(sourcePath: string, objectName: string, columns: ColumnSpec[], limit = BROWSE_ROW_CAP): BrowseRow[] {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const capped = Math.max(0, Math.min(limit, BROWSE_ROW_CAP));
    const ident = quoteIdent(objectName);
    let raw: Array<Record<string, unknown>>;
    let hasRowid = true;
    try {
      raw = db.prepare(`SELECT rowid AS _browse_rowid, * FROM ${ident} LIMIT ?`).all(capped) as unknown as Array<Record<string, unknown>>;
    } catch {
      // A view, or a WITHOUT ROWID table: no rowid to select.
      hasRowid = false;
      raw = db.prepare(`SELECT * FROM ${ident} LIMIT ?`).all(capped) as unknown as Array<Record<string, unknown>>;
    }

    return raw.map((r, i) => {
      const data: Record<string, unknown> = {};
      for (const col of columns) {
        const value = fromRawSqlValue(col.type, r[col.field]);
        if (value !== null) data[col.field] = value;
      }
      const rowid = hasRowid ? r._browse_rowid : undefined;
      return { id: typeof rowid === 'number' || typeof rowid === 'bigint' ? `r${rowid}` : `i${i}`, data };
    });
  } finally {
    db.close();
  }
}
