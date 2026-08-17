/**
 * The `.edb` store — format v2.
 *
 * One body of code over a {@link SqlDriver}, so the same storage logic serves
 * the desktop (`node:sqlite`) and a browser worker (`@sqlite.org/sqlite-wasm`).
 * Pure: no I/O of its own, no Node APIs, no DOM.
 *
 * ## Layout
 *
 * **Row data is relational.** A user table becomes a REAL SQL table: one row
 * per `Row`, one column per `ColumnSpec`. That is what makes a saved `.edb` a
 * genuine database — openable in DB Browser or Datasette — rather than an opaque
 * blob, and it is the whole point of the format.
 *
 * **Everything else is one table.** `workspaces`, `settings`, `plugins`,
 * `viewTemplates`, `viewInstances` and the `tables` documents themselves all
 * live in `_easydb` as `(coll, key, workspaceId, doc)`. These are small and
 * never need querying beyond their primary key and, for settings and view
 * instances, `workspaceId`.
 *
 * **This is the only format.** v1 — an `_easydb_tables` registry plus a per-table
 * `_easydb_meta_<name>`, which the desktop wrote between v0.0.313 and v0.0.355 —
 * is gone, with no migration and no read path. A v1 file does not open. That was
 * a deliberate call: carrying a second layout meant two code paths through every
 * read and write, forever, to serve files from a two-month window of a
 * pre-1.0 app.
 *
 * `coll='_meta', key='format'` is how a file is recognised as ours, and is what a
 * future format change has to look at.
 */

import { buildWhere } from './filter-sql.js';
import type { DistinctPage, DistinctQuery, RowPage, RowQuery } from './row-query.js';
import type { SqlDriver } from './sql-driver.js';
import { decodeValue, encodeValue, quoteIdent, sanitizeTableName, sqlAffinity } from './sql-mapping.js';
import type { ColumnSpec, Row } from './types.js';

/** What `coll='_meta', key='format'` holds. Read before anything else is trusted. */
export interface EdbFormat {
  version: number;
  app: 'easydbaccess';
}

export const EDB_FORMAT_VERSION = 2;

/** Collections kept as documents in `_easydb`, keyed by their primary-key field. */
const DOC_COLLECTIONS: Record<string, string> = {
  workspaces: 'id',
  settings: 'key',
  plugins: 'url',
  viewTemplates: 'id',
  viewInstances: 'id',
};

/**
 * Storage-only fields held inside a stored `tables` doc and stripped on the way
 * out, so a caller never sees them and cannot overwrite them by accident.
 *
 * They live in the doc rather than in columns of their own because that is what
 * lets `_easydb` stay a single generic table. There are tens of tables, not
 * millions, so scanning `coll='tables'` to answer "which physical name is free"
 * costs less than an index would.
 */
const SQL_TABLE_KEY = '_sqlTable';
const ORDINAL_KEY = '_ordinal';

