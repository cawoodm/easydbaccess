// packages/renderer/src/plugins/electron-folder.ts
//
// The workspace folder on the desktop.
//
// **Nothing here is a new feature.** The browser has had Connect ▸ Local Data
// since v0.0.404: connect a folder, see every `.edb` in it, tick which of them
// this device uses, and switch between them from the header selector. This is
// the same feature reaching the same dialog, the same selector and the same
// palette group through the main process instead of through a
// `FileSystemDirectoryHandle`. A user who moves between the two builds is meant
// to notice nothing.
//
// What makes it small is `db/edb/folder-index.ts`. The selector does not read a
// folder — it reads a device-local CACHE of one, in `localStorage`, which is
// plain data. So the whole job is: scan the folder in the main process, write
// that cache, and answer two questions the browser answers its own way (which
// file is open, and how another one is opened). The second pair goes through
// `db/file-workspaces.ts`.
//
// Split out of `electron-db.ts` because that file is already long and this is a
// separate subject: that one is about ONE file the user points at, this one is
// about the folder they all live in.

import type { HostApi } from '@easydb/shared';
import type { EasydbDbBridge, EasydbFolderScan } from '../db/data-store-bridge.js';
import { clearFolderIndex, readFolderSelection, writeFolderIndex, type FolderWorkspace } from '../db/edb/folder-index.js';
import { setBackendActiveFile, setFileWorkspaceBackend } from '../db/file-workspaces.js';
import type { LocalDataActions } from '../dialogs/local-data-dialog.js';

/** The palette group these commands appear under — the same word `edb-file.ts` uses. */
const FILE_GROUP = 'File';

/** What the desktop says in place of the browser's "this browser grants one file" note. */
const OPEN_FILE_HINT = 'The file is opened where it is. It does not have to be in the folder, and nothing is copied.';

/**
 * Does this build's bridge know about folders?
 *
 * A renderer can outlive its preload — a desktop build from before v0.0.491 has
 * every other `db:*` method and none of these. Checking here is what makes that
 * show no folder UI instead of a folder UI that throws on the first click.
 */
export function folderSupported(bridge: EasydbDbBridge): boolean {
  return typeof bridge.scanFolder === 'function' && typeof bridge.folderFilePath === 'function';
}

/** The file name out of a path. Splits on either separator — the path comes from the OS. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) || path : path;
}

/**
 * A main-process scan, as the index the workspace selector reads.
 *
 * Pure, and exported for its own test: this is the one piece of translation
 * between the two halves, and every field it drops is a thing the selector or
 * the Local Data dialog then cannot show.
 *
 * `size` and `mtime` belong to the FILE, so each workspace in a file repeats its
 * file's pair. That is what `FolderWorkspace` expects — the conflict prompts
 * compare a workspace against a file, not against another workspace.
 */
export function indexFromScan(scan: EasydbFolderScan): { folder: string; at: number; files: string[]; workspaces: FolderWorkspace[] } {
  const workspaces: FolderWorkspace[] = [];
  for (const f of scan.files) {
    for (const w of f.workspaces) {
      workspaces.push({
        id: w.id,
        name: w.name,
        ...(w.title === undefined ? {} : { title: w.title }),
        file: f.file,
        tables: w.tables,
        views: w.views,
        size: f.size,
        mtime: f.mtime,
      });
    }
  }
  return { folder: scan.folder, at: scan.at, files: scan.files.map((f) => f.file), workspaces };
}

/**
 * The files the main process may OPEN during a scan.
 *
 * `undefined` means every one of them, which is what the default selection says.
 * Otherwise it is the ticked list plus whatever this window has open — a file
 * cannot be switched off while you are looking at it, and the dialog shows that
 * row disabled for the same reason.
 *
 * A file left out is still listed. Only the peek is skipped, which is the
 * expensive half and the only half that opens anything.
 */
export function filesToRead(selection: { all: boolean; files: string[] }, openFile: string | null): string[] | undefined {
  if (selection.all) return undefined;
  const wanted = new Set(selection.files);
  if (openFile) wanted.add(openFile);
  return [...wanted];
}

/** Tell everything that reads the index to read it again. */
function announce(): void {
  window.dispatchEvent(new CustomEvent('easydb:folder-index-changed'));
}

/** What `electron-db.ts` gets back, so its `load()` can start the boot scan. */
export interface WorkspaceFolderSession {
  /** Learn which file is open, refresh the command titles, read the folder. */
  boot(): Promise<void>;
}

/**
 * Wire the folder into this window: the backend, the open file's name, the
 * Local Data connector and the File commands.
 *
 * Called from `electron-db.ts`'s `init`. Null where the bridge is too old to
 * help, and the caller then registers no folder UI at all.
 *
 * `openSingleFile` is the caller's Open-one-file flow. It lives there because it
 * ends in the same three-way question a dropped file gets, which is that
 * module's subject.
 */
