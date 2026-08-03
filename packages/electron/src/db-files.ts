/**
 * File-level operations on the SQLite store: which file is open, Open,
 * Save As, and Import (the importer itself is `db-import.ts`). Split out of
 * `main.ts` to keep that file to its wiring — see `CLAUDE.md`'s ~250-line
 * guideline for that file.
 *
 * This module — not `main.ts` — owns the store SINGLETON, because "Open"
 * has to close the current store and repoint the lazy getter at a new path.
 * `main.ts`'s original `let store` + `getStore()` could only ever open once;
 * everything here is that same idea made switchable.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SqliteStore, copyDatabase } from './sqlite-store';
import {
  commitImport,
  previewImport,
  probeDatabaseFile,
  type DatabaseFileKind,
  type ImportDecision,
  type ImportedTableResult,
  type ImportPreview,
} from './db-import';

const DEFAULT_DB_NAME = 'easydbaccess.db';

/**
 * Remembers the last-opened `.db` path across restarts. Deliberately a tiny
 * JSON file next to (not inside) the database: it has to be readable before
 * any `SqliteStore` exists (chicken/egg — the path tells us which file to
 * open), and it must survive independently of whichever `.db` is currently
 * active, including the case where that file was moved or deleted outside
 * the app. Living in `userData` (not the .db's own folder, which the user
 * picked and may not want the app writing into) is the same reasoning
 * `getStore()`'s original default already used.
 */
const LOCATION_FILE_NAME = 'db-location.json';

function defaultDbPath(): string {
  return path.join(app.getPath('userData'), DEFAULT_DB_NAME);
}

function locationFilePath(): string {
  return path.join(app.getPath('userData'), LOCATION_FILE_NAME);
}

interface PersistedLocation {
  path: string;
  isDefault: boolean;
  /** True when a remembered path no longer exists and we fell back to the default. */
  fellBack: boolean;
}

/**
 * Reads the persisted path. Falls back to the default — silently, but the
 * caller gets `fellBack: true` so the UI can say so — when there is no
 * location file yet (first run), it's corrupt, or the remembered file was
 * since moved/deleted. Without this flag a user who moved their `.db` would
 * just see a blank default database with no indication why.
 */
function readPersistedLocation(): PersistedLocation {
  try {
    const raw = readFileSync(locationFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { path?: string };
    if (parsed.path && existsSync(parsed.path)) {
      return { path: parsed.path, isDefault: parsed.path === defaultDbPath(), fellBack: false };
    }
    if (parsed.path) {
      return { path: defaultDbPath(), isDefault: true, fellBack: true };
    }
  } catch {
    /* no location file yet, or it's unreadable/corrupt — use the default */
  }
  return { path: defaultDbPath(), isDefault: true, fellBack: false };
}

function persistLocation(dbPath: string): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(locationFilePath(), JSON.stringify({ path: dbPath }), 'utf-8');
}

// -- The switchable store singleton ----------------------------------------

let store: SqliteStore | null = null;
let currentPath: string | null = null;
let fellBackToDefault = false;

/** Resolves (once) which path the store should live at — from disk the first time, then in-memory. */
function ensurePath(): string {
  if (currentPath) return currentPath;
  const resolved = readPersistedLocation();
  currentPath = resolved.path;
  fellBackToDefault = resolved.fellBack;
  return currentPath;
}

/** Opens the store on first use, at the persisted (or default) path. */
export function getStore(): SqliteStore {
  if (store) return store;
  const p = ensurePath();
  mkdirSync(path.dirname(p), { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`[easydb] SQLite store: ${p}`);
  store = new SqliteStore({ path: p });
  return store;
}

/** Closes the current store (if open) and repoints the singleton at `newPath`, persisting the choice. */
function switchToPath(newPath: string): void {
  store?.close();
  store = null;
  currentPath = newPath;
  fellBackToDefault = false;
  persistLocation(newPath);
}

export interface CurrentDbInfo {
  path: string;
  isDefault: boolean;
  /** True when the remembered path was gone at boot and this session fell back to the default. */
  fellBackToDefault: boolean;
}

export function currentDbInfo(): CurrentDbInfo {
  const p = getStore().filePath;
  return { path: p, isDefault: p === defaultDbPath(), fellBackToDefault };
}

// -- Dialog helpers ----------------------------------------------------------

const DB_FILE_FILTERS = [
  { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] },
  { name: 'All Files', extensions: ['*'] },
];

export type DialogResult<T> = { ok: true } & T;
export type CancelledResult = { ok: false; cancelled: true };

/** `dialog.showOpenDialog` also accepts being called with no parent window — used when no `BrowserWindow` is available. */
async function pickOpenFile(win: BrowserWindow | null, title: string): Promise<string | null> {
  const opts = { title, filters: DB_FILE_FILTERS, properties: ['openFile' as const] };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0]!;
}

