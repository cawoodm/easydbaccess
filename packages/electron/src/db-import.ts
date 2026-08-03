/**
 * "Import a .db" — the interesting half of the file-operations slice (see
 * `.claude/plans/2026-07-31-electron-sqlite-storage.md` and `db-files.ts`).
 * Accepts ANY SQLite file, not just ones this app wrote:
 *
 *  - a file WE wrote carries an `_easydb_tables` registry — its per-table
 *    `_easydb_meta_<sql>` row holds the original `ColumnSpec[]` VERBATIM
 *    (renderer, hidden, width, script, sortable, filterable, label, …), so
 *    this path replays that JSON as-is instead of re-inferring it from the
 *    raw SQL schema, which would lose all of it.
 *  - any OTHER SQLite file: `sqlite_master` lists its tables (skipping
 *    `sqlite_*` internals and anything named `_easydb*`), and `PRAGMA
 *    table_info` + `columnTypeFromSqlType` (in `@easydb/shared/sql-mapping`)
 *    build a best-guess `ColumnSpec[]` for each.
 *
 * Two-phase API (`previewImport` then `commitImport`) rather than one call,
 * because collision resolution needs a user decision (Overwrite / Rename /
 * Skip — the same convention `datasette-connect.ts` uses for a name clash),
 * and only the renderer can show a dialog. `previewImport` opens the source
 * file, reads its table/row-count summary, and closes it again — it never
 * holds the file open across the round trip to the renderer and back while
 * the user is answering prompts. `commitImport` re-opens it once the
 * decisions are known and does the actual writing.
 *
 * Pure Node (`node:sqlite` + `@easydb/shared` only, no `electron` import) —
 * unit-testable exactly like `sqlite-store.ts`.
 */

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { columnTypeFromSqlType, decodeValue, quoteIdent, type ColumnSpec } from '@easydb/shared';
import type { SqliteStore } from './sqlite-store';

// Same require-not-import trick as sqlite-store.ts — see the comment there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/**
 * Rows read from the source file and written to the target in one batch
 * (`bulkInsert`). Measured on 400,000 rows with `synchronous = OFF`: 500 rows
 * took 21.4s, 2000 took 6.0s, 5000 took 5.3s, 20000 took 2.6s — while peak RSS
 * climbed from 142 MB to 320 MB, since a batch is alive as JS objects while it
 * is written. 2000 keeps most of the speed at a fraction of the memory.
 */
const BATCH_SIZE = 2000;

/** Reserved column names on every SqliteStore rows table — see `sqlite-store.ts`'s `writeTableNoTx`. */
const RESERVED_ROW_COLUMNS = new Set(['_id', '_updatedAt', '_extra']);

// -- Preview ---------------------------------------------------------------

export interface ImportCandidate {
  /** Table name as found in the source (easydb `Table.name`, or the SQL table/view name). */
  name: string;
  rowCount: number;
  /** Case-insensitive name clash against an existing table in the target workspace. */
  collides: boolean;
  /**
   * Whether the source object is a SQL VIEW. Importing one snapshots the rows
   * it currently returns into an ordinary local table — the view definition
   * itself does not travel, because this app expresses a derived table as a
   * projection, not as SQL.
   */
  isView?: boolean;
}

export interface ImportPreview {
  /** Whether the source carries our own `_easydb_tables` registry, or is a foreign file. */
  kind: 'easydb' | 'foreign';
  candidates: ImportCandidate[];
}

/** True when `_easydb_tables` exists — the app's bookkeeping has touched this file. */
function hasEasydbStamp(db: DatabaseSyncType): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_easydb_tables'`)
    .get();
  return row !== undefined;
}

