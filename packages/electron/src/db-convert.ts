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
import { commitImport, type ImportedTableResult } from './db-import';

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
 * Writes `destPath` as an easydb workspace holding every table found in
 * `sourcePath`. `destPath` must not be an existing easydb file — the caller's
 * save dialog is what confirms overwriting anything.
 */
export function convertToEasydb(sourcePath: string, destPath: string): ConvertResult {
  const dest = new SqliteStore({ path: destPath });
  try {
    // The renderer will find and adopt this workspace on boot instead of
    // creating one, which is what makes the converted file "openable".
    if (!dest.findOne('workspaces', CONVERTED_WORKSPACE_ID)) {
      dest.insert('workspaces', {
        id: CONVERTED_WORKSPACE_ID,
        name: CONVERTED_WORKSPACE_ID,
        createdAt: Date.now(),
        pluginUrls: [],
      });
    }
    // No decisions to make: the destination is fresh, so nothing can collide.
    const tables = commitImport(sourcePath, dest, CONVERTED_WORKSPACE_ID, {});
    return { path: destPath, tables };
  } finally {
    dest.close();
  }
}

/** `foo.sqlite` → `foo.eda.db` — the name the save dialog offers. */
export function suggestConvertedName(sourcePath: string): string {
  const base = sourcePath.replace(/\\/g, '/').split('/').pop() ?? 'database';
  const stem = base.replace(/\.(db|sqlite|sqlite3)$/i, '');
  return `${stem}.eda.db`;
}
