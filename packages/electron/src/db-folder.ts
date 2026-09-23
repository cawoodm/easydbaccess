/**
 * The workspace folder on the desktop: the folder the user's `.edb` files live
 * in, what is in each of them, and making a new one.
 *
 * **This is the desktop half of a feature the browser already had.** There, a
 * `showDirectoryPicker` grant covers every file in a folder, so the app can list
 * the user's workspaces without an OS dialog per file. The desktop has no
 * permission to ask for — it can read any path — so all that is needed is the
 * path itself, remembered.
 *
 * Every read here opens the file `readOnly` and closes it again, so listing a
 * folder leaves every file in it byte-identical, not even a `-wal` beside it.
 * `db-browse.ts` works the same way and for the same reason: the user asked what
 * is in the folder, not to open any of it.
 *
 * Pure Node apart from the picker, so the scan and the peek are unit-testable
 * without an Electron runtime. The one function that needs a window takes it as
 * an argument.
 */

import { dialog, type BrowserWindow } from 'electron';
import * as path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { patchLocationConfig, readLocationConfig, WORKSPACE_EXTENSION } from './db-files';
import { SqliteStore } from './sqlite-store';

// Same require-not-import trick as `sqlite-store.ts` — see the comment there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** The config key the folder path is remembered under. */
const FOLDER_KEY = 'workspaceFolder';

/** One workspace found inside one file in the folder. Mirrors the browser's `FolderWorkspace`. */
export interface FolderWorkspaceInfo {
  id: string;
  name: string;
  title?: string | undefined;
  tables: number;
  views: number;
}

/** One `.edb` in the folder, and the workspaces a peek found in it. */
export interface FolderFileInfo {
  file: string;
  size: number;
  mtime: number;
  /**
   * Empty when the file was skipped, is not ours, or could not be read.
   *
   * A file with no workspaces is still listed. The Local Data dialog has to show
   * it or there would be no way to switch it back on.
   */
  workspaces: FolderWorkspaceInfo[];
}

export interface FolderScan {
  /** The folder's own name, for the dialog. Not the whole path — that is the tooltip's job. */
  folder: string;
  /** The full path, so the renderer can turn a file name back into something openable. */
  folderPath: string;
  at: number;
  files: FolderFileInfo[];
}

// -- the remembered folder ---------------------------------------------------

/**
 * The folder the user connected, or null.
 *
 * A path that no longer exists answers null rather than a broken folder: the
 * user moved or deleted it, and every caller then behaves as if none were
 * connected, which is the recoverable state.
 */
export function workspaceFolder(): string | null {
  const stored = readLocationConfig()[FOLDER_KEY];
  if (typeof stored !== 'string' || !stored) return null;
  return existsSync(stored) ? stored : null;
}

export function setWorkspaceFolder(dir: string | null): void {
  patchLocationConfig({ [FOLDER_KEY]: dir ?? '' });
}

/** Ask for the folder the workspaces live in. Null when the user cancels. */
export async function pickWorkspaceFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: 'Choose the folder your workspaces live in',
    properties: ['openDirectory' as const, 'createDirectory' as const],
    ...(workspaceFolder() ? { defaultPath: workspaceFolder()! } : {}),
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0]!;
  setWorkspaceFolder(chosen);
  return chosen;
}

// -- reading the folder ------------------------------------------------------

/** The `.edb` files in a folder, by name, sorted. Directories are ignored. */
export function listWorkspaceFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(`.${WORKSPACE_EXTENSION}`))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return []; // the folder went away between the grant and the scan
  }
}

/**
 * The workspaces inside one file, with what each holds.
 *
 * Read-only and forgiving: anything that is not one of our files — a plain
 * SQLite database, a half-written copy, a `.edb` that is not ours at all —
 * answers an empty list rather than throwing. A scan runs over a folder the user
 * did not curate, so one bad file must not cost them the other nine.
 */
