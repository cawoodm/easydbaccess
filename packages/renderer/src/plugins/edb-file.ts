import type { DataStore, HostApi, PluginModule } from '@easydb/shared';
import { AnchoredMenu } from '@marccawood/lit-menu';
import {
  canPickFolder,
  canSaveInPlace,
  ensureWritable,
  fileInFolder,
  forgetHandle,
  listWorkspaceFiles,
  pickFileToOpen,
  pickFolder,
  readBytes,
  rememberFolder,
  rememberHandle,
  rememberedFolder,
  rememberedHandle,
  writeBytes,
  EDB_EXTENSION,
} from '../db/edb/file-handle.js';
import { activeEdbName, adoptedFileName, reloadWithoutSpace, setActiveEdbName } from '../db/edb/session.js';
import { createAutosavePolicy } from '../db/edb/dirty.js';
import { edbBridge, edbHandle, setEdbHandle } from '../db/edb/active-bridge.js';
import { copyWorkspace } from '../db/edb/convert.js';
import { syncFolder } from '../db/edb/folder-sync.js';
import { createEdbBridge } from '../db/edb/worker-bridge.js';
import { createIpcDataStore } from '../db/data-store-bridge.js';
import { adoptEdbFile, buildEdbFile, chooseEdbTarget, placeForNextBoot, workspaceFolder, type EdbTarget } from '../db/edb/new-file.js';
import { adoptFolderFile, clearPendingSpaceRequest, pendingSpaceRequest } from '../db/edb/space-adopt.js';
import { spaceFileName } from '../db/edb/space-resolve.js';

/**
 * The `.edb` file surface in the browser: New, Open, Save, Save As, and the
 * autosave switch.
 *
 * A plugin, not core, because everything that can be a plugin in this app is
 * one. It registers nothing at all outside a browser that can host the worker,
 * so an Electron build — which has its own file operations in `electron-db` —
 * never shows two competing sets of buttons.
 */

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'edb-file',
  name: 'Workspace files (.edb)',
  type: 'source',
  version: '0.1.0',
  description: 'Keeps a workspace in a real SQLite .edb file that you Open and Save yourself.',
  author: 'Marc Cawood',
  // `meta.icon` is drawn with `unsafeHTML`, so it takes markup — NOT a Material
  // Icons ligature. The same drawing as `electron-db`, because the two are the
  // same idea on two platforms.
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/edb-file.ts',
};

const AUTOSAVE_KEY = 'autosave';

/**
 * The name the throwaway worker opens a file under while Overwrite rewrites it.
 * Not a real workspace file, and deliberately not any name a user could pick, so
 * its OPFS mirror cannot land on top of a database that matters.
 */
const SYNC_SCRATCH = '__edb-sync-scratch.edb';

/** The two answers "New .edb file" offers. Compared by value, so they live here. */
const COPY_WORKSPACE = 'Copy this workspace into it';
const EMPTY_WORKSPACE = 'Start with an empty workspace';

/** The escape hatch in the Open list, for a file outside the workspace folder. */
const BROWSE = 'Another file…';

/** The answers offered when a save has nowhere to go. Compared by value. */
const CHOOSE_FILE = 'Choose a file…';
const CONNECT_FOLDER = 'Connect a folder…';
const TURN_OFF_AUTOSAVE = 'Turn off autosave';

/**
 * Said when this browser cannot hand the app a file at all.
 *
 * The FileSystem Access API is Chromium-only, and with the IndexedDB dump gone
 * there is no second place a Save could put the bytes. The workspace is still
 * durable — it is a real database in the OPFS pool and it survives a reload —
 * so this is about PORTABILITY, and the message says which.
 */
const NO_FILE_ACCESS =
  'This browser cannot give easyDBAccess a file to write to, so this workspace cannot be saved to disk here. It is still stored in this browser and survives a reload. To keep a copy you can move, open this workspace in Chrome or Edge.';

/** Whether a Save could reach a file at all in this browser. */
function canReachAFile(): boolean {
  return canSaveInPlace() || canPickFolder();
}

/** Only offer this where a worker can run. Electron has its own file operations. */
function supported(): boolean {
  return typeof Worker === 'function' && !window.easydb?.store;
}