// -- Open ---------------------------------------------------------------------
//
// Split into pick-then-commit, like Import below: opening a different file
// replaces the whole workspace view, and the renderer is asked to confirm
// that BEFORE it happens, naming the exact file the user just picked in the
// OS dialog — which means the dialog has to run and return a path before the
// renderer can even compose that confirm message. A single do-it-all call
// (as Save As gets away with, having no such confirmation) can't fit that.

/**
 * Step 1 of Open: the OS file picker plus a read-only classification of what
 * was picked — no side effects yet.
 *
 * `kind` is what stops Open from being destructive on the wrong file. Only an
 * `easydb` file has tables this app can list; `switchToDatabase` on a
 * `foreign` one would ADD our two bookkeeping tables to a stranger's database
 * and then show an empty workspace, and on an `unreadable` one it would fail
 * after the window had already reloaded. The renderer decides what to offer
 * for each (see `plugins/electron-db.ts`).
 */
export async function pickDatabaseToOpen(
  win: BrowserWindow | null,
): Promise<DialogResult<{ path: string; kind: DatabaseFileKind }> | CancelledResult> {
  const chosen = await pickOpenFile(win, 'Open easyDBAccess database');
  if (!chosen) return { ok: false, cancelled: true };
  return { ok: true, path: chosen, kind: probeDatabaseFile(chosen) };
}

/**
 * Step 2 of Open: closes the current store, repoints the singleton at
 * `newPath`, persists the choice, then reloads `win` so `app-context.ts`
 * re-initialises against the new file's data from scratch — unlike Save As,
 * this genuinely changes what the user sees, so a reload is required.
 */
export function switchToDatabase(win: BrowserWindow | null, newPath: string): { ok: true; path: string } {
  switchToPath(newPath);
  win?.reload();
  return { ok: true, path: newPath };
}

// -- Save As --------------------------------------------------------------

/**
 * Saves a copy of the current database to a user-chosen path, THEN switches
 * the active file to that copy — the same convention as Save As in most
 * desktop apps (a Word doc, a VS Code untitled file, …): once you "Save As
 * new-name.db", further edits land in new-name.db, not silently back in the
 * original while an unsuspecting copy sits untouched elsewhere. The
 * alternative (copy, but keep writing to the original) would surprise a user
 * who edits after Save As and finds the new file didn't change.
 *
 * `copyDatabase` documents that the source must not be mid-write (a raw file
 * copy of a live database can capture a torn write), so the store is closed
 * before copying and reopened at the NEW path afterward — never copied while
 * open. No window reload here: the data is identical to what's already
 * rendered (a copy, not a different file), only the on-disk destination for
 * future writes changed, so there is nothing for `app-context.ts` to
 * re-fetch. Reloading anyway would just be a pointless UI flash.
 */
export async function saveDbAs(
  win: BrowserWindow | null,
): Promise<DialogResult<{ path: string }> | CancelledResult> {
  const opts = {
    title: 'Save easyDBAccess database as',
    defaultPath: DEFAULT_DB_NAME,
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

  const from = getStore().filePath;
  store?.close();
  store = null;
  copyDatabase(from, result.filePath);
  switchToPath(result.filePath);
  return { ok: true, path: result.filePath };
}

// -- Import -----------------------------------------------------------------

/**
 * Step 1 of Import: pick a file, then PREVIEW it (table names, row counts,
 * which ones collide with an existing table in `workspaceId`) without
 * writing anything. Two-phase because collision resolution (Overwrite /
 * Rename / Skip, matching `datasette-connect.ts`'s convention for a name
 * clash) needs a user decision that only the renderer can prompt for — see
 * `db-import.ts`'s doc comment for the full reasoning.
 *
 * `sourcePath` skips the picker. That's for the Open-fell-through-to-Import
 * path: the user already chose a file, it turned out to be a foreign one, and
 * asking them to find it a second time would be absurd.
 */
export async function importDb(
  win: BrowserWindow | null,
  workspaceId: string,
  sourcePath?: string,
): Promise<DialogResult<{ path: string; preview: ImportPreview }> | CancelledResult> {
  const chosen = sourcePath ?? (await pickOpenFile(win, 'Import a SQLite database'));
  if (!chosen) return { ok: false, cancelled: true };
  const preview = previewImport(chosen, getStore(), workspaceId);
  return { ok: true, path: chosen, preview };
}

/** Step 2 of Import: write the previewed file's tables/rows, per the caller's collision decisions. */
export function importDbCommit(
  sourcePath: string,
  workspaceId: string,
  decisions: Record<string, ImportDecision>,
): ImportedTableResult[] {
  return commitImport(sourcePath, getStore(), workspaceId, decisions);
}
