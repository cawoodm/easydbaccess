/**
 * Main-process SQLite store.
 *
 * Pure Node — no `electron` import — so it is unit-testable under plain
 * Node and safe to `require` from the main process. Uses the built-in
 * `node:sqlite` (unflagged on Electron 43's bundled Node 24.18.0; see
 * `packages/electron/CLAUDE.md`).
 *
 * Storage mapping: RELATIONAL, not document. A user table (a `tables`
 * collection doc) becomes a real SQL table — one row per `Row`, one column
 * per `ColumnSpec` — plus a small per-table metadata table. This is what
 * makes a saved `.db` a genuine database (openable in DB Browser/Datasette),
 * not an opaque blob. See `.claude/plans/2026-07-31-electron-sqlite-storage.md`.
 *
 * Everything that ISN'T a user table (`workspaces`, `settings`, `plugins`,
 * `viewTemplates`, `viewInstances`) stays document-shaped in one shared
 * `_easydb_docs` table — these are small and never need SQL-level querying
 * beyond their primary key and (for `settings`) `workspaceId`.
 */

import { copyFileSync } from 'node:fs';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import {
  decodeValue,
  encodeValue,
  quoteIdent,
  sanitizeTableName,
  sqlAffinity,
  type ColumnSpec,
} from '@easydb/shared';

// node:sqlite is a Node 22.5+ builtin (unflagged on Electron 43's bundled
// Node 24.18.0). Vite (used by vitest to run this package's tests) doesn't
// recognise it as a builtin and fails trying to statically resolve an
// `import` of it — so it's loaded via a plain `require()` call instead,
// which Vite's static analyser leaves alone and Node resolves natively at
// runtime. This package compiles to CommonJS (see package.json), so a bare
// `require` is also exactly what the built output would contain anyway.
// The `import type` above keeps full type-checking without pulling the
// runtime module through the ESM/analyser graph.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** Collections stored document-shaped in `_easydb_docs`, keyed by their primary-key field. */
const DOC_COLLECTIONS: Record<string, string> = {
  workspaces: 'id',
  settings: 'key',
  plugins: 'url',
  viewTemplates: 'id',
  viewInstances: 'id',
};

function unknownCollection(coll: string): Error {
  const known = ['tables', 'rows', ...Object.keys(DOC_COLLECTIONS)].join(', ');
  return new Error(`SqliteStore: unknown collection "${coll}" (known: ${known})`);
}

/** Validates `coll` is a known document collection and returns its primary-key field. */
function docPk(coll: string): string {
  const pk = DOC_COLLECTIONS[coll];
  if (!pk) throw unknownCollection(coll);
  return pk;
}

function matchesAll(doc: Record<string, unknown>, entries: Array<[string, unknown]>): boolean {
  for (const [k, v] of entries) if (doc[k] !== v) return false;
  return true;
}

/**
 * JS-fallback matcher for a reconstructed `Row` ({id, tableId, data,
 * updatedAt}): a query key that names a top-level `Row` field matches there,
 * otherwise it's checked against `data` — a caller filtering `find('rows',
 * {status: 'done'})` means the `status` field of the row's `data`, not a
 * literal `data` property named `status` on the envelope.
 */
function matchesRow(row: Record<string, unknown>, entries: Array<[string, unknown]>): boolean {
  const data = (row.data as Record<string, unknown>) ?? {};
  for (const [k, v] of entries) {
    const actual = k in row ? row[k] : data[k];
    if (actual !== v) return false;
  }
  return true;
}

/**
 * Every bind parameter this module builds is already a plain string, number,
 * or null — this just asserts that to `node:sqlite`'s narrower parameter
 * type rather than threading `SQLInputValue` through every call site.
 */
