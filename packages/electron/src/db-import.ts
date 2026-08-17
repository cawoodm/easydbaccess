/**
 * "Import a .db" — the interesting half of the file-operations slice (see
 * `.claude/plans/2026-07-31-electron-sqlite-storage.md` and `db-files.ts`).
 * Accepts ANY SQLite file, not just ones this app wrote:
 *
 *  - a file WE wrote carries an `_easydb` table — its `coll='tables'` rows hold
 *    each `Table` doc, `ColumnSpec[]` VERBATIM (renderer, hidden, width, script,
 *    sortable, filterable, label, …), so this path replays that JSON as-is
 *    instead of re-inferring it from the raw SQL schema, which would lose all of
 *    it. See `docs/tech/EDB.md`.
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
import { statSync } from 'node:fs';
import { columnTypeFromSqlType, decodeValue, quoteIdent, type ColumnSpec } from '@easydb/shared';
import type { SqliteStore } from './sqlite-store';

// Same require-not-import trick as sqlite-store.ts — see the comment there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/**
 * How long one batch may hold the process before yielding.
 *
 * `node:sqlite` is synchronous, so a batch blocks whichever thread runs it for
 * its whole duration. In the main process that is the thread answering the
 * renderer's `store:*` IPC, and a fixed 2000-row batch measured 99.7% duty
 * cycle over a `northwind.db` import: median 127ms blocked, p99 526ms, worst
 * 1344ms. Every click and every subscription re-read queued behind that, which
 * is what "the UI hangs" was.
 *
 * A row count cannot bound this — cost per row varies with the table's width
 * and its column types, so the same 2000 rows is 30ms for one table and 1.3s
 * for another. A TIME budget bounds it directly, and `BatchPacer` converts the
 * budget into a row count from what the last batch actually cost.
 */
const BATCH_SLICE_MS = 40;

/**
 * Batch-size bounds. The floor keeps the per-batch overhead (a statement
 * prepare and a progress message) from dominating; the ceiling caps memory,
 * since a batch is alive as JS objects while it is written — at 2000 rows peak
 * RSS was already 320 MB on a 400k-row table.
 */
const MIN_BATCH_ROWS = 100;
const MAX_BATCH_ROWS = 4000;
const INITIAL_BATCH_ROWS = 500;

/**
 * Chooses how many rows the next batch should carry so it costs about
 * {@link BATCH_SLICE_MS}.
 *
 * Each new size is the average of the current one and what the last batch's
 * measured cost-per-row implies. Averaging rather than jumping straight to the
 * implied size damps the oscillation a single anomalous batch would otherwise
 * cause — a WAL checkpoint or a GC pause makes one batch look ten times more
 * expensive than the table really is.
 */
export class BatchPacer {
  private rows = INITIAL_BATCH_ROWS;

  size(): number {
    return this.rows;
  }

  /** Feed back what a batch of `rows` rows actually cost. */
  observe(rows: number, elapsedMs: number): void {
    if (rows <= 0) return;
    // Sub-millisecond batches would divide by zero and imply an infinite size;
    // treating them as 1ms just means "grow", which the clamp then bounds.
    const perRow = Math.max(elapsedMs, 1) / rows;
    const implied = Math.round(BATCH_SLICE_MS / perRow);
    const next = Math.round((this.rows + implied) / 2);
    this.rows = Math.min(MAX_BATCH_ROWS, Math.max(MIN_BATCH_ROWS, next));
  }
}

/** Reserved column names on every SqliteStore rows table — see `sqlite-store.ts`'s `writeTableNoTx`. */
const RESERVED_ROW_COLUMNS = new Set(['_id', '_updatedAt', '_extra']);

// -- Preview ---------------------------------------------------------------