export function init(api: HostApi): void {
  if (!supported()) return;

  /**
   * Where a save landed.
   *
   * `no-handle` is not a failure — it is the one case the user can answer, and
   * the two callers answer it differently. See {@link save} and the autosave
   * policy below.
   */
  type SaveTarget = 'file' | 'no-handle' | 'none';

  /**
   * Write the database to the user's file.
   *
   * The ONLY durable copy this makes outside the browser. There is no
   * second, IndexedDB-held copy any more: the OPFS pool already survives a
   * reload, so a dump beside it was a second answer to a question already
   * answered, and it made "saved" mean two different things.
   *
   * Save does not hand over a download either. A save is about the workspace
   * surviving. Producing a file is a separate thing the user asks for
   * separately — Save As, or New .edb file.
   */
  async function persist(): Promise<SaveTarget> {
    const bridge = edbBridge();
    if (!bridge) return 'none';
    const handle = edbHandle();
    if (!handle) return 'no-handle';
    if (!(await ensureWritable(handle, true))) {
      await api.ui.dialogs.alert('easyDBAccess may not write that file. Use Save As to choose another.', 'Save');
      return 'none';
    }
    await writeBytes(handle, await bridge.export());
    return 'file';
  }

  const autosave = createAutosavePolicy({
    save: async () => {
      if ((await persist()) === 'no-handle') await autosaveHasNowhereToGo();
    },
    onError: (err) => api.ui.dialogs.toast(`Autosave failed: ${String(err)}`, { kind: 'error' }),
  });

  /**
   * A manual Save with no file behind it.
   *
   * There is no browser-side copy to fall back on any more, so the honest answer
   * is to ask where the file goes rather than to report a save that put the
   * bytes nowhere the user can reach. This runs from a click, so both pickers
   * have the user gesture they need.
   */
  async function askForSaveTarget(): Promise<void> {
    if (!canReachAFile()) {
      await api.ui.dialogs.alert(NO_FILE_ACCESS, 'Save');
      return;
    }
    const answer = await api.ui.dialogs.choice(
      'This workspace has no file yet, so there is nowhere to save it.',
      [...(canSaveInPlace() ? [CHOOSE_FILE] : []), ...(canPickFolder() ? [CONNECT_FOLDER] : [])],
      'Save',
    );
    if (answer === null) return;
    if (answer === CONNECT_FOLDER) {
      const picked = await pickFolder();
      if (!picked) return;
      // Remembered, but NOT scanned: the user asked to save, not to rebuild the
      // workspace list. `chooseEdbTarget` picks the name up from here.
      await rememberFolder(picked);
    }
    await saveAs();
  }

  /**
   * The same question, asked by the autosave timer instead of by a click.
   *
   * A timer has no user gesture, so this cannot open a picker directly — but the
   * dialog's own button is a gesture, which is what makes *Connect a folder*
   * work from here at all.
   *
   * Every other answer turns autosave OFF, including a dismissed dialog. A modal
   * that reopens on the next debounce tick is a trap, and the flag below closes
   * the remaining window where two ticks could both be waiting on an answer.
   */
  let askingAboutAutosave = false;
  async function autosaveHasNowhereToGo(): Promise<void> {
    if (askingAboutAutosave) return;
    askingAboutAutosave = true;
    try {
      const answer = await api.ui.dialogs.choice('Autosave has no file to write to.', [...(canPickFolder() ? [CONNECT_FOLDER] : []), TURN_OFF_AUTOSAVE], 'Autosave');
      if (answer === CONNECT_FOLDER && canPickFolder()) {
        const picked = await pickFolder();
        if (picked) {
          await rememberFolder(picked);
          await saveAs();
          return;
        }
      }
      autosave.setEnabled(false);
      await api.settings.set(meta.id, AUTOSAVE_KEY, false, 'user');
      api.ui.dialogs.toast('Autosave is off until this workspace has a file.', { kind: 'info' });
    } finally {
      askingAboutAutosave = false;
    }
  }

  // Every write the worker reports marks the file unsaved. This is the store's
  // own change broadcast, so nothing has to remember to announce itself.
  edbBridge()?.onChanged(() => autosave.changed());

  // The worker's own warnings — a failed crash-recovery mirror, above all.
  edbBridge()?.onWarning((message) => api.ui.dialogs.toast(message, { kind: 'warning' }));

  // An import is many calls, and each one would otherwise arm the timer. Holding
  // the batch open means one save at the end instead of one per chunk.
  api.events.on('import:before', () => autosave.beginBatch());
  api.events.on('import:after', () => autosave.endBatch());

  async function save(): Promise<void> {
    let where: SaveTarget;
    try {
      where = await persist();
    } catch (err) {
      // Not a toast: a message about a save that did not happen must not vanish
      // after seven seconds. Everything saved before this is still intact — the
      // workspace itself is in SQLite and was never in the way.
      await api.ui.dialogs.alert(`The workspace could not be saved: ${err instanceof Error ? err.message : String(err)}`, 'Save');
      return;
    }
    if (where === 'no-handle') {
      await askForSaveTarget();
      return;
    }
    if (where === 'none') return;
    autosave.markClean();
    api.ui.dialogs.toast('Workspace saved', { kind: 'success' });
  }

  /**
   * Write the open workspace out over the file's copy of it.
   *
   * The file's OTHER workspaces survive. Its bytes go into a throwaway worker,
   * that worker's copy of the workspace is dropped, the open one is copied in over
   * the top, and the result is written back. Replacing the whole file would be one
   * line and would destroy workspaces the user never mentioned.
   *
   * The throwaway runs on the MEMORY substrate, not the pool: the pool's files are
   * exclusive origin-wide and the live session already holds it, so a second
   * worker in this tab cannot install one. `buildEdbFile` relies on the same
   * thing. The scratch name keeps its mirror away from any real database's.
   */
  async function overwriteInFile(dir: FileSystemDirectoryHandle, workspaceId: string, file: string): Promise<void> {
    const handle = await fileInFolder(dir, file, false);
    if (!handle || !(await ensureWritable(handle, true))) {
      await api.ui.dialogs.alert(`easyDBAccess may not write ${file}.`, 'Sync workspace folder');
      return;
    }
    const scratch = createEdbBridge();
    try {
      await scratch.open(await readBytes(handle), SYNC_SCRATCH);
      await scratch.deleteWorkspace?.(workspaceId);
      await copyWorkspace(
        api.store,
        createIpcDataStore(scratch, () => workspaceId),
        workspaceId,
      );
      await writeBytes(handle, await scratch.export());
      api.ui.dialogs.toast(`Wrote this workspace over the copy in ${file}.`, { kind: 'success' });
    } finally {
      scratch.terminate();
    }
  }

  /**
   * Connect a folder and rebuild the workspace list from every `.edb` in it.
   *
   * Connecting IS the sync — a folder the app knows about but has not read is a
   * list that silently omits workspaces the user can see on disk.
   */
  async function chooseFolder(): Promise<void> {
    const picked = await pickFolder();
    if (!picked) return;
    await rememberFolder(picked);
    await syncFolderNow(picked);
  }

  /** Re-read the connected folder. Offered separately, because files change on disk. */
  async function syncConnectedFolder(): Promise<void> {
    const dir = await workspaceFolder();
    if (!dir) return;
    await syncFolderNow(dir);
  }

  async function syncFolderNow(dir: FileSystemDirectoryHandle): Promise<void> {
    const report = await syncFolder(dir, api.store, api.ui.dialogs, (id, file) => overwriteInFile(dir, id, file));
    const skipped = report.unreadable.length > 0 ? ` ${report.unreadable.length} file(s) held no workspace.` : '';
    api.ui.dialogs.toast(`"${dir.name}": ${report.found} workspace(s) in ${report.files} file(s).${skipped}`, { kind: 'success' });
    // The selector reads the index once, on connect, so it has to be told.
    window.dispatchEvent(new CustomEvent('easydb:folder-index-changed'));
  }

  async function saveAs(): Promise<void> {
    const target = await chooseEdbTarget(api.ui.dialogs, activeEdbName());
    if (!target) return;
    // A target with no handle means the browser could not give this app one, so
    // there is nothing to write to. Saying so ENDS the flow. Calling `save()`
    // here would find no handle, ask where to save, and arrive back at this same
    // answer — a loop with a dialog in it.
    if (!target.handle) {
      await api.ui.dialogs.alert(NO_FILE_ACCESS, 'Save As');
      return;
    }
    setEdbHandle(target.handle);
    await rememberHandle(target.handle);
    setActiveEdbName(target.name);
    await save();
  }

  /**
   * Make this tab use `name` from the next load on, and reload.
   *
   * The store is built once per load, so adopting another file is a reload — the
   * same thing the desktop does when it opens another database.
   */
  async function adopt(target: EdbTarget, message: string): Promise<void> {
    await adoptEdbFile(target);
    await api.ui.dialogs.alert(message, 'Workspace file');
    reloadWithoutSpace();
  }

  /** Copy this workspace into a new file's store, and say what travelled. */
  async function copyInto(store: DataStore, workspaceId: string): Promise<void> {
    const result = await copyWorkspace(api.store, store, workspaceId);
    if (result.skipped.length > 0) {
      // A source-backed table reads its rows from a server on every load, so only
      // its definition travels. Saying so beats a file that looks short.
      api.ui.dialogs.toast(`These tables read their rows from a server, so only their settings were copied: ${result.skipped.join(', ')}.`, { kind: 'warning' });
    }
    api.ui.dialogs.toast(`Copied ${result.tables} table${result.tables === 1 ? '' : 's'} and ${result.rows} row${result.rows === 1 ? '' : 's'}.`, { kind: 'success' });
  }

  /**
   * Open a workspace file.
   *
   * The folder is listed first, so the ordinary case is picking a name out of a
   * list this app already has permission to read. The OS dialog is only reached
   * by asking for it, or where there is no folder.
   */
  async function open(): Promise<void> {
    const dir = await workspaceFolder();
    let picked: { name: string; bytes: Uint8Array; handle: FileSystemFileHandle | null } | null = null;
    if (dir) {
      const files = await listWorkspaceFiles(dir);
      if (files.length > 0) {
        const answer = await api.ui.dialogs.choice(`Workspace files in "${dir.name}"`, [...files, BROWSE], 'Open workspace');
        if (answer === null) return;
        if (answer !== BROWSE) {
          const handle = await fileInFolder(dir, answer, false);
          if (handle) picked = { name: answer, bytes: await readBytes(handle), handle };
        }
      }
    }
    picked ??= await pickFileToOpen();
    if (!picked) return;
    // The boot never reads the user's file (see `session.ts`), so the bytes go
    // into this tab's own substrate first, and the reload finds them there.
    await placeForNextBoot(picked.name, picked.bytes);
    await adopt({ name: picked.name, handle: picked.handle }, `Opening "${picked.name}". The page will reload.`);
  }

  /**
   * Start a new file, either empty or holding a copy of the open workspace.
   *
   * Converting never touches the source. A user who copies a workspace into a
   * file and then goes back to browser storage still finds everything there.
   */
  async function newFile(): Promise<void> {
    const workspaceId = api.workspaceId();
    // Only reachable before boot resolves a workspace, which the menu is not. The
    // guard is here because the file has to be NAMED after something.
    if (!workspaceId) return;
    const answer = await api.ui.dialogs.choice(`What goes into the new file?`, [COPY_WORKSPACE, EMPTY_WORKSPACE], 'New .edb file');
    if (answer === null) return;
    const copy = answer === COPY_WORKSPACE;

    // Chosen FIRST, while the click that answered the question above still counts
    // as a user gesture. Both the folder picker and the file picker need one, and
    // a long copy in between would spend it.
    const target = await chooseEdbTarget(api.ui.dialogs, `${workspaceId}${EDB_EXTENSION}`);
    if (!target) return;

    await buildEdbFile(target, workspaceId, copy ? (store) => copyInto(store, workspaceId) : undefined);
    await adopt(target, `"${target.name}" is now this tab's workspace file. The page will reload.`);
  }

  async function leaveFileMode(): Promise<void> {
    if (!(await api.ui.dialogs.confirm('Go back to this browser\u2019s own database? The file stays where it is.', 'Local database'))) return;
    await forgetHandle();
    setActiveEdbName(null);
    reloadWithoutSpace();
  }

  api.ui.registerFooterButton({
    id: 'edb-file:menu',
    label: 'File',
    // `storage`, not `database`: the Material Icons font has no `database`
    // ligature, so it drew the literal word. Same icon as `electron-db`'s
    // button, which does the same job on the desktop.
    icon: 'storage',
    tooltip: 'Workspace file — open, save, autosave',
    onClick: async (_api, ctx) => {
      const inFileMode = adoptedFileName() !== null;
      const rect = ctx?.anchor?.getBoundingClientRect();
      if (!rect) return;
      const picked = await AnchoredMenu.open(rect, [
        { id: 'new', label: 'New .edb file…', icon: 'note_add' },
        { id: 'open', label: 'Open .edb file…', icon: 'folder_open' },
        ...(inFileMode
          ? [
              { id: 'save', label: 'Save', icon: 'save' },
              { id: 'saveAs', label: 'Save As…', icon: 'save_as' },
              { id: 'autosave', label: `${autosave.enabled() ? 'Turn off' : 'Turn on'} autosave`, icon: 'autorenew' },
              { id: 'leave', label: 'Back to browser storage', icon: 'logout', danger: true },
            ]
          : []),
        ...(canPickFolder() ? [{ id: 'folder', label: 'Workspace folder…', icon: 'folder_special' }] : []),
        ...(canPickFolder() ? [{ id: 'syncFolder', label: 'Sync workspace folder', icon: 'sync' }] : []),
      ]);
      if (picked === 'new') await newFile();
      else if (picked === 'open') await open();
      else if (picked === 'save') await save();
      else if (picked === 'saveAs') await saveAs();
      else if (picked === 'folder') await chooseFolder();
      else if (picked === 'syncFolder') await syncConnectedFolder();
      else if (picked === 'leave') await leaveFileMode();
      else if (picked === 'autosave') {
        const next = !autosave.enabled();
        autosave.setEnabled(next);
        await api.settings.set(meta.id, AUTOSAVE_KEY, next, 'user');
        api.ui.dialogs.toast(`Autosave ${next ? 'on' : 'off'}`, { kind: 'info' });
      }
    },
  });
}