function sqlParams(values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

export interface SqliteStoreOptions {
  path: string;
}

export class SqliteStore {
  readonly filePath: string;
  private readonly db: DatabaseSyncType;

  constructor(opts: SqliteStoreOptions) {
    this.filePath = opts.path;
    this.db = new DatabaseSync(opts.path);
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _easydb_tables (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sql_table TEXT NOT NULL,
        ordinal INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _easydb_docs (
        coll TEXT NOT NULL,
        key TEXT NOT NULL,
        workspaceId TEXT,
        doc TEXT NOT NULL,
        PRIMARY KEY (coll, key)
      );
      CREATE INDEX IF NOT EXISTS _easydb_docs_coll_workspace ON _easydb_docs (coll, workspaceId);
    `);
  }

  // -- public API ---------------------------------------------------------

  find(coll: string, query?: Record<string, unknown>): unknown[] {
    if (coll === 'tables') return this.findTables(query);
    if (coll === 'rows') return this.findRows(query);
    return this.findDocs(coll, query);
  }

  findOne(coll: string, key: string): unknown | null {
    if (coll === 'tables') return this.readTableDoc(key);
    if (coll === 'rows') return this.findOneRow(key);
    docPk(coll);
    const row = this.db
      .prepare(`SELECT doc FROM _easydb_docs WHERE coll = ? AND key = ?`)
      .get(coll, key) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as unknown) : null;
  }

  insert(coll: string, doc: Record<string, unknown>): unknown {
    this.db.exec('BEGIN');
    try {
      const result = this.insertNoTx(coll, doc);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  bulkInsert(coll: string, docs: Record<string, unknown>[]): unknown[] {
    if (docs.length === 0) return [];
    this.db.exec('BEGIN');
    try {
      for (const doc of docs) this.insertNoTx(coll, doc);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return docs;
  }

  upsert(coll: string, doc: Record<string, unknown>): unknown {
    this.db.exec('BEGIN');
    try {
      const result = this.upsertNoTx(coll, doc);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  patch(coll: string, key: string, patch: Record<string, unknown>): unknown {
    const existing = this.findOne(coll, key) as Record<string, unknown> | null;
    if (!existing) {
      throw new Error(`SqliteStore.patch: no doc in "${coll}" with key "${key}"`);
    }
    const merged = { ...existing, ...patch };
    return this.upsert(coll, merged);
  }

  remove(coll: string, key: string): void {
    this.db.exec('BEGIN');
    try {
      this.removeNoTx(coll, key);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  bulkRemove(coll: string, keys: string[]): void {
    if (keys.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const key of keys) this.removeNoTx(coll, key);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  count(coll: string): number {
    if (coll === 'tables') {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM _easydb_tables`).get() as { n: number };
      return r.n;
    }
    if (coll === 'rows') return this.countRows();
    docPk(coll);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM _easydb_docs WHERE coll = ?`).get(
      coll,
    ) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }

  // -- dispatch: insert/upsert/remove without an owned transaction --------
  //
  // `node:sqlite` has no nested transactions ("cannot start a transaction
  // within a transaction"), so `bulkInsert`/`bulkRemove` call these directly
  // inside their own single BEGIN/COMMIT, while the public single-item
  // methods above each open their own transaction around one call.

  private insertNoTx(coll: string, doc: Record<string, unknown>): unknown {
    if (coll === 'tables') return this.writeTableNoTx('insert', doc);
    if (coll === 'rows') return this.writeRowNoTx('insert', doc);
    return this.writeDocNoTx('insert', coll, doc);
  }

  private upsertNoTx(coll: string, doc: Record<string, unknown>): unknown {
    if (coll === 'tables') return this.writeTableNoTx('upsert', doc);
    if (coll === 'rows') return this.writeRowNoTx('upsert', doc);
    return this.writeDocNoTx('upsert', coll, doc);
  }

  private removeNoTx(coll: string, key: string): void {
    if (coll === 'tables') return this.removeTableNoTx(key);
    if (coll === 'rows') return this.removeRowNoTx(key);
    docPk(coll);
    this.db.prepare(`DELETE FROM _easydb_docs WHERE coll = ? AND key = ?`).run(coll, key);
  }

  // -- `_easydb_docs`: workspaces / settings / plugins / viewTemplates / viewInstances --

  private findDocs(coll: string, query?: Record<string, unknown>): unknown[] {
    docPk(coll);
    const entries = Object.entries(query ?? {});
    // `workspaceId` is a real column so `settings` (workspace-scoped) can
    // filter in SQL; every other key is a JS fallback over the parsed doc,
    // same as the previous whole-document implementation.
    const wsEntry = entries.find(([k]) => k === 'workspaceId');
    const remaining = entries.filter(([k]) => k !== 'workspaceId');
    let sql = `SELECT doc FROM _easydb_docs WHERE coll = ?`;
    const params: unknown[] = [coll];
    if (wsEntry) {
      sql += ' AND workspaceId = ?';
      params.push(wsEntry[1]);
    }
    const rows = this.db.prepare(sql).all(...sqlParams(params)) as Array<{ doc: string }>;
    let docs = rows.map((r) => JSON.parse(r.doc) as Record<string, unknown>);
    if (remaining.length > 0) docs = docs.filter((d) => matchesAll(d, remaining));
    return docs;
  }

  private writeDocNoTx(
    mode: 'insert' | 'upsert',
    coll: string,
    doc: Record<string, unknown>,
  ): unknown {
    const pk = docPk(coll);
    const key = doc[pk];
    if (typeof key !== 'string') {
      throw new Error(`SqliteStore.${mode}: "${coll}" doc is missing its primary key "${pk}"`);
    }
    const workspaceId = typeof doc.workspaceId === 'string' ? doc.workspaceId : null;
    const json = JSON.stringify(doc);
    if (mode === 'insert') {
      this.db
        .prepare(`INSERT INTO _easydb_docs (coll, key, workspaceId, doc) VALUES (?, ?, ?, ?)`)
        .run(...sqlParams([coll, key, workspaceId, json]));
    } else {
      this.db
        .prepare(
          `INSERT INTO _easydb_docs (coll, key, workspaceId, doc) VALUES (?, ?, ?, ?)
           ON CONFLICT(coll, key) DO UPDATE SET workspaceId = excluded.workspaceId, doc = excluded.doc`,
        )
        .run(...sqlParams([coll, key, workspaceId, json]));
    }
    return doc;
  }

  // -- `tables`: registry + per-table SQL rows table + per-table meta table --

  private metaTableName(sqlTable: string): string {
    return `_easydb_meta_${sqlTable}`;
  }

  /**
   * Picks the physical SQL table name for a brand-new table id: the
   * sanitised `Table.name`, falling back to `table` when empty or when it
   * collides with a reserved `_easydb*` name, then `_2`, `_3`, … against
   * whatever is already registered. Once assigned this name is never
   * revisited — a later rename of `Table.name` only updates the registry's
   * `name` column and `table_json`, never `sql_table` (renaming the SQL
   * table risks a fresh collision for no benefit).
   */
  private resolveSqlTableName(base: string): string {
    const used = new Set(
      (
        this.db.prepare(`SELECT sql_table FROM _easydb_tables`).all() as Array<{
          sql_table: string;
        }>
      ).map((r) => r.sql_table),
    );
    const isReserved = (s: string) => /^_easydb/i.test(s);
    const safeBase = base.length > 0 && !isReserved(base) ? base : 'table';
    let candidate = safeBase;
    let n = 2;
    while (used.has(candidate)) candidate = `${safeBase}_${n++}`;
    return candidate;
  }

  private readColumnsJson(sqlTable: string): ColumnSpec[] {
    const row = this.db
      .prepare(`SELECT columns_json FROM ${quoteIdent(this.metaTableName(sqlTable))}`)
      .get() as { columns_json: string } | undefined;
    return row ? (JSON.parse(row.columns_json) as ColumnSpec[]) : [];
  }

  /** Reconstructs a full `Table` doc (table_json + parsed columns) for a registered id. */
  private readTableDoc(id: string): unknown | null {
    const reg = this.db.prepare(`SELECT sql_table FROM _easydb_tables WHERE id = ?`).get(id) as
      | { sql_table: string }
      | undefined;
    if (!reg) return null;
    const metaRow = this.db
      .prepare(
        `SELECT columns_json, table_json FROM ${quoteIdent(this.metaTableName(reg.sql_table))}`,
      )
      .get() as { columns_json: string; table_json: string } | undefined;
    if (!metaRow) return null;
    const tableRest = JSON.parse(metaRow.table_json) as Record<string, unknown>;
    const columns = JSON.parse(metaRow.columns_json) as ColumnSpec[];
    return { ...tableRest, columns };
  }

  private findTables(query?: Record<string, unknown>): unknown[] {
    const ids = (
      this.db.prepare(`SELECT id FROM _easydb_tables ORDER BY ordinal`).all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    let docs = ids
      .map((id) => this.readTableDoc(id))
      .filter((d): d is Record<string, unknown> => d !== null);
    const entries = Object.entries(query ?? {});
    if (entries.length > 0) docs = docs.filter((d) => matchesAll(d, entries));
    return docs;
  }

  /**
   * Insert-or-update a `tables` doc: assigns/reuses `sql_table`, additively
   * reconciles the SQL rows table's columns against the new `columns_json`,
   * and rewrites the registry + meta rows — all in one transaction owned by
   * the caller (`insert`/`upsert`/`bulkInsert`).
   */
  private writeTableNoTx(mode: 'insert' | 'upsert', doc: Record<string, unknown>): unknown {
    const id = doc.id;
    if (typeof id !== 'string') {
      throw new Error(`SqliteStore.${mode}: "tables" doc is missing its primary key "id"`);
    }
    const existing = this.db.prepare(`SELECT sql_table FROM _easydb_tables WHERE id = ?`).get(
      id,
    ) as { sql_table: string } | undefined;
    if (mode === 'insert' && existing) {
      throw new Error(`SqliteStore.insert: "tables" doc with id "${id}" already exists`);
    }

    const name = typeof doc.name === 'string' ? doc.name : '';
    const columns = (Array.isArray(doc.columns) ? doc.columns : []) as ColumnSpec[];
    const tableRest: Record<string, unknown> = { ...doc };
    delete tableRest.columns;

    let sqlTable: string;
    if (existing) {
      // Reuse the already-assigned SQL table name even if `name` changed —
      // see `resolveSqlTableName`'s comment for why it never moves.
      sqlTable = existing.sql_table;
      this.db.prepare(`UPDATE _easydb_tables SET name = ? WHERE id = ?`).run(name, id);
    } else {
      sqlTable = this.resolveSqlTableName(sanitizeTableName(name));
      const nextOrdinal = (
        this.db
          .prepare(`SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM _easydb_tables`)
          .get() as { next: number }
      ).next;
      this.db.exec(
        `CREATE TABLE ${quoteIdent(sqlTable)} (_id TEXT PRIMARY KEY, _updatedAt INTEGER, _extra TEXT)`,
      );
      this.db.exec(
        `CREATE TABLE ${quoteIdent(this.metaTableName(sqlTable))} (columns_json TEXT NOT NULL, table_json TEXT NOT NULL)`,
      );
      this.db
        .prepare(`INSERT INTO _easydb_tables (id, name, sql_table, ordinal) VALUES (?, ?, ?, ?)`)
        .run(...sqlParams([id, name, sqlTable, nextOrdinal]));
    }

    this.reconcileColumnsNoTx(sqlTable, columns);

    const metaTable = this.metaTableName(sqlTable);
    this.db.exec(`DELETE FROM ${quoteIdent(metaTable)}`);
    this.db
      .prepare(`INSERT INTO ${quoteIdent(metaTable)} (columns_json, table_json) VALUES (?, ?)`)
      .run(...sqlParams([JSON.stringify(columns), JSON.stringify(tableRest)]));

    return this.readTableDoc(id);
  }

  /**
   * Additive-only column reconciliation: every field in `columns` gets a SQL
   * column if it doesn't already have one. Never RENAME, never DROP —
   * `ColumnSpec` has no stable id, so a rename is indistinguishable from a
   * drop-plus-add when diffing two column lists, and dropping on that guess
   * would silently destroy data (the exact bug fixed in v0.0.218 — see
   * `renameRowFields` in `packages/renderer/src/table/column-merge.ts`). A
   * column removed from `columns` just lingers in the SQL schema afterwards,
   * orphaned and harmless: `columns_json` (not the DDL) stays authoritative
   * for what is visible. A rename shows up here as a brand-new column added
   * alongside the old one — the renderer already re-keys row `data` on
   * rename, so the row's value lands in the new column naturally.
   */
  private reconcileColumnsNoTx(sqlTable: string, columns: ColumnSpec[]): void {
    const info = this.db.prepare(`PRAGMA table_info(${quoteIdent(sqlTable)})`).all() as Array<{
      name: string;
    }>;
    const existing = new Set(info.map((c) => c.name));
    for (const spec of columns) {
      if (existing.has(spec.field)) continue;
      this.db.exec(
        `ALTER TABLE ${quoteIdent(sqlTable)} ADD COLUMN ${quoteIdent(spec.field)} ${sqlAffinity(spec.type)}`,
      );
      existing.add(spec.field);
    }
  }

  private removeTableNoTx(id: string): void {
    const reg = this.db.prepare(`SELECT sql_table FROM _easydb_tables WHERE id = ?`).get(id) as
      | { sql_table: string }
      | undefined;
    if (!reg) return;
    this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(reg.sql_table)}`);
    this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(this.metaTableName(reg.sql_table))}`);
    this.db.prepare(`DELETE FROM _easydb_tables WHERE id = ?`).run(id);
  }

  // -- `rows`: one physical rows table per registered `tables` id ----------

  private allRegisteredTables(): Array<{ id: string; sql_table: string }> {
    return this.db
      .prepare(`SELECT id, sql_table FROM _easydb_tables ORDER BY ordinal`)
      .all() as Array<{ id: string; sql_table: string }>;
  }

  private resolveRowsTable(tableId: string): string {
    const row = this.db.prepare(`SELECT sql_table FROM _easydb_tables WHERE id = ?`).get(
      tableId,
    ) as { sql_table: string } | undefined;
    if (!row) throw new Error(`SqliteStore: unknown tableId "${tableId}" for collection "rows"`);
    return row.sql_table;
  }

  /**
   * Splits a row's `data` into promoted-column values (one per `ColumnSpec`,
   * `encodeValue`d) and an "overflow" object for keys `columns` doesn't know
   * about. The overflow is a data-fidelity safety net: Dexie's `data` is
   * schemaless, so a row carrying a field the column list doesn't (yet, or
   * no longer) know about would otherwise lose it silently on the round trip.
   */
  private encodeRowColumns(
    columns: ColumnSpec[],
    data: Record<string, unknown>,
  ): { cols: string[]; values: unknown[]; extraJson: string | null } {
    const known = new Set(columns.map((c) => c.field));
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const spec of columns) {
      cols.push(spec.field);
      values.push(encodeValue(spec.type, data[spec.field]));
    }
    const extra: Record<string, unknown> = {};
    let hasExtra = false;
    for (const [k, v] of Object.entries(data)) {
      if (!known.has(k)) {
        extra[k] = v;
        hasExtra = true;
      }
    }
    return { cols, values, extraJson: hasExtra ? JSON.stringify(extra) : null };
  }

  /**
   * Rebuilds a `Row`-shaped doc from a raw SQL row. A decoded column value of
   * `null` is OMITTED from `data` (not set to `null`) so a round-tripped row
   * matches what a plain Dexie collection would return for a row that never
   * had the field — see the report for why this reading of "missing vs
   * null" was chosen. `updatedAt` is likewise only included when set.
   */
  private decodeRow(tableId: string, columns: ColumnSpec[], raw: Record<string, unknown>): unknown {
    const data: Record<string, unknown> = {};
    for (const spec of columns) {
      const decoded = decodeValue(spec.type, raw[spec.field]);
      if (decoded !== null) data[spec.field] = decoded;
    }
    const extraJson = raw._extra as string | null;
    if (extraJson) Object.assign(data, JSON.parse(extraJson) as Record<string, unknown>);
    const updatedAt = raw._updatedAt as number | null;
    return {
      id: raw._id as string,
      tableId,
      data,
      ...(updatedAt != null ? { updatedAt } : {}),
    };
  }

  private findRows(query?: Record<string, unknown>): unknown[] {
    const entries = Object.entries(query ?? {});
    const tableIdEntry = entries.find(([k]) => k === 'tableId');
    const remaining = entries.filter(([k]) => k !== 'tableId');

    const tables = tableIdEntry
      ? this.allRegisteredTables().filter((t) => t.id === tableIdEntry[1])
      : this.allRegisteredTables();

    let result: unknown[] = [];
    for (const t of tables) {
      const columns = this.readColumnsJson(t.sql_table);
      const raws = this.db.prepare(`SELECT * FROM ${quoteIdent(t.sql_table)}`).all() as Array<
        Record<string, unknown>
      >;
      for (const raw of raws) result.push(this.decodeRow(t.id, columns, raw));
    }
    if (remaining.length > 0) {
      result = result.filter((r) => matchesRow(r as Record<string, unknown>, remaining));
    }
    return result;
  }

  private findOneRow(id: string): unknown | null {
    for (const t of this.allRegisteredTables()) {
      const raw = this.db.prepare(`SELECT * FROM ${quoteIdent(t.sql_table)} WHERE _id = ?`).get(
        id,
      ) as Record<string, unknown> | undefined;
      if (raw) {
        const columns = this.readColumnsJson(t.sql_table);
        return this.decodeRow(t.id, columns, raw);
      }
    }
    return null;
  }

  private countRows(): number {
    let total = 0;
    for (const t of this.allRegisteredTables()) {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t.sql_table)}`).get() as {
        n: number;
      };
      total += r.n;
    }
    return total;
  }

  private writeRowNoTx(mode: 'insert' | 'upsert', doc: Record<string, unknown>): unknown {
    const id = doc.id;
    const tableId = doc.tableId;
    if (typeof id !== 'string') {
      throw new Error(`SqliteStore.${mode}: "rows" doc is missing its primary key "id"`);
    }
    if (typeof tableId !== 'string') {
      throw new Error(`SqliteStore.${mode}: "rows" doc is missing its "tableId"`);
    }
    const sqlTable = this.resolveRowsTable(tableId);
    const columns = this.readColumnsJson(sqlTable);
    const { cols, values, extraJson } = this.encodeRowColumns(
      columns,
      (doc.data as Record<string, unknown>) ?? {},
    );
    const updatedAt = typeof doc.updatedAt === 'number' ? doc.updatedAt : null;
    const allCols = ['_id', '_updatedAt', '_extra', ...cols];
    const placeholders = allCols.map(() => '?').join(', ');
    const conflictClause =
      mode === 'upsert'
        ? ` ON CONFLICT(_id) DO UPDATE SET ${allCols
            .filter((c) => c !== '_id')
            .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
            .join(', ')}`
        : '';
    this.db
      .prepare(
        `INSERT INTO ${quoteIdent(sqlTable)} (${allCols.map(quoteIdent).join(', ')}) VALUES (${placeholders})${conflictClause}`,
      )
      .run(...sqlParams([id, updatedAt, extraJson, ...values]));
    const raw = this.db.prepare(`SELECT * FROM ${quoteIdent(sqlTable)} WHERE _id = ?`).get(
      id,
    ) as Record<string, unknown>;
    return this.decodeRow(tableId, columns, raw);
  }

  private removeRowNoTx(id: string): void {
    for (const t of this.allRegisteredTables()) {
      const res = this.db.prepare(`DELETE FROM ${quoteIdent(t.sql_table)} WHERE _id = ?`).run(id);
      if (res.changes > 0) return;
    }
  }
}

/**
 * Copies the database file to a new path — used for "Save As". Assumes the
 * source store is closed (or at least not mid-write): SQLite's file format
 * means a raw file copy while a transaction is open could capture a torn
 * write. Callers should `close()` (or otherwise quiesce) the source
 * `SqliteStore` before calling this.
 */
export function copyDatabase(fromPath: string, toPath: string): void {
  copyFileSync(fromPath, toPath);
}
