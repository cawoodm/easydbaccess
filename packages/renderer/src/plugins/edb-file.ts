import type { DataStore, HostApi, PluginModule } from '@easydb/shared';
import { AnchoredMenu } from '@cawoodm/lit-menu';
import {
  canPickFolder,
  canSaveInPlace,
  downloadBytes,
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
import { activeEdbName, lastEdbError, setActiveEdbName } from '../db/edb/session.js';
import { createAutosavePolicy } from '../db/edb/dirty.js';
import { edbBridge, edbHandle, setEdbHandle } from '../db/edb/active-bridge.js';
import { createEdbBridge } from '../db/edb/worker-bridge.js';
import { copyWorkspace } from '../db/edb/convert.js';
import { adoptEdbFile, buildEdbFile, chooseEdbTarget, workspaceFolder, type EdbTarget } from '../db/edb/new-file.js';

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

/** The two answers "New .edb file" offers. Compared by value, so they live here. */
const COPY_WORKSPACE = 'Copy this workspace into it';
const EMPTY_WORKSPACE = 'Start with an empty workspace';

/** The escape hatch in the Open list, for a file outside the workspace folder. */
const BROWSE = 'Another file…';

/** Only offer this where a worker can run. Electron has its own file operations. */
function supported(): boolean {
  return typeof Worker === 'function' && !window.easydb?.store;
}

export function init(api: HostApi): void {
  if (!supported()) return;

  /** Writes the database to the file the user chose. Returns false when it could not. */
  async function saveToHandle(): Promise<boolean> {
    const bridge = edbBridge();
    if (!bridge) return false;
    const bytes = await bridge.export();
    const handle = edbHandle();
    if (!handle) {
      // No file yet, or a browser with no picker: hand the bytes over instead of
      // silently doing nothing.
      downloadBytes(activeEdbName() ?? `workspace${EDB_EXTENSION}`, bytes);
      return true;
    }
    if (!(await ensureWritable(handle, true))) {
      await api.ui.dialogs.alert('easyDBAccess may not write that file. Use Save As to choose another.', 'Save');
      return false;
    }
    await writeBytes(handle, bytes);
    return true;
  }

  const autosave = createAutosavePolicy({
    save: async () => void (await saveToHandle()),
    onError: (err) => api.ui.dialogs.toast(`Autosave failed: ${String(err)}`, { kind: 'error' }),
  });

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
    if (await saveToHandle()) {
      autosave.markClean();
      api.ui.dialogs.toast('Workspace saved', { kind: 'success' });
    }
  }

  /** Change the folder. Existing files stay where they are. */
  async function chooseFolder(): Promise<void> {
    const picked = await pickFolder();
    if (!picked) return;
    await rememberFolder(picked);
    api.ui.dialogs.toast(`New workspace files go in "${picked.name}".`, { kind: 'success' });
  }

  async function saveAs(): Promise<void> {
    const target = await chooseEdbTarget(api.ui.dialogs, activeEdbName() ?? `workspace${EDB_EXTENSION}`);
    if (!target) return;
    setEdbHandle(target.handle);
    if (target.handle) await rememberHandle(target.handle);
    else await forgetHandle();
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
    location.reload();
  }

  /**
   * Put an opened file's bytes where the next boot will find them.
   *
   * The boot reads the OPFS mirror and never the user's file, because reading the
   * file needs a permission gesture no boot sequence has. So Open fills a
   * throwaway worker and forces its mirror out before it reloads.
   */
  async function seedFromBytes(name: string, bytes: Uint8Array): Promise<void> {
    const bridge = createEdbBridge();
    try {
      await bridge.open(bytes, name);
      await bridge.flush();
    } finally {
      bridge.terminate();
    }
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
    await seedFromBytes(picked.name, picked.bytes);
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
    if (!(await api.ui.dialogs.confirm('Go back to browser storage? The file stays where it is.', 'Local storage'))) return;
    await forgetHandle();
    setActiveEdbName(null);
    location.reload();
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
      const inFileMode = activeEdbName() !== null;
      const rect = ctx?.anchor?.getBoundingClientRect();
      if (!rect) return;
      const picked = await AnchoredMenu.open(rect, [
        { id: 'new', label: 'New .edb file…', icon: 'note_add' },
        { id: 'open', label: 'Open .edb file…', icon: 'folder_open' },
        ...(inFileMode
          ? [
              { id: 'save', label: canSaveInPlace() && edbHandle() ? 'Save' : 'Download a copy', icon: 'save' },
              { id: 'saveAs', label: 'Save As…', icon: 'save_as' },
              { id: 'autosave', label: `${autosave.enabled() ? 'Turn off' : 'Turn on'} autosave`, icon: 'autorenew' },
              { id: 'leave', label: 'Back to browser storage', icon: 'logout', danger: true },
            ]
          : []),
        ...(canPickFolder() ? [{ id: 'folder', label: 'Workspace folder…', icon: 'folder_special' }] : []),
      ]);
      if (picked === 'new') await newFile();
      else if (picked === 'open') await open();
      else if (picked === 'save') await save();
      else if (picked === 'saveAs') await saveAs();
      else if (picked === 'folder') await chooseFolder();
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

export async function load(api: HostApi): Promise<void> {
  if (!supported()) return;
  // A session that failed to start fell back to browser storage. Say so, or the
  // user is left wondering why their file is not open.
  const failure = lastEdbError();
  if (failure) {
    api.ui.dialogs.toast(`Could not open the workspace file, so browser storage is in use: ${String(failure)}`, { kind: 'error' });
    return;
  }
  if (activeEdbName() === null) return;
  // Re-check the folder before the file. A folder the user has allowed on every
  // visit covers everything in it, so Save then needs no prompt at all — and
  // asking about the folder once beats asking about each file.
  const folder = await rememberedFolder();
  if (folder) await ensureWritable(folder, false);
  // The handle from the last session. Permission is not asked for here: that
  // needs a gesture, and the workspace already loaded from the OPFS mirror.
  const remembered = await rememberedHandle();
  if (remembered) {
    setEdbHandle(remembered);
    await ensureWritable(remembered, false);
  }
  const on = await api.settings.get(meta.id, AUTOSAVE_KEY);
  if (on === true) api.ui.dialogs.toast('Autosave is on for this workspace file', { kind: 'info' });
}
