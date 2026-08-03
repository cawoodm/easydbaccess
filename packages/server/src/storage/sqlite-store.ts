import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeValue,
  encodeValue,
  quoteIdent,
  sanitizeTableName as sanitize,
  sqlAffinity,
} from '@easydb/shared';
import type { Json, StoreAdapter, Unsubscribe, WriteResult } from './types.js';

// node:sqlite is a Node 22.5+ built-in. Vite (used by vitest) doesn't yet
// recognise it as a builtin, so resolve it at runtime via createRequire —
// opaque to Vite's analyser, native to Node.
type DatabaseSyncCtor = new (path: string) => DatabaseSyncInstance;
interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncInstance;
  close(): void;
}
interface StatementSyncInstance {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
}

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };

/**
 * Structured SQLite adapter.
 *
 * STORAGE_PATH is a directory. Each workspace lives in its own SQLite file
 * at `${dir}/${workspaceId}.db`. Inside, the dump is materialised as real
 * SQL tables — one SQL table per workspace table, with column types
 * translated to SQLite affinity (string/date/color/image → TEXT,
 * number → REAL, boolean → INTEGER 0/1).
 *
 * Push semantics: clobber. Each push drops the workspace's previous SQL
 * tables and rebuilds from the incoming JSON. No row-level merge.
 *
 * Bookkeeping lives in two system tables inside each file:
 *   _easydb_meta(id=1, exported_at, etag, updated_at)   -- single row
 *   _easydb_tables(ordinal, name, sql_table, columns_json)
 *
 * User SQL tables are named by sanitising the workspace table name. Names
 * starting with `_easydb_` are rejected to keep system tables disambiguated.
 *
 * The adapter REQUIRES the body to look like { tables: [{ name, columns, rows }] }
 * (the dump-export shape). Anything else is rejected with a clear error,
 * which the route converts to HTTP 400.
 */
