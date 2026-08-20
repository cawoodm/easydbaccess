// packages/renderer/src/db/edb/folder-sync.ts
//
// Reading the connected folder and rebuilding the workspace list from it.
//
// Runs on connect and on an explicit Sync, never on boot: every file has to be
// read whole to learn what workspaces it holds, and a folder of 600k-row
// workspaces is not something to pay for on every page load.

import type { DataStore, Dialogs, WorkspaceContents } from '@easydb/shared';
import { edbBridge, storeBridge } from './active-bridge.js';
import { countWorkspaceContents } from '../delete-workspace.js';
import { fileInFolder, listWorkspaceFiles } from './file-handle.js';
import { folderConflicts, isEmptyWorkspace, partitionConflicts, writeFolderIndex, type FolderIndex, type FolderWorkspace } from './folder-index.js';
import { clearStamp, factsOf, factsOfHandle, readStamp, verdictFor } from './file-stamp.js';
import { compareCopies, sizeChangeNote, type CopyFacts } from './copy-facts.js';
import { activeEdbName, adoptedFileName } from './session.js';
import { adoptFolderFile, reloadActiveFromFile } from './space-adopt.js';

/**
 * The two answers to one conflicting workspace. Compared by value.
 *
 * Both name **the disk version** — the copy the user cannot see — because that is
 * the one the answer turns on, and "Overwrite" alone never said what was being
 * overwritten. There is no explicit Cancel: `dialogs.choice` carries its own
 * dismiss, a dismissed dialog is neither of these, and neither branch runs — which
 * is exactly what Cancel meant.
 */
const LOAD = 'Load disk version';
const OVERWRITE = 'Overwrite disk version';

export interface SyncReport {
  files: number;
  /** Workspaces found across every file, including this tab's own. */
  found: number;
  /** Conflicts the user was asked about. */
  conflicts: number;
  /** Files that held no readable workspace record. */
  unreadable: string[];
  /**
   * This tab's own file was written by something else and has been re-read.
   *
   * The tab reloads when this is true, so nothing after the sync gets a chance to
   * report it — it is here for the tests, which cannot see a reload.
   */
  reloadedActive?: boolean;
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
    // The `File` object, not just the bytes: its size and last-modified time are
    // what the conflict prompts show about the copy the user cannot see, and they
    // come from the same read.
    const opened = handle ? await handle.getFile().catch(() => null) : null;
    const peeked = opened && bridge ? await bridge.peekWorkspaces(new Uint8Array(await opened.arrayBuffer())) : [];
    if (peeked.length === 0) {
      unreadable.push(file);
      continue;
    }
    for (const { doc, tables, views } of peeked) {
      const id = typeof doc['id'] === 'string' ? doc['id'] : '';
      if (!id) continue;
      workspaces.push({
        id,
        name: typeof doc['name'] === 'string' ? doc['name'] : id,
        title: typeof doc['title'] === 'string' ? doc['title'] : undefined,
        file,
        tables,
        views,
        ...(opened ? factsOf(opened) : {}),
      });
    }
  }

  return { index: { folder: dir.name, at: Date.now(), workspaces }, files, unreadable };
}

/**
 * What each clashing workspace holds ON THIS SIDE.
 *
 * Only the clashing ones are counted — the folder can hold hundreds and this is
 * a question about the handful that appear twice. Rows are not counted: a table
 * is enough to make a workspace non-empty, and the row total is a `COUNT(*)` per
 * table.
 *
 * Serves two callers at once. `partitionConflicts` asks which side is an empty
 * shell, and the prompt asks what to SAY about the local copy, so counting once
 * answers both. A store that cannot count leaves the map empty: every clash then
 * gets its prompt, and the prompt says nothing about this side — the behaviour
 * before either existed.
 */
async function localContents(clashes: readonly FolderWorkspace[]): Promise<Map<string, WorkspaceContents>> {
  const counts = new Map<string, WorkspaceContents>();
  try {
    const bridge = storeBridge();
    for (const clash of clashes) counts.set(clash.id, await countWorkspaceContents(bridge, clash.id, { countRows: false }));
  } catch {
    /* no bridge, or a build with no count — every clash gets its prompt */
  }
  return counts;
}

/** The ids whose local copy holds nothing the user put there. */
function emptyOnes(counts: ReadonlyMap<string, WorkspaceContents>): Set<string> {
  const empty = new Set<string>();
  for (const [id, c] of counts) if (isEmptyWorkspace(c)) empty.add(id);
  return empty;
}

/** What a counted workspace looks like to the prompt. A file has a size; this side has not. */
function contentsAsFacts(c: WorkspaceContents | undefined): CopyFacts {
  return c ? { tables: c.tables, views: c.views } : {};
}

/** What the copy inside a file looks like to the prompt, as the scan recorded it. */
function fileAsFacts(w: FolderWorkspace): CopyFacts {
  return { tables: w.tables, views: w.views, size: w.size, mtime: w.mtime };
}

/**
 * Everything the OPEN database holds, for the question about this tab's own file.
 *
 * That question is about the whole file rather than one workspace, so the answer
 * is a total: this file was the source of every workspace in here. The count is
 * best-effort — a store that cannot count still gets the workspace number, which
 * it knows without asking.
 */
async function openFileFacts(open: readonly { id: string }[]): Promise<CopyFacts> {
  try {
    const bridge = storeBridge();
    let tables = 0;
    let views = 0;
    for (const w of open) {
      const c = await countWorkspaceContents(bridge, w.id, { countRows: false });
      tables += c.tables;
      views += c.views;
    }
    return { workspaces: open.length, tables, views };
  } catch {
    return { workspaces: open.length };
  }
}