/** Marks the one-time notice below as shown, so it never nags. */
const DEXIE_NOTICE_KEY = 'easydb:legacy-idb-notice';

/**
 * Tell a returning user that their old data is not being read.
 *
 * Before the SQLite flip the browser kept workspaces in an IndexedDB database
 * called `easydb`. That database is no longer opened, and it is NOT migrated —
 * a deliberate call, the same one made for `.edb` format v1. From the user's
 * side an unannounced switch is indistinguishable from the app having lost
 * everything, so it gets said once.
 *
 * Nothing is deleted here. The old database still exists, which is what leaves
 * the door open to reinstalling an older build and exporting from it.
 */
async function noticeOrphanedBrowserData(api: HostApi): Promise<void> {
  try {
    if (globalThis.localStorage?.getItem(DEXIE_NOTICE_KEY)) return;
    // `databases()` is absent on Firefox, where there is no way to ask without
    // opening the database and thereby creating it. Staying quiet is better than
    // warning everybody on the off chance.
    const list = await indexedDB.databases?.();
    if (!list?.some((d) => d.name === 'easydb')) return;
    globalThis.localStorage?.setItem(DEXIE_NOTICE_KEY, '1');
    await api.ui.dialogs.alert(
      'This version keeps your workspaces in a SQLite database instead of the browser storage earlier versions used.\n\n' +
        'Data from before the change is not carried over and is not shown here. It has not been deleted \u2014 it is still in this browser, so an older build can still open and export it.',
      'Storage has changed',
    );
  } catch {
    /* A notice is not worth failing a boot over. */
  }
}