export function installWorkspaceFolder(api: HostApi, bridge: EasydbDbBridge, openSingleFile: () => Promise<void>): WorkspaceFolderSession | null {
  if (!folderSupported(bridge)) return null;

  /** The name of the file this window has open, once the main process has said. */
  let openFile: string | null = null;

  async function learnOpenFile(): Promise<void> {
    try {
      const info = await bridge.currentDb();
      openFile = baseName(info.path);
      setBackendActiveFile(openFile);
    } catch {
      /* the selector falls back to the browser's marker, which reads as "no file" */
    }
  }

  /**
   * Read the folder and rewrite the index.
   *
   * Quiet by default. It runs at boot, and a toast on every launch saying how
   * many files were found is a notification about nothing having changed.
   */
  async function rescan(opts: { announceResult?: boolean } = {}): Promise<void> {
    const scan = await bridge.scanFolder?.(filesToRead(readFolderSelection(), openFile));
    if (!scan) {
      clearFolderIndex();
      announce();
      if (opts.announceResult) api.ui.dialogs.toast('No workspace folder is connected yet.', { kind: 'info', title: 'Local Data' });
      return;
    }
    writeFolderIndex(indexFromScan(scan));
    announce();
    if (!opts.announceResult) return;
    const n = scan.files.length;
    api.ui.dialogs.toast(`${scan.folder}: ${n} workspace file${n === 1 ? '' : 's'}.`, { kind: 'success', title: 'Local Data' });
  }

  async function chooseFolder(): Promise<void> {
    const picked = await bridge.pickFolder?.();
    if (!picked) return; // cancelled in the OS dialog
    // Connecting IS the scan. A folder the app knows about but has not read is a
    // workspace list that silently omits files the user can see on disk.
    await rescan({ announceResult: true });
    await refreshFolderCommand();
  }

  async function disconnectFolder(): Promise<void> {
    if (!(await bridge.folder?.())) return;
    if (!(await api.ui.dialogs.confirm('Stop using this folder? Every file in it stays where it is — this app just forgets where to look.', 'Local Data'))) return;
    await bridge.forgetFolder?.();
    clearFolderIndex();
    announce();
    await refreshFolderCommand();
    api.ui.dialogs.toast('Folder disconnected. The files are untouched.', { kind: 'info', title: 'Local Data' });
  }

  /**
   * Switch this window to another file in the folder.
   *
   * No confirmation, and that is deliberate: the desktop writes every change
   * straight to its file, so there is never unsaved work to lose by switching.
   * The browser does not confirm either — it only asks when the same workspace
   * exists on both sides, which cannot happen here because one file is one
   * store.
   */
  async function openFileNamed(file: string): Promise<'opened' | 'unavailable'> {
    const path = await bridge.folderFilePath?.(file);
    if (!path) return 'unavailable';
    // The index is a cache, and the file may have been moved, replaced or
    // truncated since the scan. Opening a file that is not ours would add our
    // bookkeeping table to it and then show an empty workspace.
    if ((await bridge.probeDb(path)) !== 'easydb') return 'unavailable';
    await bridge.openDbCommit(path);
    return 'opened'; // the main process reloads this window; nothing after runs
  }

  setFileWorkspaceBackend({
    open: (file) => openFileNamed(file),
    // True whenever a folder CAN be connected, not only when one is: otherwise
    // the New workspace question hides the answer that would have led the user
    // to connect one, and the feature is only findable by someone who already
    // uses it.
    canCreate: async () => folderSupported(bridge),
    create: async (name, id) => {
      if (!(await bridge.folder?.())) {
        const picked = await bridge.pickFolder?.();
        if (!picked) return false;
      }
      const path = await bridge.newWorkspaceFile?.(id, name);
      if (!path) {
        await api.ui.dialogs.alert(`"${name}" could not be given a file of its own. Check the folder under Connect ▸ Local Data.`, 'New workspace');
        return false;
      }
      await api.ui.dialogs.alert(`"${name}" now lives in ${baseName(path)}. The window will reload.`, 'New workspace');
      await bridge.openDbCommit(path);
      return true;
    },
  });

  // The palette title says what the command will do, so it follows the state —
  // the same pattern, and the same two words, as `edb-file.ts`.
  const folderCommand = {
    id: 'workspace-folder:choose',
    title: 'Connect workspace folder…',
    group: FILE_GROUP,
    icon: 'folder_special',
    keywords: ['change', 'connect', 'directory', 'file', 'local'],
    run: () => chooseFolder(),
  };

  async function refreshFolderCommand(): Promise<void> {
    folderCommand.title = (await bridge.folder?.()) ? 'Change workspace folder…' : 'Connect workspace folder…';
  }

  api.ui.registerCommand(folderCommand);

  api.ui.registerCommand({
    id: 'workspace-folder:sync',
    title: 'Sync workspace folder',
    group: FILE_GROUP,
    icon: 'sync',
    keywords: ['rescan', 'refresh', 'reread', 'folder'],
    run: () => rescan({ announceResult: true }),
  });

  // The "Local Data" half of the Connect menu — the SAME id, label, icon and
  // order the browser registers, so the menu is identical in both builds and
  // `connect-menu.ts` needs to know about neither.
  api.ui.registerConnector({
    id: 'workspace-folder',
    scope: 'local',
    label: 'Local Data',
    icon: 'folder',
    order: 10,
    description: 'The folder your workspaces live in, and which files in it this device uses.',
    // Imported on the click, not at module scope. The dialog defines a custom
    // element when it loads, which needs a DOM — and the pure helpers above are
    // unit-tested under plain Node, where there is none.
    connect: async () => {
      const { openLocalDataDialog } = await import('../dialogs/local-data-dialog.js');
      openLocalDataDialog(localDataActions);
    },
  });

  const localDataActions: LocalDataActions = {
    chooseFolder,
    disconnectFolder,
    rescan: () => rescan({ announceResult: true }),
    // `openSingleFile` is the caller's — `electron-db.ts` owns the one-file Open
    // flow, including its question about a file that turns out not to be a
    // workspace. Read on the click, never at registration.
    openFile: () => openSingleFile(),
    canConnectFolder: () => true,
    openFileHint: OPEN_FILE_HINT,
  };

  return {
    boot: async () => {
      await learnOpenFile();
      await refreshFolderCommand();
      // Files change on disk between launches, so a cached index is a guess. The
      // scan is cheap — it reads each file's metadata table, never its rows.
      await rescan();
    },
  };
}