export interface ImportCandidate {
  /** Table name as found in the source (easydb `Table.name`, or the SQL table/view name). */
  name: string;
  /**
   * Rows the source reports, or **-1 when not counted** — the same
   * negative-means-unknown convention `countSuffix` uses.
   *
   * A VIEW is never counted: counting one means RUNNING it, and a view over a
   * big table is expensive (northwind's views join its 609,283-row `Order
   * Details`, so counting all 17 of them cost 3.5s before the user saw
   * anything). The progress bar simply shows a running count instead of a
   * percentage for those.
   */
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
  /**
   * The source object's own column names, in its own order. Present so the
   * renderer can offer an append mapping without a second round trip to read the
   * schema it is mapping FROM.
   */
  columns?: string[];
  /**
   * A view's `CREATE VIEW … AS SELECT …`. Present only for views, and only so one
   * can be imported as a PROJECTION — the query itself, recomputed from the
   * tables it reads — instead of a snapshot of today's rows.
   */
  sql?: string;
}

export interface ImportPreview {
  /** Whether the source carries our own `_easydb` bookkeeping, or is a foreign file. */
  kind: 'easydb' | 'foreign';
  candidates: ImportCandidate[];
  /** The source file's size on disk; the renderer decides what a big file means. */
  sizeBytes: number;
}

/**
 * The source file's size, or 0 when it cannot be read.
 *
 * Reported rather than acted on here: what a size MEANS — whether the windows an
 * import produces are worth opening on arrival — is a renderer decision, and
 * lives with the windows (`plugins/electron-db.ts`'s `LARGE_SOURCE_BYTES`).
 *
 * 0 rather than throwing, because a size only picks a default: failing to stat a
 * file we then read successfully must not abort the import. It reads as "small",
 * which is the behaviour that predates this field.
 */
export function sourceSizeBytes(sourcePath: string): number {
  try {
    return statSync(sourcePath).size;
  } catch {
    return 0;
  }
}

/** True when `_easydb` exists — the app's bookkeeping has touched this file. */
function hasEasydbStamp(db: DatabaseSyncType): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_easydb'`).get();
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
 * store at any SQLite file created its bookkeeping table in it and left the table
 * list EMPTY, so the file ends up stamped while every one of its real tables is
 * unregistered. Such a file must not be treated as a workspace: opening it shows
 * nothing, and importing it would take the metadata path and find zero tables to
 * import — both silent, both wrong.
 *
 * A brand-new easydb file also has no `tables` rows, and that one MUST still
 * count as ours. What separates them is unregistered data: an empty workspace
 * holds no other objects, a mis-stamped file is full of them.
 */
function isEasydbFile(db: DatabaseSyncType): boolean {
  if (!hasEasydbStamp(db)) return false;
  const registered = (db.prepare(`SELECT COUNT(*) AS n FROM _easydb WHERE coll = 'tables'`).get() as { n: number }).n;
  if (registered > 0) return true;
  return countForeignObjects(db) === 0;
}

/** What a picked file turns out to be. `unreadable` = not a SQLite database at all. */
export type DatabaseFileKind = 'easydb' | 'foreign' | 'unreadable';

/**
 * Classifies `sourcePath` without writing to it — the guard "Open…" needs.
 *
 * Opening a store on a file is not a read-only act: `EdbStore`'s constructor runs
 * `CREATE TABLE IF NOT EXISTS _easydb` and stamps the format, so pointing it at
 * someone else's database silently adds a table to it and then shows an empty
 * workspace (no `coll='tables'` rows to list). This probe runs FIRST, `readOnly`
 * so it leaves no `-wal`/`-journal` sidecar either, and lets the caller offer
 * Import instead of quietly mangling the file.
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

/**
 * The `tables` documents of a file we wrote, in their own order.
 *
 * One read where v1 needed three: the doc is the `Table` verbatim plus
 * `_sqlTable` and `_ordinal`, so the physical name and the `ColumnSpec[]` come
 * out of the same row. See `docs/tech/EDB.md`.
 */
function easydbTableDocs(db: DatabaseSyncType): Array<Record<string, unknown>> {
  const rows = db.prepare(`SELECT doc FROM _easydb WHERE coll = 'tables'`).all() as Array<{ doc: string }>;
  return rows.map((r) => JSON.parse(r.doc) as Record<string, unknown>).sort((a, b) => Number(a['_ordinal'] ?? 0) - Number(b['_ordinal'] ?? 0));
}