export function peekWorkspaceFile(file: string): FolderWorkspaceInfo[] {
  let db: DatabaseSyncType;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    // The format stamp first. Without it this is not our file, and the queries
    // below would either fail or read somebody else's table of the same name.
    const stamp = db.prepare(`SELECT doc FROM _easydb WHERE coll = '_meta' AND key = 'format'`).get() as { doc?: string } | undefined;
    if (!stamp?.doc) return [];

    const counts = new Map<string, { tables: number; views: number }>();
    const rows = db.prepare(`SELECT coll, workspaceId, COUNT(*) AS n FROM _easydb WHERE coll IN ('tables', 'viewInstances') GROUP BY coll, workspaceId`).all() as Array<{
      coll: string;
      workspaceId: string | null;
      n: number;
    }>;
    for (const r of rows) {
      if (!r.workspaceId) continue;
      const entry = counts.get(r.workspaceId) ?? { tables: 0, views: 0 };
      if (r.coll === 'tables') entry.tables = r.n;
      else entry.views = r.n;
      counts.set(r.workspaceId, entry);
    }

    const docs = db.prepare(`SELECT doc FROM _easydb WHERE coll = 'workspaces'`).all() as Array<{ doc: string }>;
    const out: FolderWorkspaceInfo[] = [];
    for (const row of docs) {
      let doc: { id?: unknown; name?: unknown; title?: unknown };
      try {
        doc = JSON.parse(row.doc) as typeof doc;
      } catch {
        continue; // one unreadable record, not a broken file
      }
      const id = typeof doc.id === 'string' ? doc.id : '';
      if (!id) continue;
      const counted = counts.get(id) ?? { tables: 0, views: 0 };
      out.push({
        id,
        name: typeof doc.name === 'string' && doc.name ? doc.name : id,
        ...(typeof doc.title === 'string' && doc.title ? { title: doc.title } : {}),
        tables: counted.tables,
        views: counted.views,
      });
    }
    return out;
  } catch {
    return []; // not one of our files after all
  } finally {
    db.close();
  }
}

/**
 * Everything the connected folder holds.
 *
 * `only` is the device's file selection. A file left out of it is **listed but
 * never opened** — the name comes from the directory entry, which costs nothing,
 * and the peek is the expensive half. That is the same rule the browser's scan
 * follows, and it is what makes switching a file off mean "leave it alone"
 * rather than "hide it".
 */
export function scanWorkspaceFolder(only?: readonly string[]): FolderScan | null {
  const dir = workspaceFolder();
  return dir ? scanFolderAt(dir, only) : null;
}

/**
 * The scan itself, against a folder named outright.
 *
 * Split from {@link scanWorkspaceFolder} so it can be tested: the remembered
 * folder is read through Electron's `app.getPath`, which does not exist outside
 * an Electron runtime, and the rule this implements — a file the device switched
 * off is listed but never opened — is the part worth holding down.
 */
export function scanFolderAt(dir: string, only?: readonly string[]): FolderScan {
  const wanted = only === undefined ? null : new Set(only.map((f) => f.toLowerCase()));
  const files: FolderFileInfo[] = [];
  for (const file of listWorkspaceFiles(dir)) {
    const full = path.join(dir, file);
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(full);
    } catch {
      continue; // it went away mid-scan
    }
    const read = wanted === null || wanted.has(file.toLowerCase());
    files.push({ file, size: stat.size, mtime: stat.mtimeMs, workspaces: read ? peekWorkspaceFile(full) : [] });
  }
  return { folder: path.basename(dir), folderPath: dir, at: Date.now(), files };
}

// -- making one --------------------------------------------------------------

/**
 * `name`, or `name (2)`, `name (3)`, … — the first `.edb` the folder does not
 * already hold. Case-insensitive, like every other name rule in this app.
 */
export function freeWorkspaceFileName(dir: string, stem: string): string {
  const taken = new Set(listWorkspaceFiles(dir).map((f) => f.toLowerCase()));
  const candidate = (n: number): string => (n === 1 ? `${stem}.${WORKSPACE_EXTENSION}` : `${stem} (${n}).${WORKSPACE_EXTENSION}`);
  for (let n = 1; ; n++) {
    const file = candidate(n);
    if (!taken.has(file.toLowerCase())) return file;
  }
}

/**
 * Write a new `.edb` in the folder holding one empty workspace.
 *
 * Opened and closed straight away: the caller switches the live store to it
 * afterwards, and two connections to one file while the first is still writing
 * is the state `copyDatabase` warns about.
 *
 * Returns the full path of the file it wrote.
 */
export function createWorkspaceFile(id: string, name: string): string | null {
  const dir = workspaceFolder();
  return dir ? createWorkspaceFileIn(dir, id, name) : null;
}

/** As {@link createWorkspaceFile}, against a folder named outright. Testable. */
export function createWorkspaceFileIn(dir: string, id: string, name: string): string {
  const file = path.join(dir, freeWorkspaceFileName(dir, id));
  const store = new SqliteStore({ path: file });
  try {
    store.insert('workspaces', { id, name, createdAt: Date.now(), pluginUrls: [] });
  } finally {
    store.checkpoint();
    store.close();
  }
  return file;
}

/** The full path of one file in the connected folder, or null when there is no folder. */
export function fileInWorkspaceFolder(file: string): string | null {
  const dir = workspaceFolder();
  return dir ? path.join(dir, path.basename(file)) : null;
}