/** How many objects in the file are the user's own — not `sqlite_*`, not `_easydb*`. */
function countForeignObjects(db: DatabaseSyncType): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '\\_easydb%' ESCAPE '\\'`,
    )
    .get() as { n: number };
  return r.n;
}

/**
 * True when the file really is an easyDBAccess workspace — i.e. its registry
 * can be trusted as the list of tables.
 *
 * The stamp alone is not enough. Before the Open guard existed, pointing the
 * store at any SQLite file created `_easydb_docs` + `_easydb_tables` in it and
 * left the registry EMPTY, so the file ends up stamped while every one of its
 * real tables is unregistered. Such a file must not be treated as a workspace:
 * opening it shows nothing, and importing it would take the metadata path and
 * find zero tables to import — both silent, both wrong.
 *
 * A brand-new easydb file also has an empty registry, and that one MUST still
 * count as ours. What separates them is unregistered data: an empty workspace
 * holds no other objects, a mis-stamped file is full of them.
 */
function isEasydbFile(db: DatabaseSyncType): boolean {
  if (!hasEasydbStamp(db)) return false;
  const registered = (
    db.prepare(`SELECT COUNT(*) AS n FROM _easydb_tables`).get() as { n: number }
  ).n;
  if (registered > 0) return true;
  return countForeignObjects(db) === 0;
}

/** What a picked file turns out to be. `unreadable` = not a SQLite database at all. */
export type DatabaseFileKind = 'easydb' | 'foreign' | 'unreadable';

/**
 * Classifies `sourcePath` without writing to it — the guard "Open…" needs.
 *
 * Opening a store on a file is not a read-only act: `SqliteStore`'s
 * constructor runs `CREATE TABLE IF NOT EXISTS _easydb_docs/_easydb_tables`,
 * so pointing it at someone else's database silently adds two tables to it
 * and then shows an empty workspace (no `_easydb_tables` rows to list). This
 * probe runs FIRST, `readOnly` so it leaves no `-wal`/`-journal` sidecar
 * either, and lets the caller offer Import instead of quietly mangling the
 * file.
 *
 * A non-SQLite file usually survives `new DatabaseSync()` and only fails on
 * the first read, so the classification query is what actually decides
 * `unreadable`.
 */
export function probeDatabaseFile(sourcePath: string): DatabaseFileKind {
  let db: DatabaseSyncType | null = null;
  try {
    db = new DatabaseSync(sourcePath, { readOnly: true });
    return isEasydbFile(db) ? 'easydb' : 'foreign';
  } catch {
    return 'unreadable';
  } finally {
    try {
      db?.close();
    } catch {
      /* never opened, or already closed by the failing read */
    }
  }
}

function rowCountOf(db: DatabaseSyncType, sqlTable: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(sqlTable)}`).get() as { n: number };
  return r.n;
}

function listEasydbCandidates(db: DatabaseSyncType): Array<{ name: string; sqlTable: string; rowCount: number }> {
  const rows = db.prepare(`SELECT name, sql_table FROM _easydb_tables ORDER BY ordinal`).all() as Array<{
    name: string;
    sql_table: string;
  }>;
  return rows.map((r) => ({ name: r.name, sqlTable: r.sql_table, rowCount: rowCountOf(db, r.sql_table) }));
}

/**
 * Tables AND views. A view is importable: its current result set snapshots into
 * an ordinary local table. The view DEFINITION does not travel — a derived
 * table is a projection in this app, not SQL — so the import is a snapshot by
 * nature, which is also what makes it safe to treat one exactly like a table
 * from here on.
 */
function listForeignCandidates(
  db: DatabaseSyncType,
): Array<{ name: string; sqlTable: string; rowCount: number; isView: boolean }> {
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
    sqlTable: r.name,
    rowCount: rowCountOf(db, r.name),
    isView: r.type === 'view',
  }));
}

/**
 * Reads a summary of what `sourcePath` offers, WITHOUT writing anything —
 * the renderer uses this to build its collision prompts before committing.
 * Opened `readOnly` so previewing a file never creates a `-journal`/`-wal`
 * sidecar next to someone else's database.
 */
export function previewImport(
  sourcePath: string,
  targetStore: SqliteStore,
  workspaceId: string,
): ImportPreview {
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const kind: ImportPreview['kind'] = isEasydbFile(src) ? 'easydb' : 'foreign';
    const raw = kind === 'easydb' ? listEasydbCandidates(src) : listForeignCandidates(src);
    const existingNames = new Set(
      (targetStore.find('tables', { workspaceId }) as Array<{ name: string }>).map((t) =>
        t.name.toLowerCase(),
      ),
    );
    return {
      kind,
      candidates: raw.map((c) => ({
        name: c.name,
        rowCount: c.rowCount,
        collides: existingNames.has(c.name.toLowerCase()),
        ...('isView' in c && c.isView ? { isView: true } : {}),
      })),
    };
  } finally {
    src.close();
  }
}

// -- Commit ------------------------------------------------------------------

export type CollisionAction = 'overwrite' | 'rename' | 'skip';

export interface ImportDecision {
  action: CollisionAction;
  /** Final table name to use. Required for 'rename'; ignored otherwise (the source name is used). */
  renameTo?: string;
}