function columnsOfDoc(doc: Record<string, unknown>): ColumnSpec[] {
  return (Array.isArray(doc['columns']) ? doc['columns'] : []) as ColumnSpec[];
}

function listEasydbCandidates(db: DatabaseSyncType): Array<{ name: string; sqlTable: string; rowCount: number; columns: string[] }> {
  return easydbTableDocs(db).map((doc) => {
    const sqlTable = String(doc['_sqlTable']);
    return {
      name: String(doc['name'] ?? ''),
      sqlTable,
      rowCount: rowCountOf(db, sqlTable),
      // From the recorded ColumnSpec[], not the SQL schema: those are the fields a
      // row's `data` is keyed by, which is what an append maps FROM.
      columns: columnsOfDoc(doc).map((c) => c.field),
    };
  });
}

/** One file-of-ours table doc, by its physical name. */
function easydbDocFor(db: DatabaseSyncType, sqlTable: string): Record<string, unknown> | null {
  return easydbTableDocs(db).find((d) => String(d['_sqlTable']) === sqlTable) ?? null;
}

/**
 * Tables AND views. A view is importable: its current result set snapshots into
 * an ordinary local table. The view DEFINITION does not travel — a derived
 * table is a projection in this app, not SQL — so the import is a snapshot by
 * nature, which is also what makes it safe to treat one exactly like a table
 * from here on.
 */
function listForeignCandidates(db: DatabaseSyncType): Array<{ name: string; sqlTable: string; rowCount: number; isView: boolean; columns: string[]; sql: string }> {
  const rows = db
    .prepare(
      `SELECT name, type, sql FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '\\_easydb%' ESCAPE '\\'
       ORDER BY type, name`,
    )
    .all() as Array<{ name: string; type: 'table' | 'view'; sql: string | null }>;
  return rows.map((r) => ({
    name: r.name,
    sqlTable: r.name,
    // -1 for a view: see `ImportCandidate.rowCount`. Counting one runs it.
    rowCount: r.type === 'view' ? -1 : rowCountOf(db, r.name),
    isView: r.type === 'view',
    // Names only, and cheap (`PRAGMA table_info`): enough for the renderer to
    // offer an append mapping without a second round trip for the schema.
    columns: columnNamesOf(db, r.name),
    // A view's own `CREATE VIEW … AS SELECT …`. Carried so a view can be imported
    // as a PROJECTION — the query, recomputed — rather than only as a snapshot of
    // the rows it returns now. `sql-parse.ts` turns it into a ProjectionSpec.
    sql: r.type === 'view' ? (r.sql ?? '') : '',
  }));
}