/**
 * `?space=NAME` named a workspace this browser does not hold, and telling whether
 * `NAME.edb` is in the user's folder needs a permission grant.
 *
 * Asked HERE, not during boot: `requestPermission` resolves only from a user
 * gesture, and this dialog's button is the first gesture the page gets. Boot has
 * already created the workspace under that name, so declining leaves a working
 * app rather than a dead end.
 */
async function offerSpaceFolder(api: HostApi): Promise<void> {
  const requested = pendingSpaceRequest();
  if (requested === null) return;
  // Cleared before the awaits: a second `load()` (the Plugin Manager re-emits
  // `app:ready` on a hot install) must not ask the same question again.
  clearPendingSpaceRequest();
  const file = spaceFileName(requested);
  const ok = await api.ui.dialogs.confirm(`"${requested}" is not in this browser. Look for ${file} in your workspace folder?`, 'Open workspace');
  if (!ok) return;
  const dir = await workspaceFolder();
  if (!dir) return;
  if (!(await listWorkspaceFiles(dir)).includes(file)) {
    api.ui.dialogs.toast(`There is no ${file} in "${dir.name}".`, { kind: 'info' });
    return;
  }
  // Reloads on success. A stale listing is the only way this returns.
  await adoptFolderFile(requested);
}

export async function load(api: HostApi): Promise<void> {
  if (!supported()) return;
  await offerSpaceFolder(api);
  await noticeOrphanedBrowserData(api);
  // Everything below is about the user's own FILE. The local database needs no
  // handle and no permission, so a tab that has not adopted a file is done here.
  if (adoptedFileName() === null) return;
  // Re-check the folder before the file. A folder the user has allowed on every
  // visit covers everything in it, so Save then needs no prompt at all — and
  // asking about the folder once beats asking about each file.
  const folder = await rememberedFolder();
  if (folder) await ensureWritable(folder, false);
  // The handle from the last session. Permission is READ, not asked for: asking
  // needs a gesture, and the workspace already loaded from the OPFS mirror. A
  // Chrome user with a persisted grant reads back `granted` and saves silently.
  const remembered = await rememberedHandle();
  if (remembered) {
    setEdbHandle(remembered);
    await ensureWritable(remembered, false);
  }
  const on = await api.settings.get(meta.id, AUTOSAVE_KEY);
  if (on === true) api.ui.dialogs.toast('Autosave is on for this workspace file', { kind: 'info' });
}