/**
 * Emitted per written batch so the renderer can show a progress bar instead of a
 * frozen window. `total` is the source's own count, so it is exact for a table
 * and a best effort for anything else.
 *
 * This matters more than it looks: the import runs synchronously in the Electron
 * MAIN process, so while it works no `store:*` IPC call can complete and the
 * window cannot do anything. `webContents.send` still reaches the renderer,
 * which paints in its own process — so progress is the one signal that can get
 * out during the freeze.
 */
export interface ImportProgress {
  table: string;
  rows: number;
  /** Rows the source reports for this object. */
  total: number;
}

export interface ImportedTableResult {
  sourceName: string;
  action: 'created' | 'overwritten' | 'renamed' | 'skipped';
  finalName: string;
  tableId: string | null;
  rowCount: number;
}

/**
 * A foreign column whose name collides with a reserved SqliteStore row
 * column (`_id`/`_updatedAt`/`_extra`) would otherwise fight the primary key
 * or bookkeeping columns when the target table's schema is built — vanishingly
 * rare in practice, but must not silently corrupt the row identity/extras
 * columns. Renamed instead of dropped, so the data still imports.
 */
function safeFieldName(name: string): string {
  return RESERVED_ROW_COLUMNS.has(name) ? `${name}_1` : name;
}

/** Base64-encodes a BLOB value read back from `node:sqlite` (a `Uint8Array`) — see `columnTypeFromSqlType`. */
export function fromRawSqlValue(columnType: ColumnSpec['type'], raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('base64');
  return decodeValue(columnType, raw);
}