/** A source object's column names, in its own order. */
function columnNamesOf(db: DatabaseSyncType, sqlTable: string): string[] {
  try {
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(sqlTable)})`).all() as unknown as RawColumnInfo[];
    return info.map((c) => c.name);
  } catch {
    return []; // an unreadable object simply offers no mapping
  }
}

/**
 * Reads a summary of what `sourcePath` offers, WITHOUT writing anything —
 * the renderer uses this to build its collision prompts before committing.
 * Opened `readOnly` so previewing a file never creates a `-journal`/`-wal`
 * sidecar next to someone else's database.
 */
export function previewImport(sourcePath: string, targetStore: SqliteStore, workspaceId: string): ImportPreview {
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const kind: ImportPreview['kind'] = isEasydbFile(src) ? 'easydb' : 'foreign';
    const raw = kind === 'easydb' ? listEasydbCandidates(src) : listForeignCandidates(src);
    const existingNames = new Set((targetStore.find('tables', { workspaceId }) as Array<{ name: string }>).map((t) => t.name.toLowerCase()));
    return {
      kind,
      sizeBytes: sourceSizeBytes(sourcePath),
      candidates: raw.map((c) => ({
        name: c.name,
        rowCount: c.rowCount,
        collides: existingNames.has(c.name.toLowerCase()),
        ...('isView' in c && c.isView ? { isView: true } : {}),
        // Only useful when the name collides (that is the only time an append is
        // offered), but carried for every candidate rather than making the
        // renderer ask again once the user picks Append.
        ...('columns' in c && c.columns.length > 0 ? { columns: c.columns } : {}),
        ...('sql' in c && typeof c.sql === 'string' && c.sql.length > 0 ? { sql: c.sql } : {}),
      })),
    };
  } finally {
    src.close();
  }
}

// -- Commit ------------------------------------------------------------------

/**
 * What to do about a source table whose name already exists in the workspace.
 *
 * `append` adds the source's rows to the existing table and leaves its SCHEMA
 * exactly as it is — no column is added, renamed or retyped. That is the point of
 * it: the target's columns are the user's own work (labels, renderers, widths,
 * scripts, read-only flags), and a second import must not be able to rewrite
 * them. Anything the source carries that the target has no column for is dropped
 * rather than added, which is why append needs a mapping.
 */
export type CollisionAction = 'overwrite' | 'rename' | 'skip' | 'append';

export interface ImportDecision {
  action: CollisionAction;
  /** Final table name to use. Required for 'rename'; ignored otherwise (the source name is used). */
  renameTo?: string;
  /**
   * For `append`: per SOURCE column — in `ImportCandidate.columns` order — the
   * TARGET field it feeds. `''` drops that column.
   *
   * Positional, aligned to the source's own column order, so the CSV append's
   * `guessMapping`/`ColumnMapping` from `renderer/src/import/map-columns.ts` can
   * be reused verbatim. Absent means match by field name and drop the rest.
   */
  mapping?: string[];
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
  /** Append only: the SOURCE field -> TARGET field map actually used. */
  fieldMap?: Record<string, string> | undefined;
  action: 'created' | 'overwritten' | 'renamed' | 'skipped' | 'appended';
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

/**
 * Streams `sqlTable`'s rows out of `db` in batches, so a large table is never
 * fully materialised. `pacer` decides each batch's size from what the previous
 * one cost the caller — see {@link BatchPacer}.
 */
function* readRowBatches(db: DatabaseSyncType, sqlTable: string, columns: string[], pacer: BatchPacer): Generator<Array<Record<string, unknown>>> {
  const stmt = db.prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(sqlTable)}`);
  let batch: Array<Record<string, unknown>> = [];
  let limit = pacer.size();
  for (const row of stmt.iterate()) {
    batch.push(row);
    if (batch.length >= limit) {
      yield batch;
      batch = [];
      // Re-read AFTER the yield: the consumer has just written that batch and
      // told the pacer what it cost.
      limit = pacer.size();
    }
  }
  if (batch.length > 0) yield batch;
}

/** Resolves what to do for one source table, given the caller's decisions map (keyed by source name). */
/** What one candidate resolved to, plus the append mapping when there is one. */
interface ResolvedAction {
  action: 'create' | 'overwrite' | 'rename' | 'skip' | 'append';
  finalName: string;
  /** Append only: per SOURCE column, the TARGET field it feeds (see `ImportDecision.mapping`). */
  mapping?: string[] | undefined;
}

/**
 * SOURCE field -> TARGET field, from the user's positional mapping when there is
 * one and by matching names when there isn't.
 *
 * Only fields the TARGET actually has can appear on the right: append never adds
 * a column, so a source column with nowhere to go is dropped. Matching falls back
 * to case-insensitive, because SQLite identifiers are.
 */
function buildFieldMap(sourceFields: readonly string[], targetColumns: readonly ColumnSpec[], mapping: readonly string[] | undefined): Record<string, string> {
  const targetByLower = new Map(targetColumns.map((c) => [c.field.toLowerCase(), c.field] as const));
  const out: Record<string, string> = {};
  sourceFields.forEach((sourceField, i) => {
    const chosen = mapping?.[i];
    if (mapping) {
      // An explicit '' means the user dropped this column; respect it.
      if (chosen && targetByLower.has(chosen.toLowerCase())) out[sourceField] = targetByLower.get(chosen.toLowerCase())!;
      return;
    }
    const hit = targetByLower.get(sourceField.toLowerCase());
    if (hit) out[sourceField] = hit;
  });
  return out;
}

