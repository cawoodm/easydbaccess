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
import { prepareConvert, suggestConvertedName } from './db-convert';
import { commitImport, previewImport, probeDatabaseFile, type DatabaseFileKind, type ImportDecision, type ImportedTableResult, type ImportPreview } from './db-import';

/**
 * The app's own workspace file, used when nothing else is chosen.
 *
 * Still `.db` for existing installs — renaming it would orphan every workspace
 * already on disk. New files the user names get `.edb` (see
 * `DEFAULT_WORKSPACE_NAME` and `suggestConvertedName`).
 */
const DEFAULT_DB_NAME = 'easydbaccess.db';

/** What Save As offers when there is no workspace to name the file after. */
const DEFAULT_WORKSPACE_NAME = 'easydbaccess.edb';

/**
 * `<workspace name>.edb` — the file name Save As proposes.
 *
 * Falls back to the generic name when the store holds no workspace yet, and
 * sanitises the name because a workspace may legally contain characters a file
 * name may not.
 */
function workspaceFileName(): string {
  try {
    const workspaces = getStore().find('workspaces') as Array<{ name?: string }>;
    const name = workspaces[0]?.name?.trim();
    if (!name) return DEFAULT_WORKSPACE_NAME;
    const safe = name.replace(/[^a-zA-Z0-9 _-]+/g, '_').trim();
    return `${safe || 'workspace'}.${WORKSPACE_EXTENSION}`;
  } catch {
    return DEFAULT_WORKSPACE_NAME;
  }
}

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
 * A workspace file — one carrying our metadata — versus a plain SQLite database.
 *
 * The extension is a claim, not proof: `probeDatabaseFile` still decides what a
 * file really is before anything is opened. What the extension buys is knowing
 * the user's INTENT without asking. Dropping `sales.edb` means "open my
 * workspace"; dropping `sales.db` means "take the data out of this". Asking
 * which, every time, was noise.
 */
export const WORKSPACE_EXTENSION = 'edb';

/** Plain SQLite databases — data to import, not workspaces to open. */
export const PLAIN_DB_EXTENSIONS = ['db', 'sqlite', 'sqlite3'];

export function isWorkspaceFileName(name: string): boolean {
  return name.toLowerCase().endsWith(`.${WORKSPACE_EXTENSION}`);
}

/**
 * Whether the last workspace opens by itself on startup.
 *
 * Lives beside the remembered path rather than inside a workspace, for the same
 * chicken-and-egg reason: it is consulted BEFORE any file is opened, so it cannot
 * be stored in the file whose opening it governs. Defaults to true — the app
 * picking up where it left off is what almost everyone wants, and the setting
 * exists for the case where a huge workspace makes that the wrong default.
 */
function readAutoLoadLast(): boolean {
  try {
    const raw = readFileSync(locationFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { autoLoadLastWorkspace?: unknown };
    return parsed.autoLoadLastWorkspace !== false;
  } catch {
    return true;
  }
}

export function autoLoadLastWorkspace(): boolean {
  return readAutoLoadLast();
}

export function setAutoLoadLastWorkspace(on: boolean): void {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(locationFilePath(), 'utf-8')) as Record<string, unknown>;
  } catch {
    /* no config yet */
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(locationFilePath(), JSON.stringify({ ...current, autoLoadLastWorkspace: on }), 'utf-8');
}

/**
 * A workspace file named on the command line — `easyDBAccess sales.edb`.
 *
 * Takes precedence over both the remembered path and the auto-load setting: an
 * explicit argument is the least ambiguous instruction the app can receive.
 * Electron's argv carries the app path (and, in dev, a bare `.`) before any user
 * argument, so this looks for the first thing that names a file that exists
 * rather than trusting a position.
 */
export function workspaceFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-') || arg === '.') continue;
    if (!isWorkspaceFileName(arg)) continue;
    const resolved = path.resolve(arg);
    if (existsSync(resolved)) return resolved;
  }
  return null;
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
  // Merged, not overwritten: this file also carries `autoLoadLastWorkspace`, and
  // rewriting it wholesale silently reset that setting on the next Open.
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(locationFilePath(), 'utf-8')) as Record<string, unknown>;
  } catch {
    /* no config yet */
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(locationFilePath(), JSON.stringify({ ...current, path: dbPath }), 'utf-8');
}

// -- The switchable store singleton ----------------------------------------

