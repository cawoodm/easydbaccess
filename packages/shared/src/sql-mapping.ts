/**
 * SQL mapping helpers shared between every store that explodes a document
 * (workspace dump, row) into real SQL tables/columns and back —
 * `packages/server/src/storage/sqlite-store.ts` (whole-workspace `/sync`
 * blobs) and `packages/electron/src/sqlite-store.ts` (the relational
 * Electron main-process store). One convention here means a `.db` file
 * written by either side has the same shape.
 *
 * Pure — no I/O, no Node APIs — so it works in server, Electron main, and
 * (if ever needed) the renderer.
 */

import type { ColumnType } from './types.js';

/** Quotes a SQL identifier (table/column name), doubling any embedded `"`. */
export function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Replaces any character that isn't `[A-Za-z0-9_]` with `_`, for a safe SQL identifier. */
export function sanitizeTableName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_');
}

/** SQLite column affinity for a `ColumnType`. */
export function sqlAffinity(t: ColumnType): string {
  switch (t) {
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'INTEGER';
    // `text` is prose but stored the way a short string is — the type only
    // changes how the filter treats the column, never what reaches the file.
    case 'string':
    case 'text':
    case 'date':
    case 'datetime':
    default:
      return 'TEXT';
  }
}

/** Converts a document field's JS value into what should be bound for a SQL column of type `t`. */
export function encodeValue(t: ColumnType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (t === 'boolean') return v ? 1 : 0;
  if (t === 'number') {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return String(v);
}

/** Converts a value read back from a SQL column of type `t` into the document's JS value. */
export function decodeValue(t: ColumnType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (t === 'boolean') return !!v;
  return v;
}

/**
 * Inverse of `sqlAffinity` — infers a `ColumnType` from a SQL column's
 * DECLARED type string, e.g. what `PRAGMA table_info` reports. Only needed
 * for importing a FOREIGN SQLite file (one this app didn't write): a file we
 * wrote instead carries the original `ColumnSpec[]` verbatim in its
 * `_easydb_meta_*` table, so this function is never consulted for that case
 * — see `packages/electron/src/db-import.ts`.
 *
 * This is lossy on purpose, in the direction opposite to `sqlAffinity`:
 * `sqlAffinity` always writes TEXT for 'string'/'date'/'datetime', so a
 * declared type name alone can never distinguish those three back apart —
 * `2026-01-01` stored in a `TEXT` column looks identical whether it started
 * life as a date or a plain string. Two heuristics are layered on top of
 * SQLite's own 5-rule declared-type-affinity algorithm
 * (https://www.sqlite.org/datatype3.html, §3.1) to recover some of that:
 *
 *  - a declared type containing "BOOL" → 'boolean'. SQLite's own affinity
 *    rules have no BOOLEAN case; without this a `BOOLEAN` column (common in
 *    dumps from Python/Postgres-derived tools) would fall through to NUMERIC
 *    affinity and become 'number' — technically round-trips the stored 0/1
 *    fine, but shows a plain number box instead of a checkbox.
 *  - a declared type containing "DATE" or "TIME" → 'date' / 'datetime'
 *    (DATETIME and TIMESTAMP both count as 'datetime'; a bare DATE is
 *    'date'; a bare TIME has no dedicated ColumnType, so it becomes
 *    'datetime' too — the closer of the two fits).
 *
 * Everything else follows SQLite's own declared-type affinity rules, in
 * order, and maps the resulting affinity onto the closest `ColumnType`:
 *  1. contains "INT"                           → INTEGER affinity → 'number'
 *  2. contains "CHAR"/"CLOB"/"TEXT"             → TEXT affinity    → 'string'
 *  3. contains "BLOB", or no declared type      → BLOB affinity    → 'string'
 *  4. contains "REAL"/"FLOA"/"DOUB"             → REAL affinity    → 'number'
 *  5. anything else (e.g. "NUMERIC", "DECIMAL") → NUMERIC affinity → 'number'
 *
 * Rule 3 (BLOB) becomes 'string', not a dedicated blob type — `ColumnType`
 * has none. A BLOB value is not text, so the importer that calls this
 * base64-encodes it before storing it in that 'string' column rather than
 * risking a lossy/garbled `String(buffer)` coercion — see `db-import.ts`.
 */
export function columnTypeFromSqlType(declared: string | null | undefined): ColumnType {
  const t = (declared ?? '').toUpperCase();
  if (t.includes('BOOL')) return 'boolean';
  if (t.includes('DATETIME') || t.includes('TIMESTAMP')) return 'datetime';
  if (t.includes('DATE')) return 'date';
  if (t.includes('TIME')) return 'datetime';
  if (t.includes('INT')) return 'number';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'string';
  if (t.includes('BLOB') || t === '') return 'string';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'number';
  return 'number'; // NUMERIC/DECIMAL/unrecognized — SQLite's own catch-all affinity
}