/** The past-tense action reported for a resolved one. */
function resultAction(action: ResolvedAction['action']): ImportedTableResult['action'] {
  if (action === 'create') return 'created';
  if (action === 'rename') return 'renamed';
  if (action === 'append') return 'appended';
  if (action === 'skip') return 'skipped';
  return 'overwritten';
}

function resolveAction(candidate: ImportCandidate, decisions: Record<string, ImportDecision>): ResolvedAction {
  const decision = decisions[candidate.name];
  // An explicit skip wins whether or not the name collides. `decisions` started
  // out as purely collision resolution, but two callers now use it to say "not
  // this one" — the Import picker skips every object the user didn't choose, and
  // Convert skips every view — and honouring it only on a collision silently
  // imported both.
  if (decision?.action === 'skip') return { action: 'skip', finalName: candidate.name };
  // Append needs the collision — it is defined by there being an existing table
  // to add to. Without one there is nothing to append to, so it is a plain create.
  if (decision?.action === 'append' && candidate.collides) return { action: 'append', finalName: candidate.name, mapping: decision.mapping };
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
  resolved: ResolvedAction,
  onProgress?: ((p: ImportProgress) => void) | undefined,
  /** Create the table and stop — phase 1 of the two-phase import. */
  structureOnly = false,
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

  // The whole `Table` in one row. `columns` is the recorded `ColumnSpec[]`; the
  // rest is what the block below picks over. Storage-only keys go, so they cannot
  // be carried into the target as if they meant something there.
  const doc = easydbDocFor(src, candidate.sqlTable) ?? {};
  const columns = columnsOfDoc(doc);
  const tableRest: Record<string, unknown> = { ...doc };
  delete tableRest['columns'];
  delete tableRest['_sqlTable'];
  delete tableRest['_ordinal'];

  const reusesExisting = resolved.action === 'overwrite' || resolved.action === 'append';
  const existing = reusesExisting
    ? ((targetStore.find('tables', { workspaceId }) as Array<{ id: string; name: string; columns?: ColumnSpec[] }>).find((t) => t.name.toLowerCase() === candidate.name.toLowerCase()) ?? null)
    : null;

  // Nothing to append to — reported rather than quietly created, which would
  // ignore the very schema the user chose append to protect.
  if (resolved.action === 'append' && !existing) {
    return { sourceName: candidate.name, action: 'skipped', finalName: resolved.finalName, tableId: null, rowCount: 0 };
  }

  const fieldMap =
    resolved.action === 'append'
      ? buildFieldMap(
          columns.map((c) => c.field),
          existing?.columns ?? [],
          resolved.mapping,
        )
      : undefined;

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
  // NOT on append: this doc carries `columns`, so writing it is precisely how an
  // append would replace the schema the user asked to keep.
  if (resolved.action !== 'append') {
    if (existing) targetStore.upsert('tables', table);
    else targetStore.insert('tables', table);
  }

  if (structureOnly) {
    return {
      sourceName: candidate.name,
      action: resultAction(resolved.action),
      finalName: resolved.finalName,
      tableId,
      rowCount: 0,
      ...(fieldMap ? { fieldMap } : {}),
    };
  }

  if (resolved.action === 'overwrite') clearRows(targetStore, tableId);
  let imported = 0;
  for (const p of easydbRowBatches(src, targetStore, {
    tableId,
    sqlTable: candidate.sqlTable,
    finalName: resolved.finalName,
    total: candidate.rowCount,
    fieldMap,
  })) {
    imported = p.rows;
    onProgress?.(p);
  }

  return {
    sourceName: candidate.name,
    action: resultAction(resolved.action),
    finalName: resolved.finalName,
    tableId,
    rowCount: imported,
    ...(fieldMap ? { fieldMap } : {}),
  };
}

