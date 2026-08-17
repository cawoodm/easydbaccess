// packages/renderer/src/db/edb/folder-sync.ts
//
// Reading the connected folder and rebuilding the workspace list from it.
//
// Runs on connect and on an explicit Sync, never on boot: every file has to be
// read whole to learn what workspaces it holds, and a folder of 600k-row
// workspaces is not something to pay for on every page load.

import type { DataStore, Dialogs } from '@easydb/shared';
import { edbBridge } from './active-bridge.js';
import { fileInFolder, listWorkspaceFiles, readBytes } from './file-handle.js';
import { folderConflicts, writeFolderIndex, type FolderIndex, type FolderWorkspace } from './folder-index.js';
import { activeEdbName } from './session.js';
import { adoptFolderFile } from './space-adopt.js';

/** The three answers to one conflicting workspace. Compared by value. */
const LOAD = 'Load from Disk';
const OVERWRITE = 'Overwrite';
const CANCEL = 'Cancel';

export interface SyncReport {
  files: number;
  /** Workspaces found across every file, including this tab's own. */
  found: number;
  /** Conflicts the user was asked about. */
  conflicts: number;
  /** Files that held no readable workspace record. */
  unreadable: string[];
}

/**
 * Read every `.edb` in `dir` and record what workspaces they hold.
 *
 * One file at a time rather than in parallel: the reads go through the single
 * worker, and holding several whole databases in its memory at once is the one
 * way this becomes a problem on a big folder.
 */
export async function scanFolder(dir: FileSystemDirectoryHandle): Promise<{ index: FolderIndex; files: string[]; unreadable: string[] }> {
  const bridge = edbBridge();
  const files = await listWorkspaceFiles(dir);
  const workspaces: FolderWorkspace[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    const handle = await fileInFolder(dir, file, false);
    const docs = handle && bridge ? await bridge.peekWorkspaces(await readBytes(handle)) : [];
    if (docs.length === 0) {
      unreadable.push(file);
      continue;
    }
    for (const doc of docs) {
      const id = typeof doc.id === 'string' ? doc.id : '';
      if (!id) continue;
      workspaces.push({
        id,
        name: typeof doc.name === 'string' ? doc.name : id,
        title: typeof doc.title === 'string' ? doc.title : undefined,
        file,
      });
    }
  }

  return { index: { folder: dir.name, at: Date.now(), workspaces }, files, unreadable };
}

/**
 * Scan `dir`, settle any conflicts with the open database, and store the index.
 *
 * A conflict is one workspace id living both here and in a file. The user answers
 * per workspace, because the right answer is per workspace: a stale copy on disk
 * and a stale copy in the browser can both be in the same folder.
 *
 *  - **Load from Disk** adopts that file and reloads. The data does not move; the
 *    tab changes which database it is looking at, so everything else in that file
 *    comes with it. This returns only if the file has gone since the scan.
 *  - **Overwrite** writes the open workspace out over the file's copy of it,
 *    leaving the file's OTHER workspaces alone. Replacing the whole file would be
 *    the simpler read of "overwrite", and it would silently destroy workspaces the
 *    user never mentioned.
 *  - **Cancel** leaves both. The index keeps the file's entry, so the selector
 *    shows the pair with the file name telling them apart.
 *
 * The index is written BEFORE the prompts, so a user who dismisses them still gets
 * the merged list they asked for.
 */
export async function syncFolder(dir: FileSystemDirectoryHandle, store: DataStore, dialogs: Dialogs, overwrite: (workspaceId: string, file: string) => Promise<void>): Promise<SyncReport> {
  const { index, files, unreadable } = await scanFolder(dir);
  writeFolderIndex(index);

  const open = await store.workspaces.find();
  const clashes = folderConflicts(open, index.workspaces, activeEdbName());

  for (const clash of clashes) {
    const answer = await dialogs.choice(`"${clash.name}" is in this browser and in ${clash.file}. Which one is the real one?`, [LOAD, OVERWRITE, CANCEL], 'Sync workspace folder');
    // A dismissed dialog is Cancel — the safe answer, and the only one that
    // touches nothing.
    if (answer === LOAD) await adoptFolderFile(clash.id);
    else if (answer === OVERWRITE) await overwrite(clash.id, clash.file);
  }

  return { files: files.length, found: index.workspaces.length, conflicts: clashes.length, unreadable };
}