/** The same totals for one FILE, out of the scan that just ran. */
function fileTotals(index: FolderIndex, file: string): CopyFacts {
  const mine = index.workspaces.filter((w) => w.file === file);
  if (mine.length === 0) return {};
  return {
    workspaces: mine.length,
    tables: mine.reduce((n, w) => n + (w.tables ?? 0), 0),
    views: mine.reduce((n, w) => n + (w.views ?? 0), 0),
  };
}

/** "It was 96 KB when this tab last read it", when the size moved. */
function sinceWeRead(file: string, nowSize: number | undefined): string {
  return sizeChangeNote(readStamp(file)?.size, nowSize);
}

/**
 * Scan `dir`, settle any conflicts with the open database, and store the index.
 *
 * A conflict is one workspace id living both here and in a file. The user answers
 * per workspace, because the right answer is per workspace: a stale copy on disk
 * and a stale copy in the browser can both be in the same folder.
 *
 * Except when this side is empty. `?space=<name>` creates the workspace it cannot
 * find, and at boot it cannot look inside a folder nobody has connected yet, so
 * every private window that opens such a link has an empty shell of that name by
 * the time the folder arrives. Asking which of the two is real is a question
 * about nothing — the file is taken, unasked (`partitionConflicts`).
 *
 *  - **Load disk version** adopts that file and reloads. The data does not move;
 *    the tab changes which database it is looking at, so everything else in that
 *    file comes with it. This returns only if the file has gone since the scan.
 *  - **Overwrite disk version** writes the open workspace out over the file's copy
 *    of it, leaving the file's OTHER workspaces alone. Replacing the whole file
 *    would be the simpler read of "overwrite", and it would silently destroy
 *    workspaces the user never mentioned.
 *  - **Dismissing** leaves both. The index keeps the file's entry, so the selector
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
  const counted = await localContents(clashes);
  const { adopt, ask } = partitionConflicts(clashes, emptyOnes(counted));

  for (const clash of ask) {
    const sides = compareCopies([
      { label: 'In this browser', facts: contentsAsFacts(counted.get(clash.id)) },
      { label: clash.file, facts: fileAsFacts(clash) },
    ]);
    const answer = await dialogs.choice(
      `"${clash.name}" is in this browser and in ${clash.file}. The two may differ — which copy do you want to keep?${sides}`,
      [LOAD, OVERWRITE],
      'Sync workspace folder',
    );
    // A dismissed dialog keeps both, which is the safe answer and the only one
    // that touches nothing.
    if (answer === LOAD) await adoptFolderFile(clash.id);
    else if (answer === OVERWRITE) await overwrite(clash.id, clash.file);
  }

  // Last, because an adopt reloads the tab: doing this first would carry the
  // prompts above away mid-question. Only the first one can take effect for the
  // same reason, and that is enough — after the reload the other empty shells sit
  // in a database this tab no longer has open, so they clash with nothing.
  for (const empty of adopt) await adoptFolderFile(empty.id);

  const reloadedActive = await refreshActiveFile(dir, dialogs, overwrite, open, index);

  return { files: files.length, found: index.workspaces.length, conflicts: ask.length, unreadable, reloadedActive };
}

/**
 * Bring this tab's OWN file back in step with the copy on disk.
 *
 * The rest of a sync is about the workspace LIST — which file holds what — and it
 * skips the file this tab has open, because those workspaces are already here.
 * That left the one case a user means by "sync": three tabs on three origins, one
 * shared folder, and each tab looking at its own imported copy of the same `.edb`.
 * Everything except the folder is origin-scoped, so nothing told a tab that
 * another had written the file.
 *
 * Only for a file this tab ADOPTED. The built-in local database is this browser's
 * own, so a `local.edb` that happens to be in the folder is not the same object
 * and must not be imported over it.
 *
 * A file we have never agreed with (`unknown`) is left alone: with no stamp there
 * is no way to tell "someone else wrote this" from "we have never read it", and
 * guessing would throw away local work.
 */
async function refreshActiveFile(
  dir: FileSystemDirectoryHandle,
  dialogs: Dialogs,
  overwrite: (workspaceId: string, file: string) => Promise<void>,
  open: readonly { id: string }[],
  index: FolderIndex,
): Promise<boolean> {
  const file = adoptedFileName();
  if (!file) return false;
  const handle = await fileInFolder(dir, file, false);
  const verdict = await verdictFor(file, handle);
  if (verdict === 'file-newer') return reloadActiveFromFile(file);
  if (verdict !== 'conflict') return false;

  // Both sides moved on. The same answers as a list conflict, about the whole file
  // this time — every workspace in it came from those bytes.
  const now = handle ? await factsOfHandle(handle) : null;
  const sides = compareCopies([
    { label: 'Here', facts: await openFileFacts(open) },
    { label: file, facts: { ...fileTotals(index, file), ...(now ?? {}) } },
  ]);
  const answer = await dialogs.choice(
    `${file} has been written since this tab read it, and there are unsaved changes here. Which copy do you want to keep?${sides}${sinceWeRead(file, now?.size)}`,
    [LOAD, OVERWRITE],
    'Sync workspace folder',
  );
  if (answer === LOAD) return reloadActiveFromFile(file);
  if (answer === OVERWRITE) {
    // Per workspace, not the whole file: the newer copy on disk may hold
    // workspaces this tab has never seen, and they are not ours to drop.
    for (const w of open) await overwrite(w.id, file);
    // Our copy and the file no longer describe each other in any way we recorded.
    // `unknown` is the honest answer, and it means the next sync asks nothing.
    clearStamp(file);
  }
  return false;
}