// -- Row streaming -----------------------------------------------------------
//
// Both row importers are GENERATORS that yield progress after every written
// batch. One implementation serves two very different callers:
//
//  - `commitImport` drains it synchronously (`for (const p of …)`), so its
//    behaviour and its tests are unchanged.
//  - the `db:importRows` IPC handler drains it with an `await` between batches,
//    which returns control to the main process's event loop — so the window
//    stays responsive and the progress it just sent actually gets drawn.
//
// Nothing accumulates in either case: a batch is written as it is read.
// `readRowBatches` exists precisely so a large table is never fully
// materialised, and an earlier version built a `docs` array of the whole table
// first, which drove the main process past 1.4 GB on a 609,283-row table and
// killed it. Covered by `db-import-streaming.test.ts`.

/** What a row generator needs: where to read from, where to write, how much there is. */
interface RowStreamTarget {
  tableId: string;
  sqlTable: string;
  finalName: string;
  total: number;
  /**
   * Append only: SOURCE field -> TARGET field. A source field absent from this
   * map is DROPPED, never added to the target — appending must not alter the
   * target's schema, and a column the target does not have is not a column the
   * user asked for.
   */
  fieldMap?: Record<string, string> | undefined;
}

/**
 * Renames a row's fields onto the target's, dropping anything unmapped.
 *
 * Dropping rather than passing through is the schema guarantee: `SqliteStore`
 * would otherwise stash an unknown field in `_extra`, so the value would survive
 * invisibly — present in the file, absent from every column the user sees.
 */
function applyFieldMap(data: Record<string, unknown>, fieldMap: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceField, value] of Object.entries(data)) {
    const target = fieldMap[sourceField];
    if (target) out[target] = value;
  }
  return out;
}

function* easydbRowBatches(src: DatabaseSyncType, targetStore: SqliteStore, t: RowStreamTarget): Generator<ImportProgress> {
  const columns = columnsOfDoc(easydbDocFor(src, t.sqlTable) ?? {});
  const rawCols = ['_id', '_updatedAt', '_extra', ...columns.map((c) => c.field)];
  const fallbackAt = Date.now();
  let imported = 0;
  const pacer = new BatchPacer();
  for (const batch of readRowBatches(src, t.sqlTable, rawCols, pacer)) {
    const startedAt = Date.now();
    const docs = batch.map((raw) => {
      const data: Record<string, unknown> = {};
      for (const spec of columns) {
        const v = fromRawSqlValue(spec.type, raw[spec.field]);
        if (v !== null) data[spec.field] = v;
      }
      const extraJson = raw._extra as string | null;
      if (extraJson) Object.assign(data, JSON.parse(extraJson) as Record<string, unknown>);
      return {
        // A NEW id on append: the source's own `_id` may already name a row in
        // the target, and appending must add rows rather than overwrite them.
        id: t.fieldMap ? randomUUID() : (raw._id as string),
        tableId: t.tableId,
        data: t.fieldMap ? applyFieldMap(data, t.fieldMap) : data,
        updatedAt: (raw._updatedAt as number) ?? fallbackAt,
      };
    });
    targetStore.bulkInsert('rows', docs);
    // Timed around the mapping AND the insert, because both run on the thread
    // this is trying not to block.
    pacer.observe(docs.length, Date.now() - startedAt);
    imported += docs.length;
    yield { table: t.finalName, rows: imported, total: t.total };
  }
}

function* foreignRowBatches(src: DatabaseSyncType, targetStore: SqliteStore, t: RowStreamTarget): Generator<ImportProgress> {
  const info = src.prepare(`PRAGMA table_info(${quoteIdent(t.sqlTable)})`).all() as unknown as RawColumnInfo[];
  const columns = inferForeignColumns(src, t.sqlTable);
  // Original (un-renamed) column names, in the same order as `columns` — a
  // reserved name was renamed by `safeFieldName`, so the two can differ.
  const sourceFieldNames = info.map((c) => c.name);
  const importedAt = Date.now(); // one import is one instant, not one per row
  let imported = 0;
  const pacer = new BatchPacer();
  for (const batch of readRowBatches(src, t.sqlTable, sourceFieldNames, pacer)) {
    const startedAt = Date.now();
    const docs = batch.map((raw) => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        const spec = columns[i]!;
        const sourceField = sourceFieldNames[i]!;
        const v = fromRawSqlValue(spec.type, raw[sourceField]);
        if (v !== null) data[spec.field] = v;
      }
      return { id: randomUUID(), tableId: t.tableId, data: t.fieldMap ? applyFieldMap(data, t.fieldMap) : data, updatedAt: importedAt };
    });
    targetStore.bulkInsert('rows', docs);
    pacer.observe(docs.length, Date.now() - startedAt);
    imported += docs.length;
    yield { table: t.finalName, rows: imported, total: t.total };
  }
}