export function sqliteStoreAdapter(rootDir: string): StoreAdapter {
  const emitter = new EventEmitter();
  const connections = new Map<string, Conn>();
  let closed = false;

  const validateId = (id: string) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`invalid workspaceId: ${id}`);
  };

  const filePath = (id: string) => join(rootDir, `${id}.db`);

  function open(workspaceId: string): Conn {
    const existing = connections.get(workspaceId);
    if (existing) return existing;
    mkdirSync(rootDir, { recursive: true });
    const db = new DatabaseSync(filePath(workspaceId));
    db.exec(`
      CREATE TABLE IF NOT EXISTS _easydb_meta (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        exported_at  INTEGER NOT NULL,
        etag         TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _easydb_tables (
        ordinal      INTEGER PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        sql_table    TEXT NOT NULL UNIQUE,
        columns_json TEXT NOT NULL
      );
    `);
    const conn: Conn = {
      db,
      selectMeta: db.prepare('SELECT exported_at, etag FROM _easydb_meta WHERE id = 1'),
      upsertMeta: db.prepare(`
        INSERT INTO _easydb_meta (id, exported_at, etag, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          exported_at = excluded.exported_at,
          etag        = excluded.etag,
          updated_at  = excluded.updated_at
      `),
      selectTables: db.prepare(
        'SELECT ordinal, name, sql_table, columns_json FROM _easydb_tables ORDER BY ordinal',
      ),
      insertTable: db.prepare(
        'INSERT INTO _easydb_tables (ordinal, name, sql_table, columns_json) VALUES (?, ?, ?, ?)',
      ),
      deleteTables: db.prepare('DELETE FROM _easydb_tables'),
    };
    connections.set(workspaceId, conn);
    return conn;
  }

  function openIfExists(workspaceId: string): Conn | null {
    const cached = connections.get(workspaceId);
    if (cached) return cached;
    if (!existsSync(filePath(workspaceId))) return null;
    return open(workspaceId);
  }

  function dropUserTables(conn: Conn): void {
    const rows = conn.selectTables.all() as Array<{ sql_table: string }>;
    for (const r of rows) {
      conn.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(r.sql_table)}`);
    }
  }

  function rebuild(conn: Conn, parsed: WorkspaceBody, etag: string): void {
    dropUserTables(conn);
    conn.deleteTables.run();

    parsed.tables.forEach((t, ordinal) => {
      const sqlName = sanitize(t.name);
      const colDefs = t.columns
        .map((c) => `${quoteIdent(c.field)} ${sqlAffinity(c.type)}`)
        .join(', ');
      conn.db.exec(
        `CREATE TABLE ${quoteIdent(sqlName)} (
          _id INTEGER PRIMARY KEY AUTOINCREMENT${colDefs ? ', ' + colDefs : ''}
        )`,
      );

      if (t.rows.length > 0 && t.columns.length > 0) {
        const placeholders = t.columns.map(() => '?').join(', ');
        const fieldList = t.columns.map((c) => quoteIdent(c.field)).join(', ');
        const insert = conn.db.prepare(
          `INSERT INTO ${quoteIdent(sqlName)} (${fieldList}) VALUES (${placeholders})`,
        );
        for (const row of t.rows) {
          const values = t.columns.map((c) => encodeValue(c.type, row[c.field]));
          insert.run(...values);
        }
      }

      conn.insertTable.run(ordinal, t.name, sqlName, JSON.stringify(t.columns));
    });

    conn.upsertMeta.run(parsed.exportedAt, etag, Date.now());
  }

  function readWorkspace(workspaceId: string): { body: Json; etag: string } | null {
    const conn = openIfExists(workspaceId);
    if (!conn) return null;
    const meta = conn.selectMeta.get() as { exported_at: number; etag: string } | undefined;
    if (!meta) return null;
    const tableRows = conn.selectTables.all() as Array<{
      ordinal: number;
      name: string;
      sql_table: string;
      columns_json: string;
    }>;
    const tables = tableRows.map((tr) => {
      const columns = JSON.parse(tr.columns_json) as ColumnSpec[];
      const sqlRows = conn.db
        .prepare(`SELECT * FROM ${quoteIdent(tr.sql_table)} ORDER BY _id`)
        .all() as Array<Record<string, unknown>>;
      const rows = sqlRows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const c of columns) {
          if (c.field in r) out[c.field] = decodeValue(c.type, r[c.field]);
        }
        return out;
      });
      return { name: tr.name, columns, rows };
    });
    const body: WorkspaceBody = {
      workspaceId,
      exportedAt: meta.exported_at,
      tables,
    };
    return { body: body as unknown as Json, etag: meta.etag };
  }

  return {
    async read(workspaceId) {
      validateId(workspaceId);
      const r = readWorkspace(workspaceId);
      if (!r) return { body: null, etag: null };
      return r;
    },

    async write(workspaceId, body, opts): Promise<WriteResult> {
      validateId(workspaceId);
      const parsed = validateBody(body);
      const newEtag = sha1(JSON.stringify(body));

      // If the caller requires an etag match but the workspace doesn't exist
      // yet, fail fast — don't create an empty .db file that would then leak
      // into list().
      if (
        opts.ifMatchEtag !== null &&
        !connections.has(workspaceId) &&
        !existsSync(filePath(workspaceId))
      ) {
        return { ok: false, conflict: true, currentEtag: '' };
      }

      const conn = open(workspaceId);
      conn.db.exec('BEGIN IMMEDIATE');
      try {
        const current = conn.selectMeta.get() as { etag: string } | undefined;
        const currentEtag = current?.etag ?? null;

        if (opts.ifMatchEtag !== null && currentEtag !== opts.ifMatchEtag) {
          conn.db.exec('ROLLBACK');
          return { ok: false, conflict: true, currentEtag: currentEtag ?? '' };
        }

        rebuild(conn, parsed, newEtag);
        conn.db.exec('COMMIT');
      } catch (err) {
        conn.db.exec('ROLLBACK');
        throw err;
      }

      emitter.emit(`change:${workspaceId}`);
      return { ok: true, etag: newEtag };
    },

    watch(workspaceId, fn): Unsubscribe {
      validateId(workspaceId);
      const event = `change:${workspaceId}`;
      emitter.on(event, fn);
      return () => emitter.off(event, fn);
    },

    async list(): Promise<string[]> {
      let entries: string[];
      try {
        entries = readdirSync(rootDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const ids: string[] = [];
      for (const name of entries) {
        const m = /^(.+)\.db$/.exec(name);
        if (!m) continue;
        const full = join(rootDir, name);
        try {
          if (statSync(full).isFile()) ids.push(m[1]!);
        } catch {
          // skip vanished entries
        }
      }
      return ids;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      emitter.removeAllListeners();
      for (const conn of connections.values()) {
        conn.db.close();
      }
      connections.clear();
    },
  };
}

interface Conn {
  db: DatabaseSyncInstance;
  selectMeta: StatementSyncInstance;
  upsertMeta: StatementSyncInstance;
  selectTables: StatementSyncInstance;
  insertTable: StatementSyncInstance;
  deleteTables: StatementSyncInstance;
}

// -- Body validation ---------------------------------------------------------

type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'datetime';

interface ColumnSpec {
  field: string;
  label?: string;
  type: ColumnType;
  [k: string]: unknown;
}

interface WorkspaceBody {
  workspaceId?: string | undefined;
  exportedAt: number;
  tables: Array<{
    name: string;
    columns: ColumnSpec[];
    rows: Array<Record<string, unknown>>;
  }>;
}

function validateBody(body: Json): WorkspaceBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('sqlite adapter requires a JSON object with a "tables" array');
  }
  const o = body as Record<string, Json>;
  if (!Array.isArray(o.tables)) {
    throw new Error('sqlite adapter requires "tables" array in body');
  }
  const seen = new Set<string>();
  const tables: WorkspaceBody['tables'] = o.tables.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`table[${i}] must be an object`);
    }
    const t = entry as Record<string, Json>;
    if (typeof t.name !== 'string' || t.name.length === 0) {
      throw new Error(`table[${i}].name must be a non-empty string`);
    }
    if (/^_easydb_/i.test(sanitize(t.name))) {
      throw new Error(`table[${i}].name collides with reserved sqlite-adapter system tables`);
    }
    if (seen.has(t.name)) throw new Error(`duplicate table name: ${t.name}`);
    seen.add(t.name);
    if (!Array.isArray(t.columns)) {
      throw new Error(`table[${i}].columns must be an array`);
    }
    const fields = new Set<string>();
    const columns: ColumnSpec[] = (t.columns as Json[]).map((c, j) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new Error(`table[${i}].columns[${j}] must be an object`);
      }
      const cc = c as Record<string, Json>;
      if (typeof cc.field !== 'string' || cc.field.length === 0) {
        throw new Error(`table[${i}].columns[${j}].field must be a non-empty string`);
      }
      if (fields.has(cc.field)) {
        throw new Error(`table[${i}] duplicate column field: ${cc.field}`);
      }
      fields.add(cc.field);
      if (typeof cc.type !== 'string') {
        throw new Error(`table[${i}].columns[${j}].type must be a string`);
      }
      return cc as unknown as ColumnSpec;
    });
    const rows = Array.isArray(t.rows)
      ? (t.rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Array<
          Record<string, unknown>
        >)
      : [];
    return { name: t.name, columns, rows };
  });
  return {
    workspaceId: typeof o.workspaceId === 'string' ? o.workspaceId : undefined,
    exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : Date.now(),
    tables,
  };
}

// -- SQL helpers -------------------------------------------------------------
// quoteIdent / sanitize(TableName) / sqlAffinity / encodeValue / decodeValue
// now live in @easydb/shared/sql-mapping — see the import above. They stayed
// behaviour-identical in the move; only their home changed.

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}