/** Streams `sqlTable`'s rows out of `db` in batches, so a large table is never fully materialised. */
function* readRowBatches(
  db: DatabaseSyncType,
  sqlTable: string,
  columns: string[],
): Generator<Array<Record<string, unknown>>> {
  const stmt = db.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(sqlTable)}`);
  let batch: Array<Record<string, unknown>> = [];
  for (const row of stmt.iterate()) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** Resolves what to do for one source table, given the caller's decisions map (keyed by source name). */
function resolveAction(
  candidate: ImportCandidate,
  decisions: Record<string, ImportDecision>,
): { action: 'create' | 'overwrite' | 'rename' | 'skip'; finalName: string } {
  const decision = decisions[candidate.name];
  // An explicit skip wins whether or not the name collides. `decisions` started
  // out as purely collision resolution, but two callers now use it to say "not
  // this one" — the Import picker skips every object the user didn't choose, and
  // Convert skips every view — and honouring it only on a collision silently
  // imported both.
  if (decision?.action === 'skip') return { action: 'skip', finalName: candidate.name };
  if (!candidate.collides) return { action: 'create', finalName: candidate.name };
  if (!decision) return { action: 'skip', finalName: candidate.name };
  if (decision.action === 'overwrite') return { action: 'overwrite', finalName: candidate.name };
  return { action: 'rename', finalName: decision.renameTo ?? candidate.name };
}

/** Replaces a local table's rows wholesale — same "wipe then bulk-insert" convention `gist-sync.ts`'s pull() uses. */
/**
 * Drops a table's existing rows, so an overwrite can then stream the new ones in
 * like any other import. It used to take the full `docs` array and write it
 * after the read — see `importForeignTable` for why nothing may hold a whole
 * table in memory.
 */
function clearRows(store: SqliteStore, tableId: string): void {
  const existingIds = (store.find('rows', { tableId }) as Array<{ id: string }>).map((r) => r.id);
  if (existingIds.length > 0) store.bulkRemove('rows', existingIds);
}

/**
 * Imports one `_easydb`-origin table (verbatim `ColumnSpec[]` from its meta
 * table) into `targetStore` under `workspaceId`, per `resolveAction`'s
 * decision. `tableId` is fresh for 'create'/'rename', reused for 'overwrite'.
 */
function importEasydbTable(
  src: DatabaseSyncType,
  targetStore: SqliteStore,
  workspaceId: string,
  candidate: { name: string; sqlTable: string; rowCount: number },
  resolved: { action: 'create' | 'overwrite' | 'rename' | 'skip'; finalName: string },
  onProgress?: ((p: ImportProgress) => void) | undefined,
): ImportedTableResult {
  if (resolved.action === 'skip') {
    return {
      sourceName: candidate.name,
      action: 'skipped',
      finalName: resolved.finalName,
      tableId: null,
      rowCount: 0,
    };
  }

  const metaRow = src
    .prepare(`SELECT columns_json, table_json FROM ${quoteIdent(`_easydb_meta_${candidate.sqlTable}`)}`)
    .get() as { columns_json: string; table_json: string };
  const columns = JSON.parse(metaRow.columns_json) as ColumnSpec[];
  const tableRest = JSON.parse(metaRow.table_json) as Record<string, unknown>;

  const existing =
    resolved.action === 'overwrite'
      ? ((targetStore.find('tables', { workspaceId }) as Array<{ id: string; name: string }>).find(
          (t) => t.name.toLowerCase() === candidate.name.toLowerCase(),
        ) ?? null)
      : null;

  const tableId = existing?.id ?? randomUUID();
  // Carry over the display/query metadata that still makes sense in a new
  // workspace (view, sort, filters, label, deleted-columns, info, title); drop
  // what doesn't: `id`/`workspaceId` are reassigned below, `windowGeometry`
  // from a different machine/monitor would pile every imported table at the
  // same stale x/y, and `source`/`origin`/`importResume` all describe a live
  // backend or an in-flight paging cursor from the OLD file — importing rows
  // makes this a genuine local table, so none of those apply anymore.
  const table = {
    id: tableId,
    workspaceId,
    name: resolved.finalName,
    code: tableRest.code ?? resolved.finalName,
    title: tableRest.title,
    columns,
    view: tableRest.view ?? 'table',
    sortColumn: tableRest.sortColumn,
    sortAsc: tableRest.sortAsc,
    sortBy: tableRest.sortBy,
    filters: tableRest.filters,
    labelColumn: tableRest.labelColumn,
    deletedColumns: tableRest.deletedColumns,
    info: tableRest.info,
    updatedAt: Date.now(),
  };
  if (existing) targetStore.upsert('tables', table);
  else targetStore.insert('tables', table);

  const rawCols = ['_id', '_updatedAt', '_extra', ...columns.map((c) => c.field)];
  if (resolved.action === 'overwrite') clearRows(targetStore, tableId);

  // Streamed, for the same reason as `importForeignTable` — see the comment
  // there. This path had the identical accumulate-the-whole-table bug.
  const fallbackAt = Date.now();
  let imported = 0;
  for (const batch of readRowBatches(src, candidate.sqlTable, rawCols)) {
    const docs = batch.map((raw) => {
      const data: Record<string, unknown> = {};
      for (const spec of columns) {
        const v = fromRawSqlValue(spec.type, raw[spec.field]);
        if (v !== null) data[spec.field] = v;
      }
      const extraJson = raw._extra as string | null;
      if (extraJson) Object.assign(data, JSON.parse(extraJson) as Record<string, unknown>);
      return {
        id: raw._id as string,
        tableId,
        data,
        updatedAt: (raw._updatedAt as number) ?? fallbackAt,
      };
    });
    targetStore.bulkInsert('rows', docs);
    imported += docs.length;
    onProgress?.({ table: resolved.finalName, rows: imported, total: candidate.rowCount });
  }

  return {
    sourceName: candidate.name,
    action: resolved.action === 'create' ? 'created' : resolved.action === 'rename' ? 'renamed' : 'overwritten',
    finalName: resolved.finalName,
    tableId,
    rowCount: imported,
  };
}

/** `PRAGMA table_info` row shape. */
interface RawColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/** `snake_case`/`kebab-case` field name → a readable header label, matching `datasette-client.ts`'s `prettifyLabel`. */
function prettifyLabel(field: string): string {
  return field
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Builds a best-guess `ColumnSpec[]` for a foreign table from its declared SQL
 * types. Every column becomes a plain visible field — including a source
 * `INTEGER PRIMARY KEY`, which stays a normal data column: this app's own row
 * identity (`Row.id`) is always a fresh synthetic id (see `importForeignTable`),
 * never a column value, so nothing is lost by also keeping the source's PK
 * visible as ordinary data.
 */
export function inferForeignColumns(src: DatabaseSyncType, sqlTable: string): ColumnSpec[] {
  const info = src.prepare(`PRAGMA table_info(${quoteIdent(sqlTable)})`).all() as unknown as RawColumnInfo[];
  return info.map((c) => {
    const field = safeFieldName(c.name);
    return {
      field,
      label: prettifyLabel(c.name),
      type: columnTypeFromSqlType(c.type),
    };
  });
}

/** Imports one FOREIGN table (no easydb metadata) — types inferred via `columnTypeFromSqlType`. */
function importForeignTable(
  src: DatabaseSyncType,
  targetStore: SqliteStore,
  workspaceId: string,
  candidate: { name: string; sqlTable: string; rowCount: number },
  resolved: { action: 'create' | 'overwrite' | 'rename' | 'skip'; finalName: string },
  onProgress?: ((p: ImportProgress) => void) | undefined,
): ImportedTableResult {
  if (resolved.action === 'skip') {
    return {
      sourceName: candidate.name,
      action: 'skipped',
      finalName: resolved.finalName,
      tableId: null,
      rowCount: 0,
    };
  }

  const info = src.prepare(`PRAGMA table_info(${quoteIdent(candidate.sqlTable)})`).all() as unknown as RawColumnInfo[];
  const columns = inferForeignColumns(src, candidate.sqlTable);
  // Original (un-renamed) column names, in the same order as `columns`, for
  // reading raw SQL values — `safeFieldName` may differ from `c.name`.
  const sourceFieldNames = info.map((c) => c.name);

  const existing =
    resolved.action === 'overwrite'
      ? ((targetStore.find('tables', { workspaceId }) as Array<{ id: string; name: string }>).find(
          (t) => t.name.toLowerCase() === candidate.name.toLowerCase(),
        ) ?? null)
      : null;

  const tableId = existing?.id ?? randomUUID();
  const table = {
    id: tableId,
    workspaceId,
    name: resolved.finalName,
    code: resolved.finalName,
    columns,
    view: 'table',
    updatedAt: Date.now(),
  };
  if (existing) targetStore.upsert('tables', table);
  else targetStore.insert('tables', table);

  // An overwrite clears first, then streams like any other import.
  if (resolved.action === 'overwrite') clearRows(targetStore, tableId);

  // Each batch is written as it is READ. Nothing accumulates: `readRowBatches`
  // exists precisely so a large table is never fully materialised, and building
  // a `docs` array of the whole table first threw that away — a 609,283-row
  // `northwind.db` drove the Electron main process past 1.4 GB and froze the
  // window, because every row was alive as a JS object before the first insert.
  // Covered by `db-import-streaming.test.ts`.
  const importedAt = Date.now(); // one import is one instant, not one per row
  let imported = 0;
  for (const batch of readRowBatches(src, candidate.sqlTable, sourceFieldNames)) {
    const docs = batch.map((raw) => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        const spec = columns[i]!;
        const sourceField = sourceFieldNames[i]!;
        const v = fromRawSqlValue(spec.type, raw[sourceField]);
        if (v !== null) data[spec.field] = v;
      }
      return { id: randomUUID(), tableId, data, updatedAt: importedAt };
    });
    targetStore.bulkInsert('rows', docs);
    imported += docs.length;
    onProgress?.({ table: resolved.finalName, rows: imported, total: candidate.rowCount });
  }

  return {
    sourceName: candidate.name,
    action: resolved.action === 'create' ? 'created' : resolved.action === 'rename' ? 'renamed' : 'overwritten',
    finalName: resolved.finalName,
    tableId,
    rowCount: imported,
  };
}

/**
 * Writes every non-skipped candidate from `sourcePath` into `targetStore`
 * under `workspaceId`, per `decisions` (keyed by the source table name — see
 * `ImportPreview.candidates`). Re-opens the source file (read-only) rather
 * than reusing a handle from `previewImport`, so the file is never held open
 * across the interactive round trip while the user answers collision prompts.
 */
export function commitImport(
  sourcePath: string,
  targetStore: SqliteStore,
  workspaceId: string,
  decisions: Record<string, ImportDecision>,
  onProgress?: ((p: ImportProgress) => void) | undefined,
): ImportedTableResult[] {
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const kind: ImportPreview['kind'] = isEasydbFile(src) ? 'easydb' : 'foreign';
    const raw = kind === 'easydb' ? listEasydbCandidates(src) : listForeignCandidates(src);
    const existingNames = new Set(
      (targetStore.find('tables', { workspaceId }) as Array<{ name: string }>).map((t) =>
        t.name.toLowerCase(),
      ),
    );
    // Durability off for the import: the destination is a fresh file (Convert) or
    // tables the user can re-import, and an interrupted import has to be redone
    // anyway — so waiting for a flush per commit buys nothing. Worth 3.5x on the
    // measurements above. Restored in the `finally` below, failure included.
    targetStore.setDurability('bulk');
    const results: ImportedTableResult[] = [];
    for (const c of raw) {
      const candidate: ImportCandidate = {
        name: c.name,
        rowCount: c.rowCount,
        collides: existingNames.has(c.name.toLowerCase()),
      };
      const resolved = resolveAction(candidate, decisions);
      results.push(
        kind === 'easydb'
          ? importEasydbTable(src, targetStore, workspaceId, c, resolved, onProgress)
          : importForeignTable(src, targetStore, workspaceId, c, resolved, onProgress),
      );
    }
    return results;
  } finally {
    targetStore.setDurability('safe');
    src.close();
  }
}