// -- Two-phase import: structure first, rows in the background ---------------

/** One table the user asked for: created and empty, waiting for its rows. */
export interface ImportPlanEntry {
  sourceName: string;
  finalName: string;
  tableId: string;
  /** The object to read rows from, in the SOURCE file. */
  sqlTable: string;
  /** Rows the source reports — the denominator for the progress percentage. */
  total: number;
  /** Which read path this table's rows need. */
  kind: 'easydb' | 'foreign';
  action: 'created' | 'overwritten' | 'renamed' | 'appended';
  /** Append only: SOURCE field -> TARGET field, resolved when the plan was made. */
  fieldMap?: Record<string, string> | undefined;
}

export interface ImportPlan {
  plan: ImportPlanEntry[];
  /** Objects the user did not choose, reported so the summary can count them. */
  skipped: ImportedTableResult[];
}

/**
 * Phase 1 — create the chosen tables' STRUCTURE and nothing else.
 *
 * A handful of statements regardless of how much data the file holds, so the
 * windows can appear at once (minimized, holding no rows, mounting no grid)
 * while phase 2 fills them in. This is what stops a big file looking like a
 * hang: the user sees what they asked for immediately.
 */
export function prepareImport(sourcePath: string, targetStore: SqliteStore, workspaceId: string, decisions: Record<string, ImportDecision>): ImportPlan {
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const kind: ImportPreview['kind'] = isEasydbFile(src) ? 'easydb' : 'foreign';
    const raw = kind === 'easydb' ? listEasydbCandidates(src) : listForeignCandidates(src);
    const existingNames = new Set((targetStore.find('tables', { workspaceId }) as Array<{ name: string }>).map((t) => t.name.toLowerCase()));
    const plan: ImportPlanEntry[] = [];
    const skipped: ImportedTableResult[] = [];
    for (const c of raw) {
      const candidate: ImportCandidate = {
        name: c.name,
        rowCount: c.rowCount,
        collides: existingNames.has(c.name.toLowerCase()),
      };
      const resolved = resolveAction(candidate, decisions);
      const result =
        kind === 'easydb' ? importEasydbTable(src, targetStore, workspaceId, c, resolved, undefined, true) : importForeignTable(src, targetStore, workspaceId, c, resolved, undefined, true);
      if (result.action === 'skipped' || !result.tableId) {
        skipped.push(result);
        continue;
      }
      // Minimized, and cascaded so restoring them does not stack them all at
      // one spot. A minimized window mounts no grid and reads no rows (see
      // `jspanel-manager.ts`), which is what keeps phase 1 free: the user sees
      // every table they asked for without any of them loading.
      const n = plan.length;
      // An append writes into a table the user already has open and placed —
      // moving or minimizing it would be the import rearranging their desk.
      if (result.action !== 'appended')
        targetStore.patch('tables', result.tableId, {
          windowGeometry: {
            x: 40 + (n % 10) * 24,
            y: 40 + (n % 10) * 24,
            w: 640,
            h: 360,
            z: n,
            minimized: true,
            maximized: false,
          },
        });
      plan.push({
        sourceName: result.sourceName,
        finalName: result.finalName,
        tableId: result.tableId,
        sqlTable: c.sqlTable,
        total: c.rowCount,
        kind,
        action: result.action,
        ...(result.fieldMap ? { fieldMap: result.fieldMap } : {}),
      });
    }
    return { plan, skipped };
  } finally {
    src.close();
  }
}

