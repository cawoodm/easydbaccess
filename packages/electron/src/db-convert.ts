/**
 * "Convert to EDA" — turn a foreign SQLite file into an easyDBAccess workspace
 * file, so it can be OPENED rather than only imported.
 *
 * The result is a NEW file; the source is opened read-only and never written.
 * Converting in place was rejected: an easydb rows table needs
 * `_id TEXT PRIMARY KEY` / `_updatedAt` / `_extra`, and a stranger's table has
 * its own primary key instead — so in place would mean three `ALTER TABLE ADD
 * COLUMN`s on the user's own tables plus an `_id` backfill for every row, with
 * `_id` only ever reaching a UNIQUE INDEX (SQLite cannot add a primary key
 * after the fact). See `.claude/plans/2026-08-03-open-db-three-ways.md`.
 *
 * The conversion itself is `commitImport` into a fresh store, so the type
 * inference and naming rules are the ones `db-import.ts` already carries — this
 * module only owns the destination file and the workspace it needs to be
 * openable.
 */

import { SqliteStore } from './sqlite-store';
import { commitImport, prepareImport, previewImport, sourceSizeBytes, type ImportDecision, type ImportPlan, type ImportProgress, type ImportedTableResult } from './db-import';

/**
 * The workspace id a converted file gets. `default` is what the renderer's own
 * boot resolution creates when it finds no workspace (`app-context.ts`), so a
 * converted file opens as an ordinary first-run workspace rather than one the
 * renderer has to invent a second id for.
 */
const CONVERTED_WORKSPACE_ID = 'default';

export interface ConvertResult {
  path: string;
  tables: ImportedTableResult[];
}

/**
 * The workspace the renderer will adopt on boot instead of creating one — what
 * makes the converted file "openable" rather than merely readable.
 */
function ensureWorkspace(dest: SqliteStore): void {
  if (dest.findOne('workspaces', CONVERTED_WORKSPACE_ID)) return;
  dest.insert('workspaces', {
    id: CONVERTED_WORKSPACE_ID,
    name: CONVERTED_WORKSPACE_ID,
    createdAt: Date.now(),
    pluginUrls: [],
  });
}

/**
 * Whatever the caller didn't ask for becomes an explicit `skip`, and a view is
 * skipped unless it was named outright.
 *
 * A converted workspace mirrors what the file STORES; a view is derived, and
 * snapshotting one freezes a stale copy of a query beside the tables it was
 * computed from. It is also ruinously expensive: converting `northwind.db` with
 * its views went from 13 objects / 625,890 rows to 30 / 1,909,973, because
 * several of its views join the 609k-row `Order Details`.
 */
function decisionsFor(sourcePath: string, dest: SqliteStore, only: string[] | undefined): Record<string, ImportDecision> {
  const preview = previewImport(sourcePath, dest, CONVERTED_WORKSPACE_ID);
  const wanted = only ? new Set(only) : null;
  const decisions: Record<string, ImportDecision> = {};
  for (const c of preview.candidates) {
    const asked = wanted ? wanted.has(c.name) : !c.isView;
    if (!asked) decisions[c.name] = { action: 'skip' };
  }
  return decisions;
}

/**
 * Writes `destPath` as an easydb workspace holding the tables found in
 * `sourcePath`. `destPath` must not be an existing easydb file — the caller's
 * save dialog is what confirms overwriting anything.
 *
 * `only` narrows the conversion to those source object names; omitting it takes
 * every table. The renderer always passes it (it asks first, the same way Import
 * does), but the default matters for callers that have nobody to ask — the tests
 * and any future headless conversion.
 */
export function convertToEasydb(sourcePath: string, destPath: string, onProgress?: ((p: ImportProgress) => void) | undefined, only?: string[] | undefined): ConvertResult {
  const dest = new SqliteStore({ path: destPath });
  try {
    ensureWorkspace(dest);
    const decisions = decisionsFor(sourcePath, dest, only);
    const results = commitImport(sourcePath, dest, CONVERTED_WORKSPACE_ID, decisions, onProgress);
    // Skipped views would otherwise be reported as converted-with-zero-rows.
    return { path: destPath, tables: results.filter((r) => r.action !== 'skipped') };
  } finally {
    dest.close();
  }
}

/**
 * The settings entry a half-finished conversion leaves behind, so the renderer
 * can pick the row copying up after the reload.
 *
 * Convert has to reload the window — the workspace on screen becomes a
 * different file — and a reload throws away any work in flight. Writing the
 * remaining plan INTO the new file is what makes phase 2 survive it, and it
 * survives quitting the app mid-import for the same reason: whoever opens the
 * file next finds the note and finishes the job.
 */
export const PENDING_IMPORT_SETTING = 'electron-db:pendingImport';

export interface PendingImport {
  /** The foreign file still being read. */
  sourcePath: string;
  /** Tables already created (empty) in this file, each waiting for its rows. */
  plan: ImportPlan['plan'];
  /**
   * The source file's size on disk, carried across the reload because the
   * renderer decides what to leave minimized and cannot stat the file itself.
   * Absent in a note written before this field existed — read as 0 (small).
   */
  sizeBytes?: number;
}

export interface PrepareConvertResult {
  path: string;
  pending: PendingImport;
}

/**
 * Phase 1 of Convert: write `destPath` with the workspace and the chosen tables'
 * STRUCTURE only, plus a note saying which rows are still owed.
 *
 * This exists because the whole-file `convertToEasydb` is not something a user
 * can be asked to sit through: converting `northwind.db` took 14.8 seconds of
 * synchronous work with no window, no tables and no progress, and it grows with
 * the file. Structure alone is ~70ms, so the windows appear at once and the rows
 * stream in behind them with a percentage each, the same way Import works.
 */
export function prepareConvert(sourcePath: string, destPath: string, only?: string[] | undefined): PrepareConvertResult {
  const dest = new SqliteStore({ path: destPath });
  try {
    ensureWorkspace(dest);
    const decisions = decisionsFor(sourcePath, dest, only);
    const { plan } = prepareImport(sourcePath, dest, CONVERTED_WORKSPACE_ID, decisions);
    const pending: PendingImport = { sourcePath, plan, sizeBytes: sourceSizeBytes(sourcePath) };
    dest.upsert('settings', {
      key: `${CONVERTED_WORKSPACE_ID}::${PENDING_IMPORT_SETTING}`,
      workspaceId: CONVERTED_WORKSPACE_ID,
      name: PENDING_IMPORT_SETTING,
      value: pending,
    });
    return { path: destPath, pending };
  } finally {
    dest.close();
  }
}

/**
 * `foo.sqlite` → `foo.edb` — the name the save dialog offers.
 *
 * `.edb` marks a SQLite file carrying our metadata, so a later drag-and-drop
 * knows it is a workspace to OPEN rather than data to import. The old suggestion
 * was `foo.eda.db`, which read as a plain `.db` and got offered for import.
 */
export function suggestConvertedName(sourcePath: string): string {
  const base = sourcePath.replace(/\\/g, '/').split('/').pop() ?? 'database';
  const stem = base.replace(/\.(edb|db|sqlite|sqlite3)$/i, '');
  return `${stem}.edb`;
}