let store: SqliteStore | null = null;
let currentPath: string | null = null;
let fellBackToDefault = false;

/** Resolves (once) which path the store should live at — from disk the first time, then in-memory. */
function ensurePath(): string {
  if (currentPath) return currentPath;
  // An explicit `easyDBAccess sales.edb` wins over everything remembered, and
  // becomes the remembered path so a later launch without the argument reopens it.
  const fromArgv = workspaceFromArgv(process.argv);
  if (fromArgv) {
    currentPath = fromArgv;
    fellBackToDefault = false;
    persistLocation(fromArgv);
    return currentPath;
  }
  // Turned off, the app starts on its own default file instead of reopening
  // whatever was last used — which is the point of the setting for someone whose
  // last workspace is large.
  if (!readAutoLoadLast()) {
    currentPath = defaultDbPath();
    fellBackToDefault = false;
    return currentPath;
  }
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
  // Workspaces first: Open is for workspaces, and a plain `.db` cannot be opened
  // as one (it has no workspace in it) — it can only be imported or browsed.
  { name: 'easyDBAccess workspace', extensions: [WORKSPACE_EXTENSION] },
  { name: 'SQLite database', extensions: PLAIN_DB_EXTENSIONS },
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
export async function pickDatabaseToOpen(win: BrowserWindow | null): Promise<DialogResult<{ path: string; kind: DatabaseFileKind }> | CancelledResult> {
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
export async function saveDbAs(win: BrowserWindow | null): Promise<DialogResult<{ path: string }> | CancelledResult> {
  const opts = {
    title: 'Save easyDBAccess database as',
    // Named after the workspace, not a generic default: a folder of files called
    // `easydbaccess.edb` is indistinguishable, and the workspace already has the
    // name the user chose.
    defaultPath: workspaceFileName(),
    filters: [{ name: 'easyDBAccess workspace', extensions: [WORKSPACE_EXTENSION] }],
  };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

  const from = getStore().filePath;
  // In WAL mode a committed row can still be sitting in the `-wal` sidecar, and
  // `copyDatabase` copies only the `.db` — so fold it in first or the copy is
  // missing its newest writes. Closing usually checkpoints too, but not while
  // another connection (the import worker) still has the file open.
  getStore().checkpoint();
  store?.close();
  store = null;
  copyDatabase(from, result.filePath);
  switchToPath(result.filePath);
  return { ok: true, path: result.filePath };
}

// -- Import -----------------------------------------------------------------

// -- Convert -----------------------------------------------------------------

/**
 * Asks where to put the converted copy, writes it (`db-convert.ts`), then makes
 * it the active file and reloads — the same "the workspace on screen is now a
 * different file" move as Open, so it ends the same way.
 */
export async function convertAndOpen(
  win: BrowserWindow | null,
  sourcePath: string,
  only?: string[] | undefined,
): Promise<DialogResult<{ path: string; tables: ImportedTableResult[]; pending: number }> | CancelledResult> {
  const opts = {
    title: 'Save the converted database as',
    defaultPath: suggestConvertedName(sourcePath),
    filters: [{ name: 'easyDBAccess workspace', extensions: [WORKSPACE_EXTENSION] }],
  };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

  // Structure only — the rows follow after the reload, driven by the renderer
  // from the note `prepareConvert` leaves in the new file. Converting the whole
  // file here instead meant ~15 seconds of nothing for `northwind.db`.
  const prepared = prepareConvert(sourcePath, result.filePath, only);
  switchToPath(prepared.path);
  win?.reload();
  return { ok: true, path: prepared.path, tables: [], pending: prepared.pending.plan.length };
}

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
export async function importDb(win: BrowserWindow | null, workspaceId: string, sourcePath?: string): Promise<DialogResult<{ path: string; preview: ImportPreview }> | CancelledResult> {
  const chosen = sourcePath ?? (await pickOpenFile(win, 'Import a SQLite database'));
  if (!chosen) return { ok: false, cancelled: true };
  const preview = previewImport(chosen, getStore(), workspaceId);
  return { ok: true, path: chosen, preview };
}

/** Step 2 of Import: write the previewed file's tables/rows, per the caller's collision decisions. */
export function importDbCommit(sourcePath: string, workspaceId: string, decisions: Record<string, ImportDecision>): ImportedTableResult[] {
  return commitImport(sourcePath, getStore(), workspaceId, decisions);
}