/**
 * Phase 2 — the rows for ONE planned table, yielding progress per batch.
 *
 * Deliberately a generator, not a plain function: the IPC handler awaits
 * between batches so the main process's event loop keeps turning, which is what
 * lets the window stay usable and repaint the progress while a big table loads.
 */
export function* importRowsFor(sourcePath: string, targetStore: SqliteStore, entry: ImportPlanEntry): Generator<ImportProgress> {
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const target: RowStreamTarget = {
      fieldMap: entry.fieldMap,
      tableId: entry.tableId,
      sqlTable: entry.sqlTable,
      finalName: entry.finalName,
      total: entry.total,
    };
    if (entry.action === 'overwritten') clearRows(targetStore, entry.tableId);
    if (entry.kind === 'easydb') yield* easydbRowBatches(src, targetStore, target);
    else yield* foreignRowBatches(src, targetStore, target);
  } finally {
    src.close();
  }
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
  resolved: ResolvedAction,
  onProgress?: ((p: ImportProgress) => void) | undefined,
  /** Create the table and stop — phase 1 of the two-phase import. */
  structureOnly = false,
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

  const columns = inferForeignColumns(src, candidate.sqlTable);

  const reusesExisting = resolved.action === 'overwrite' || resolved.action === 'append';
  const existing = reusesExisting
    ? ((targetStore.find('tables', { workspaceId }) as Array<{ id: string; name: string; columns?: ColumnSpec[] }>).find((t) => t.name.toLowerCase() === candidate.name.toLowerCase()) ?? null)
    : null;

  // Appending to a table that has since been deleted has nothing to append to.
  // Creating it instead would silently ignore the schema the user was protecting,
  // so this is reported rather than guessed at.
  if (resolved.action === 'append' && !existing) {
    return { sourceName: candidate.name, action: 'skipped', finalName: resolved.finalName, tableId: null, rowCount: 0 };
  }

  const tableId = existing?.id ?? randomUUID();

  // The map from the SOURCE's columns onto the TARGET's, for append only.
  const fieldMap =
    resolved.action === 'append'
      ? buildFieldMap(
          columns.map((c) => c.field),
          existing?.columns ?? [],
          resolved.mapping,
        )
      : undefined;
  const table = {
    id: tableId,
    workspaceId,
    name: resolved.finalName,
    code: resolved.finalName,
    columns,
    view: 'table',
    updatedAt: Date.now(),
  };
  // NOT written on append: the target's `columns` are the user's own work, and
  // writing this doc is exactly how an append would clobber them.
  if (resolved.action !== 'append') {
    if (existing) targetStore.upsert('tables', table);
    else targetStore.insert('tables', table);
  }

  if (structureOnly) {
    return {
      sourceName: candidate.name,
      action: resultAction(resolved.action),
      finalName: resolved.finalName,
      tableId,
      rowCount: 0,
      ...(fieldMap ? { fieldMap } : {}),
    };
  }

  if (resolved.action === 'overwrite') clearRows(targetStore, tableId);
  let imported = 0;
  for (const p of foreignRowBatches(src, targetStore, {
    tableId,
    sqlTable: candidate.sqlTable,
    finalName: resolved.finalName,
    total: candidate.rowCount,
    fieldMap,
  })) {
    imported = p.rows;
    onProgress?.(p);
  }

  return {
    sourceName: candidate.name,
    action: resultAction(resolved.action),
    finalName: resolved.finalName,
    tableId,
    rowCount: imported,
    ...(fieldMap ? { fieldMap } : {}),
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
    const existingNames = new Set((targetStore.find('tables', { workspaceId }) as Array<{ name: string }>).map((t) => t.name.toLowerCase()));
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
      results.push(kind === 'easydb' ? importEasydbTable(src, targetStore, workspaceId, c, resolved, onProgress) : importForeignTable(src, targetStore, workspaceId, c, resolved, onProgress));
    }
    return results;
  } finally {
    targetStore.setDurability('safe');
    src.close();
  }
}