function unknownCollection(coll: string): Error {
  const known = ['tables', 'rows', ...Object.keys(DOC_COLLECTIONS)].join(', ');
  return new Error(`EdbStore: unknown collection "${coll}" (known: ${known})`);
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
 * Matcher for a reconstructed `Row` (`{id, tableId, data, updatedAt}`): a query
 * key naming a top-level `Row` field matches there, anything else is checked
 * against `data`. A caller writing `find('rows', {status: 'done'})` means the
 * `status` field of the row, not a property called `status` on the envelope.
 */
function matchesRow(row: Row, entries: Array<[string, unknown]>): boolean {
  // The lookup is dynamic by nature — the key comes from the caller's query —
  // so the envelope is read through an index signature it does not declare.
  const envelope = row as unknown as Record<string, unknown>;
  const data = row.data ?? {};
  for (const [k, v] of entries) {
    const actual = k in envelope ? envelope[k] : data[k];
    if (actual !== v) return false;
  }
  return true;
}

export class EdbStore {
  private readonly db: SqlDriver;

  constructor(driver: SqlDriver) {
    this.db = driver;
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _easydb (
        coll        TEXT NOT NULL,
        key         TEXT NOT NULL,
        workspaceId TEXT,
        doc         TEXT NOT NULL,
        PRIMARY KEY (coll, key)
      );
      CREATE INDEX IF NOT EXISTS _easydb_coll_ws ON _easydb (coll, workspaceId);
    `);
    // Stamp the format on a file that has none. An existing stamp is left alone:
    // reading a NEWER file than this code understands must not be papered over by
    // quietly relabelling it.
    if (!this.format()) {
      this.putRaw('_meta', 'format', null, { version: EDB_FORMAT_VERSION, app: 'easydbaccess' } satisfies EdbFormat);
    }
  }

  /** The file's format stamp, or null on a file that carries none (v1, or foreign). */
  format(): EdbFormat | null {
    const row = this.db.prepare(`SELECT doc FROM _easydb WHERE coll = '_meta' AND key = 'format'`).get();
    return row ? (JSON.parse(String(row.doc)) as EdbFormat) : null;
  }

  // -- generic doc access -------------------------------------------------

  private putRaw(coll: string, key: string, workspaceId: string | null, doc: unknown): void {
    this.db.prepare(`INSERT OR REPLACE INTO _easydb (coll, key, workspaceId, doc) VALUES (?, ?, ?, ?)`).run(coll, key, workspaceId, JSON.stringify(doc));
  }

  private getRaw(coll: string, key: string): Record<string, unknown> | null {
    const row = this.db.prepare(`SELECT doc FROM _easydb WHERE coll = ? AND key = ?`).get(coll, key);
    return row ? (JSON.parse(String(row.doc)) as Record<string, unknown>) : null;
  }

  // -- public API --------------------------------------------------------

  find(coll: string, query?: Record<string, unknown>, limit?: number): unknown[] {
    if (coll === 'tables') return this.findTables(query);
    if (coll === 'rows') return this.findRows(query, limit);
    return this.findDocs(coll, query);
  }

  findOne(coll: string, key: string): unknown | null {
    if (coll === 'tables') return this.readTableDoc(key);
    if (coll === 'rows') return this.findOneRow(key);
    docPk(coll);
    return this.getRaw(coll, key);
  }

  insert(coll: string, doc: Record<string, unknown>): unknown {
    return this.tx(() => this.insertNoTx(coll, doc));
  }

  upsert(coll: string, doc: Record<string, unknown>): unknown {
    return this.tx(() => this.writeNoTx('upsert', coll, doc));
  }

  bulkInsert(coll: string, docs: Record<string, unknown>[]): unknown[] {
    if (docs.length === 0) return [];
    this.tx(() => {
      if (coll === 'rows') this.bulkInsertRowsNoTx(docs);
      else for (const doc of docs) this.insertNoTx(coll, doc);
    });
    return docs;
  }

  patch(coll: string, key: string, patch: Record<string, unknown>): unknown {
    return this.tx(() => {
      const current = coll === 'tables' ? this.readTableDoc(key) : coll === 'rows' ? this.findOneRow(key) : this.getRaw(coll, key);
      if (!current) throw new Error(`EdbStore.patch: no "${coll}" document with key "${key}"`);
      return this.writeNoTx('upsert', coll, { ...(current as Record<string, unknown>), ...patch });
    });
  }

  /**
   * Removes one document. For `rows`, returns the table it came out of.
   *
   * The return value exists for the change broadcast, not for the caller's own
   * use: a `remove` request names a row id and nothing else, so without this the
   * broadcast has no scope and every open grid re-reads itself.
   */
  remove(coll: string, key: string): string | undefined {
    return this.tx(() => this.removeNoTx(coll, key));
  }

  /** Removes many. For `rows`, returns the distinct tables they came out of. */
  bulkRemove(coll: string, keys: string[]): string[] {
    if (keys.length === 0) return [];
    return this.tx(() => {
      const touched = new Set<string>();
      for (const key of keys) {
        const tableId = this.removeNoTx(coll, key);
        if (tableId !== undefined) touched.add(tableId);
      }
      return [...touched];
    });
  }

  count(coll: string): number {
    if (coll === 'rows') return this.countAllRows();
    if (coll === 'tables') {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM _easydb WHERE coll = 'tables'`).get();
      return Number(r?.n ?? 0);
    }
    docPk(coll);
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM _easydb WHERE coll = ?`).get(coll);
    return Number(r?.n ?? 0);
  }

  /**
   * The physical SQL table behind a logical table id, or null when there is no
   * such table. For code that reads the file directly — the desktop's importer
   * streams rows straight out of it.
   */
  sqlTableOf(tableId: string): string | null {
    const stored = this.getRaw('tables', tableId);
    return stored ? String(stored[SQL_TABLE_KEY]) : null;
  }

  /**
   * Row count for ONE table, without fetching any of them.
   *
   * An unknown id counts 0 rather than throwing. This is a panel-title read, and
   * it races deletion: the panel asks for its count while the table is going
   * away. Throwing there turned a stale question into an error dialog.
   */
  countRowsIn(tableId: string): number {
    const sqlTable = this.sqlTableOf(tableId);
    if (sqlTable === null) return 0;
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(sqlTable)}`).get();
    return Number(r?.n ?? 0);
  }

  // -- transactions ------------------------------------------------------

  private tx<T>(body: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insertNoTx(coll: string, doc: Record<string, unknown>): unknown {
    return this.writeNoTx('insert', coll, doc);
  }

  private writeNoTx(mode: 'insert' | 'upsert', coll: string, doc: Record<string, unknown>): unknown {
    if (coll === 'tables') return this.writeTableNoTx(mode, doc);
    if (coll === 'rows') return this.writeRowNoTx(mode, doc);
    return this.writeDocNoTx(mode, coll, doc);
  }

  /** Returns the table a ROW was removed from, so the caller can scope its broadcast. */
  private removeNoTx(coll: string, key: string): string | undefined {
    if (coll === 'tables') {
      this.removeTableNoTx(key);
      return undefined;
    }
    if (coll === 'rows') return this.removeRowNoTx(key);
    docPk(coll);
    this.db.prepare(`DELETE FROM _easydb WHERE coll = ? AND key = ?`).run(coll, key);
    return undefined;
  }

  // -- document collections ----------------------------------------------

  private findDocs(coll: string, query?: Record<string, unknown>): unknown[] {
    docPk(coll);
    // `workspaceId` is a real column, so push that one down to SQL — it is the
    // only query key hot enough to matter (every settings read carries it).
    const ws = query?.workspaceId;
    const rows =
      typeof ws === 'string'
        ? this.db.prepare(`SELECT doc FROM _easydb WHERE coll = ? AND workspaceId = ?`).all(coll, ws)
        : this.db.prepare(`SELECT doc FROM _easydb WHERE coll = ?`).all(coll);
    let docs = rows.map((r) => JSON.parse(String(r.doc)) as Record<string, unknown>);
    const entries = Object.entries(query ?? {}).filter(([k]) => k !== 'workspaceId' || typeof ws !== 'string');
    if (entries.length > 0) docs = docs.filter((d) => matchesAll(d, entries));
    return docs;
  }

  private writeDocNoTx(mode: 'insert' | 'upsert', coll: string, doc: Record<string, unknown>): unknown {
    const pk = docPk(coll);
    const key = doc[pk];
    if (typeof key !== 'string') {
      throw new Error(`EdbStore.${mode}: "${coll}" doc is missing its primary key "${pk}"`);
    }
    if (mode === 'insert' && this.getRaw(coll, key)) {
      throw new Error(`EdbStore.insert: "${coll}" doc with ${pk} "${key}" already exists`);
    }
    const workspaceId = typeof doc.workspaceId === 'string' ? doc.workspaceId : null;
    this.putRaw(coll, key, workspaceId, doc);
    return doc;
  }

  // -- tables -------------------------------------------------------------

  /**
   * Picks the physical SQL table name for a brand-new table id: the sanitised
   * `Table.name`, falling back to `table` when it is empty or would collide with
   * a reserved `_easydb*` name, then `_2`, `_3`, … against what is already taken.
   *
   * Assigned once and never revisited. Renaming `Table.name` rewrites the doc
   * only — moving the SQL object would risk a fresh collision and buy nothing,
   * since nothing outside the doc addresses a table by its physical name.
   */
  private resolveSqlTableName(base: string): string {
    const used = new Set(this.storedTableDocs().map((d) => String(d[SQL_TABLE_KEY])));
    const isReserved = (s: string) => /^_easydb/i.test(s);
    const safeBase = base.length > 0 && !isReserved(base) ? base : 'table';
    let candidate = safeBase;
    let n = 2;
    while (used.has(candidate)) candidate = `${safeBase}_${n++}`;
    return candidate;
  }

  /** Every stored `tables` doc, storage fields still attached, in ordinal order. */
  private storedTableDocs(): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT doc FROM _easydb WHERE coll = 'tables'`)
      .all()
      .map((r) => JSON.parse(String(r.doc)) as Record<string, unknown>)
      .sort((a, b) => Number(a[ORDINAL_KEY] ?? 0) - Number(b[ORDINAL_KEY] ?? 0));
  }

  /** Strips the storage-only fields, so a caller sees a plain `Table`. */
  private publicTableDoc(stored: Record<string, unknown>): Record<string, unknown> {
    const doc = { ...stored };
    delete doc[SQL_TABLE_KEY];
    delete doc[ORDINAL_KEY];
    return doc;
  }

  private readTableDoc(id: string): unknown | null {
    const stored = this.getRaw('tables', id);
    return stored ? this.publicTableDoc(stored) : null;
  }

  private findTables(query?: Record<string, unknown>): unknown[] {
    let docs = this.storedTableDocs().map((d) => this.publicTableDoc(d));
    const entries = Object.entries(query ?? {});
    if (entries.length > 0) docs = docs.filter((d) => matchesAll(d, entries));
    return docs;
  }

  private columnsOf(stored: Record<string, unknown>): ColumnSpec[] {
    return (Array.isArray(stored.columns) ? stored.columns : []) as ColumnSpec[];
  }

  /**
   * Insert-or-update a `tables` doc: assigns or reuses the physical name,
   * additively reconciles the SQL table's columns, and rewrites the doc — inside
   * the caller's transaction.
   */
  private writeTableNoTx(mode: 'insert' | 'upsert', doc: Record<string, unknown>): unknown {
    const id = doc.id;
    if (typeof id !== 'string') {
      throw new Error(`EdbStore.${mode}: "tables" doc is missing its primary key "id"`);
    }
    const existing = this.getRaw('tables', id);
    if (mode === 'insert' && existing) {
      throw new Error(`EdbStore.insert: "tables" doc with id "${id}" already exists`);
    }

    const name = typeof doc.name === 'string' ? doc.name : '';
    const columns = this.columnsOf(doc);

    let sqlTable: string;
    let ordinal: number;
    if (existing) {
      sqlTable = String(existing[SQL_TABLE_KEY]);
      ordinal = Number(existing[ORDINAL_KEY] ?? 0);
    } else {
      sqlTable = this.resolveSqlTableName(sanitizeTableName(name));
      ordinal = this.storedTableDocs().reduce((max, d) => Math.max(max, Number(d[ORDINAL_KEY] ?? -1)), -1) + 1;
      this.db.exec(`CREATE TABLE ${quoteIdent(sqlTable)} (_id TEXT PRIMARY KEY, _updatedAt INTEGER, _extra TEXT)`);
    }

    this.reconcileColumnsNoTx(sqlTable, columns);

    const stored: Record<string, unknown> = { ...doc, [SQL_TABLE_KEY]: sqlTable, [ORDINAL_KEY]: ordinal };
    const workspaceId = typeof doc.workspaceId === 'string' ? doc.workspaceId : null;
    this.putRaw('tables', id, workspaceId, stored);
    return this.publicTableDoc(stored);
  }

  /**
   * Additive-only column reconciliation: a field with no SQL column gets one.
   * Never RENAME, never DROP.
   *
   * `ColumnSpec` has no stable id, so diffing two column lists cannot tell a
   * rename from a drop-plus-add — and dropping on that guess destroyed data
   * once already (v0.0.218). A column dropped from `columns` just lingers,
   * orphaned and harmless: the doc, not the DDL, says what is visible. A rename
   * arrives here as a new column beside the old one, and the renderer re-keys
   * row `data` on rename, so the value lands in the new column by itself.
   */
  private reconcileColumnsNoTx(sqlTable: string, columns: ColumnSpec[]): void {
    const existing = new Set(this.db.prepare(`PRAGMA table_info(${quoteIdent(sqlTable)})`).all().map((c) => String(c.name)));
    for (const spec of columns) {
      if (existing.has(spec.field)) continue;
      this.db.exec(`ALTER TABLE ${quoteIdent(sqlTable)} ADD COLUMN ${quoteIdent(spec.field)} ${sqlAffinity(spec.type)}`);
      existing.add(spec.field);
    }
  }

  private removeTableNoTx(id: string): void {
    const stored = this.getRaw('tables', id);
    if (!stored) return;
    this.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(String(stored[SQL_TABLE_KEY]))}`);
    this.db.prepare(`DELETE FROM _easydb WHERE coll = 'tables' AND key = ?`).run(id);
  }

  // -- rows ---------------------------------------------------------------

  private resolveRowsTable(tableId: string): string {
    const stored = this.getRaw('tables', tableId);
    if (!stored) throw new Error(`EdbStore: no table registered with id "${tableId}"`);
    return String(stored[SQL_TABLE_KEY]);
  }

  private tableContext(tableId: string): { sqlTable: string; columns: ColumnSpec[] } {
    const stored = this.getRaw('tables', tableId);
    if (!stored) throw new Error(`EdbStore: no table registered with id "${tableId}"`);
    return { sqlTable: String(stored[SQL_TABLE_KEY]), columns: this.columnsOf(stored) };
  }

  /**
   * Splits a row's `data` into bound column values plus JSON overflow.
   *
   * `Row.data` may carry keys no `ColumnSpec` describes — a CSV column the user
   * hid, a field added by a plugin. Those go to `_extra` rather than being
   * dropped. `_extra` is SQL NULL when empty (not `'{}'`), which is what lets a
   * round-tripped row equal a freshly built one.
   */
  private encodeRowColumns(columns: ColumnSpec[], data: Record<string, unknown>): { cols: string[]; values: unknown[]; extraJson: string | null } {
    const byField = new Map(columns.map((c) => [c.field, c]));
    const cols: string[] = [];
    const values: unknown[] = [];
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const spec = byField.get(key);
      if (spec) {
        cols.push(spec.field);
        values.push(encodeValue(spec.type, value));
      } else if (value !== undefined) {
        extra[key] = value;
      }
    }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
    return { cols, values, extraJson };
  }

  private decodeRow(tableId: string, columns: ColumnSpec[], raw: Record<string, unknown>): Row {
    const data: Record<string, unknown> = {};
    for (const spec of columns) {
      if (!(spec.field in raw)) continue;
      const decoded = decodeValue(spec.type, raw[spec.field]);
      // A decoded null is omitted so the row matches one that never held the key.
      if (decoded !== null) data[spec.field] = decoded;
    }
    const extra = raw._extra;
    if (typeof extra === 'string' && extra.length > 0) Object.assign(data, JSON.parse(extra) as Record<string, unknown>);
    return { id: String(raw._id), tableId, data, updatedAt: Number(raw._updatedAt ?? 0) };
  }

  private writeRowNoTx(mode: 'insert' | 'upsert', doc: Record<string, unknown>): unknown {
    const id = doc.id;
    const tableId = doc.tableId;
    if (typeof id !== 'string') throw new Error(`EdbStore.${mode}: "rows" doc is missing its primary key "id"`);
    if (typeof tableId !== 'string') throw new Error(`EdbStore.${mode}: "rows" doc is missing "tableId"`);
    const { sqlTable, columns } = this.tableContext(tableId);
    if (mode === 'insert') {
      const clash = this.db.prepare(`SELECT _id FROM ${quoteIdent(sqlTable)} WHERE _id = ?`).get(id);
      if (clash) throw new Error(`EdbStore.insert: "rows" doc with id "${id}" already exists`);
    }
    const data = (doc.data as Record<string, unknown>) ?? {};
    const updatedAt = typeof doc.updatedAt === 'number' ? doc.updatedAt : 0;
    const { cols, values, extraJson } = this.encodeRowColumns(columns, data);
    const allCols = ['_id', '_updatedAt', '_extra', ...cols];
    const placeholders = allCols.map(() => '?').join(', ');
    this.db
      .prepare(`INSERT OR REPLACE INTO ${quoteIdent(sqlTable)} (${allCols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`)
      .run(id, updatedAt, extraJson, ...values);
    return this.findOneRow(id);
  }

  private bulkInsertRowsNoTx(docs: Record<string, unknown>[]): void {
    // Resolve each table and compile its statement ONCE. The per-row path does
    // both for every row and then reads the row back — a primary-key lookup into
    // a B-tree keyed by random UUIDs — only for the caller to discard it. That
    // read-back is what made a 600k-row import crawl.
    const targets = new Map<string, { columns: ColumnSpec[]; sqlTable: string }>();
    for (const doc of docs) {
      const id = doc.id;
      const tableId = doc.tableId;
      if (typeof id !== 'string') throw new Error(`EdbStore.insert: "rows" doc is missing its primary key "id"`);
      if (typeof tableId !== 'string') throw new Error(`EdbStore.insert: "rows" doc is missing "tableId"`);
      let target = targets.get(tableId);
      if (!target) {
        target = this.tableContext(tableId);
        targets.set(tableId, target);
      }
      const data = (doc.data as Record<string, unknown>) ?? {};
      const updatedAt = typeof doc.updatedAt === 'number' ? doc.updatedAt : 0;
      const { cols, values, extraJson } = this.encodeRowColumns(target.columns, data);
      const allCols = ['_id', '_updatedAt', '_extra', ...cols];
      const placeholders = allCols.map(() => '?').join(', ');
      this.db
        .prepare(`INSERT OR REPLACE INTO ${quoteIdent(target.sqlTable)} (${allCols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`)
        .run(id, updatedAt, extraJson, ...values);
    }
  }

  /**
   * Deletes one row, wherever it lives, and reports WHICH table that was.
   *
   * The id alone does not say which table holds it, so this scans — see the note
   * on `findOneRow`. Returning the table it found is what lets a delete broadcast
   * a scoped change instead of waking every open grid: the request carries only
   * row ids, so the answer cannot come from anywhere else.
   *
   * `undefined` means no table held it, which is a no-op delete, not an error.
   */
  private removeRowNoTx(id: string): string | undefined {
    for (const stored of this.storedTableDocs()) {
      const sqlTable = String(stored[SQL_TABLE_KEY]);
      const hit = this.db.prepare(`SELECT _id FROM ${quoteIdent(sqlTable)} WHERE _id = ?`).get(id);
      if (hit) {
        this.db.prepare(`DELETE FROM ${quoteIdent(sqlTable)} WHERE _id = ?`).run(id);
        return String(stored.id);
      }
    }
    return undefined;
  }

  private findOneRow(id: string): unknown | null {
    for (const stored of this.storedTableDocs()) {
      const sqlTable = String(stored[SQL_TABLE_KEY]);
      const raw = this.db.prepare(`SELECT * FROM ${quoteIdent(sqlTable)} WHERE _id = ?`).get(id);
      if (raw) return this.decodeRow(String(stored.id), this.columnsOf(stored), raw);
    }
    return null;
  }

  private findRows(query?: Record<string, unknown>, limit?: number): unknown[] {
    const tableId = query?.tableId;
    const stored = typeof tableId === 'string' ? [this.getRaw('tables', tableId)].filter((d): d is Record<string, unknown> => d !== null) : this.storedTableDocs();
    const entries = Object.entries(query ?? {}).filter(([k]) => k !== 'tableId');
    const out: unknown[] = [];
    for (const t of stored) {
      const sqlTable = String(t[SQL_TABLE_KEY]);
      const columns = this.columnsOf(t);
      const cap = limit !== undefined ? ` LIMIT ${Number(limit)}` : '';
      const raws = this.db.prepare(`SELECT * FROM ${quoteIdent(sqlTable)}${cap}`).all();
      for (const raw of raws) {
        const row = this.decodeRow(String(t.id), columns, raw);
        if (entries.length === 0 || matchesRow(row, entries)) out.push(row);
      }
    }
    return out;
  }

  private countAllRows(): number {
    let total = 0;
    for (const stored of this.storedTableDocs()) {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(String(stored[SQL_TABLE_KEY]))}`).get();
      total += Number(r?.n ?? 0);
    }
    return total;
  }

  /**
   * The narrow read — fields, filter, sort, slice — answered in SQL.
   *
   * Ported from the desktop store rather than rewritten, because the two kinds
   * of column that have no SQL form, and the stable-slice rule, are each a bug
   * already paid for once.
   */
  queryRows(tableId: string, q: RowQuery = {}): RowPage {
    const stored = this.getRaw('tables', tableId);
    if (!stored) return { rows: [], total: 0 };
    const columns = this.columnsOf(stored);
    const table = quoteIdent(String(stored[SQL_TABLE_KEY]));

    // Two kinds of column have no SQL form:
    //  - a SCRIPTED one, whose value only exists once the renderer runs it;
    //  - an ARRAY one, whose cell holds SEVERAL values (`a,b` or `["a","b"]`) and
    //    is matched per MEMBER. `=b` and `NULL` mean different things member-wise
    //    than against the whole text, so a SQL LIKE over the raw cell is NARROWER
    //    than the matcher and would drop rows the user did not exclude.
    // Either way the predicate is left out, `expressible` goes false, and the
    // caller re-filters the superset.
    const specOf = new Map(columns.map((c) => [c.field, c] as const));
    const sqlOf = (field: string): string | null => {
      const spec = specOf.get(field);
      if (!spec || spec.script || spec.type === 'array') return null;
      return quoteIdent(spec.field);
    };
    const searchFields = columns.filter((c) => !c.script && c.type !== 'array' && c.filterable !== false).map((c) => c.field);

    const where = buildWhere(q.filters, q.search, sqlOf, searchFields);
    const whereSql = where.sql ? ` WHERE ${where.sql}` : '';

    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}${whereSql}`).get(...where.params)?.n ?? 0);

    // Same for the sort: a computed column has nothing to order by, and an array
    // column orders by its MEMBERS as they read, which is not the raw stored text
    // — `a,b` reads as `a, b`. The caller re-sorts.
    let sortPartial = false;
    const orderParts: string[] = [];
    for (const key of q.sort ?? []) {
      const col = sqlOf(key.field);
      if (!col) {
        sortPartial = true;
        continue;
      }
      orderParts.push(`${col} ${key.asc ? 'ASC' : 'DESC'}`);
    }
    const orderSql = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(', ')}` : '';

    // A LIMIT without an ORDER BY has no defined answer, so fall back to rowid
    // rather than letting the slice shift between calls.
    const stableSql = orderSql || (q.limit != null || q.offset != null ? ` ORDER BY rowid` : '');
    // SQLite needs a LIMIT before it will take an OFFSET; -1 means "no cap".
    const limitSql = q.limit != null && q.limit > 0 ? ` LIMIT ${Math.floor(q.limit)}` : q.offset != null && q.offset > 0 ? ` LIMIT -1` : '';
    const offsetSql = q.offset != null && q.offset > 0 ? ` OFFSET ${Math.floor(q.offset)}` : '';

    // Only the fields asked for, plus the bookkeeping a Row needs. `_extra` comes
    // along because a requested field may live in it.
    const wanted = q.fields && q.fields.length > 0 ? columns.filter((c) => q.fields?.includes(c.field)) : columns;
    const selected = ['_id', '_updatedAt', '_extra', ...wanted.filter((c) => !c.script).map((c) => quoteIdent(c.field))];

    const raws = this.db.prepare(`SELECT ${selected.join(', ')} FROM ${table}${whereSql}${stableSql}${limitSql}${offsetSql}`).all(...where.params);

    const partial = !where.expressible || sortPartial;
    return {
      rows: raws.map((raw) => this.decodeRow(tableId, wanted, raw)) as RowPage['rows'],
      total,
      ...(partial ? { partial: true } : {}),
    };
  }

  /**
   * One column's distinct values and their counts — a funnel's list, answered in
   * SQL so the caller never reads the rows.
   *
   * The blank group gets its OWN query rather than being picked out of the
   * grouped one. NULL and `''` are the same thing to a picker — a cell with
   * nothing in it — and left in the `GROUP BY` the blank group takes a slot in the
   * `LIMIT`: it can push a real value out of the list, and be missed altogether
   * when it sorts past the limit itself. `TRIM` leaves a number alone
   * (`TRIM(0)` is `'0'`, not `''`).
   */
  distinctValues(tableId: string, q: DistinctQuery): DistinctPage {
    const stored = this.getRaw('tables', tableId);
    if (!stored) return { values: [] };
    const columns = this.columnsOf(stored);
    const spec = columns.find((c) => c.field === q.field);
    // No SQL form for the field itself: the caller has to do the whole job.
    if (!spec || spec.script) return { values: [], partial: true };

    const table = quoteIdent(String(stored[SQL_TABLE_KEY]));
    const specOf = new Map(columns.map((c) => [c.field, c] as const));
    const sqlOf = (field: string): string | null => {
      const s = specOf.get(field);
      if (!s || s.script || s.type === 'array') return null;
      return quoteIdent(s.field);
    };
    const searchFields = columns.filter((c) => !c.script && c.type !== 'array' && c.filterable !== false).map((c) => c.field);
    const where = buildWhere(q.where?.filters, q.where?.search, sqlOf, searchFields);

    const col = quoteIdent(spec.field);
    const limit = q.limit != null && q.limit > 0 ? Math.floor(q.limit) : 500;
    const blankSql = `(${col} IS NULL OR TRIM(${col}) = '')`;
    const scope = where.sql ? `(${where.sql}) AND ` : '';

    // One more row than asked for, so "there are more" needs no second query.
    const rows = this.db
      .prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM ${table} WHERE ${scope}NOT ${blankSql} GROUP BY ${col} ORDER BY n DESC, v ASC LIMIT ${limit + 1}`)
      .all(...where.params);
    const blanks = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${scope}${blankSql}`).get(...where.params)?.n ?? 0);

    const more = rows.length > limit;
    const values = (more ? rows.slice(0, limit) : rows).map((r) => ({ value: decodeValue(spec.type, r.v), count: Number(r.n) }));
    return {
      values,
      blanks,
      ...(more ? { truncated: true } : {}),
      // An `array` column's cells are not its members: SQL cannot see inside one,
      // so the caller splits them. Said with its own flag so `partial` keeps
      // meaning "a predicate was left out", which is a different problem.
      ...(spec.type === 'array' ? { cells: true } : {}),
      ...(where.expressible ? {} : { partial: true }),
    };
  }
}
