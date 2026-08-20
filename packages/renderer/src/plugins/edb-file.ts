import type { ButtonSpec, CommandSpec, HostApi, PluginModule } from '@easydb/shared';
import {
  EDB_EXTENSION,
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
} from '../db/edb/file-handle.js';
import { activeEdbName, adoptedFileName, reloadWithoutSpace, reloadWithSpace, setActiveEdbName } from '../db/edb/session.js';
import { factsOfHandle, markLocalChanges, recordAgreement } from '../db/edb/file-stamp.js';
import { clearAppProgress, setAppProgress } from '../chrome/app-progress-signal.js';
import { cloneWorkspace } from '../db/clone-workspace.js';
import { deleteWorkspace } from '../db/delete-workspace.js';
import { createAutosavePolicy, type AutosavePolicy } from '../db/edb/dirty.js';
import { edbBridge, edbHandle, setEdbHandle, storeBridge } from '../db/edb/active-bridge.js';
import { copyWorkspace } from '../db/edb/convert.js';
import { syncFolder } from '../db/edb/folder-sync.js';
import { createEdbBridge } from '../db/edb/worker-bridge.js';
import type { PeekedWorkspace } from '../db/edb/protocol.js';
import { compareCopies } from '../db/edb/copy-facts.js';
import { countWorkspaceContents } from '../db/delete-workspace.js';
import { createIpcDataStore } from '../db/data-store-bridge.js';
import { adoptEdbFile, placeForNextBoot, workspaceFolder, type EdbTarget } from '../db/edb/new-file.js';
import { adoptFolderFile, clearPendingSpaceRequest, pendingSpaceRequest } from '../db/edb/space-adopt.js';
import { freeWorkspaceId, spaceFileName, workspaceIdFromFileName } from '../db/edb/space-resolve.js';

/**
 * The `.edb` file surface in the browser: Open, Save, the autosave switch and the
 * workspace folder.
 *
 * **These are palette commands, not a menu.** They sat behind a "File" footer
 * button until v0.0.402, which was a second navigation model for five items the
 * palette already indexed — and every other footer button belongs to the workspace
 * (Views, Import, Export), so a global File menu was in the wrong place besides.
 * Ctrl+K and a word is the whole interaction now. The header's Save button stays,
 * because Save is the one of these done often enough to want a mouse target, and
 * because the unsaved dot has to live somewhere always visible.
 *
 * Save and autosave are offered whether or not this workspace has a file yet. They
 * used to appear only once one had been adopted, which read as "this app cannot
 * save" to anyone who had connected a folder and never opened a file — the one
 * state in which saving is both possible and not yet done.
 *
 * TWO items are deliberately absent, and both were removed because something else
 * already did the job:
 *
 * - **New .edb file** — New workspace → Advanced creates a workspace in its own
 *   file (`chrome/workspace-actions.ts`).
 * - **Save As** — it existed to write the workspace somewhere else under another
 *   name, which is now the one thing that MUST not happen: a file's name is the
 *   workspace inside it (`spaceFileName` / `workspaceIdFromFileName`), so
 *   `sales.edb` holding the workspace `q3` is a file Open cannot make sense of. A
 *   copy comes from New workspace → "Clone everything" and then Save, which writes
 *   the clone under its own name.
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
 * The palette group these commands appear under.
 *
 * "File" because that is the word the user came looking for, and because the
 * palette buckets by group heading rather than by which plugin registered what.
 */
const FILE_GROUP = 'File';

/**
 * What `load()` needs out of `init()`'s closure.
 *
 * `load` is a separate export and cannot see the autosave policy, which is why the
 * stored autosave flag used to be read at boot and then only toasted about, never
 * applied — autosave did not actually resume after a reload, while the menu said
 * "Turn on autosave" as if it had never been on.
 */
let session: { autosave: AutosavePolicy; refreshSaveButton: () => void; refreshFileCommands: () => Promise<void> } | null = null;

/**
 * The name the throwaway worker opens a file under while Overwrite rewrites it.
 * Not a real workspace file, and deliberately not any name a user could pick, so
 * its OPFS mirror cannot land on top of a database that matters.
 */
const SYNC_SCRATCH = '__edb-sync-scratch.edb';

/** The escape hatch in the Open list, for a file outside the workspace folder. */
const BROWSE = 'Another file…';

/** The name the throwaway worker opens a DROPPED file under. Never a real file. */
const DROP_SCRATCH = '__edb-drop-scratch.edb';

/** The two ways a dropped file can meet a workspace of the same name. */
const OVERWRITE_LOCAL = 'Replace the one here';
const KEEP_BOTH = 'Keep both, under a new name';

/** As much of a workspace record as a dropped file is asked for. */
interface WorkspaceDoc {
  id: string;
  name: string;
  /** What that workspace holds inside the file — for the replace-or-keep-both question. */
  tables: number;
  views: number;
}

/**
 * The workspace records in a peeked file, as ids, names and sizes.
 *
 * `peekWorkspaces` answers raw documents, and a file may have been written by
 * anything: a record with no usable id is dropped rather than trusted.
 */
function workspaceDocs(raw: readonly PeekedWorkspace[]): WorkspaceDoc[] {
  return raw.map((w) => ({ id: String(w.doc['id'] ?? ''), name: String(w.doc['name'] ?? w.doc['id'] ?? ''), tables: w.tables, views: w.views })).filter((w) => w.id !== '');
}

/**
 * The files a drop hands over.
 *
 * `dataTransfer.files` is the ordinary answer; `items` is the fallback some
 * browsers give for a drag that started inside the page. Each importer carries its
 * own copy of this — a five-line reader is not worth a shared module that every
 * plugin then depends on.
 */
function filesFrom(event: DragEvent): File[] {
  const dt = event.dataTransfer;
  if (!dt) return [];
  if (dt.files && dt.files.length > 0) return Array.from(dt.files);
  return Array.from(dt.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
}

/**
 * The answers offered when a save has nowhere to go. Compared by value.
 *
 * No explicit "Cancel" among them: `dialogs.choice` already carries a dismiss
 * button, and adding one produced two Cancels side by side.
 */
const CONNECT_FOLDER = 'Connect a folder…';
const TURN_OFF_AUTOSAVE = 'Turn off autosave';

/**
 * Said when a Save has no folder behind it.
 *
 * The workspace is NOT at risk — it is a real SQLite database in the OPFS pool and
 * it survives a reload — so the message leads with that and then says what a folder
 * would add. Anything shorter reads as "your data is not saved".
 */
const NO_FOLDER_YET = 'This workspace is stored in this browser, and stays there. To keep it in a file you can move, back up or open on another machine, connect a workspace folder.';

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
   * surviving; producing a copy to give away is what Export is for.
   */
  async function persist(): Promise<SaveTarget> {
    const bridge = edbBridge();
    if (!bridge) return 'none';
    const handle = edbHandle();
    if (!handle) return 'no-handle';
    if (!(await ensureWritable(handle, true))) {
      await api.ui.dialogs.alert('easyDBAccess is not allowed to write that file. Run the "Connect workspace folder" command to grant it again.', 'Save');
      return 'none';
    }
    await writeBytes(handle, await bridge.export());
    // The file now IS this database, so record what it looks like. That is what
    // lets a later sync tell "someone else wrote this file" from "we wrote it
    // ourselves" — see `file-stamp.ts`.
    const facts = await factsOfHandle(handle);
    if (facts) recordAgreement(activeEdbName(), facts);
    return 'file';
  }

  /**
   * Remember the folder the user just granted, and put the commands in step with it.
   *
   * One function for all three places that can connect a folder — the folder command
   * and both "there is nowhere to save this" answers. When only the first of them
   * refreshed, saving into a brand-new folder left the palette still offering to
   * *connect* one.
   */
  async function connectFolder(dir: FileSystemDirectoryHandle): Promise<void> {
    await rememberFolder(dir);
    await refreshFileCommands();
  }

  /** The folder this app may already write in. Never asks for one. */
  async function connectedFolder(): Promise<FileSystemDirectoryHandle | null> {
    const dir = await rememberedFolder();
    return dir && (await ensureWritable(dir, true)) ? dir : null;
  }

  const autosave = createAutosavePolicy({
    save: async () => {
      if ((await persist()) !== 'no-handle') return;
      // Same rule as a manual Save: a connected folder needs no question. The
      // folder's grant covers creating the file, so this works from a timer,
      // which has no user gesture of its own.
      const dir = await connectedFolder();
      if (dir) await saveIntoFolder(dir);
      else await autosaveHasNowhereToGo();
    },
    onError: (err) => api.ui.dialogs.toast(`Autosave failed: ${String(err)}`, { kind: 'error' }),
    onDirtyChange: () => refreshSaveButton(),
  });

  /** A new file in the granted folder. Null only if the folder stopped working. */
  async function fresh(dir: FileSystemDirectoryHandle, name: string): Promise<EdbTarget | null> {
    const handle = await fileInFolder(dir, name, true);
    return handle ? { handle, name } : null;
  }

  /**
   * Save this workspace into the connected folder as `<workspace-id>.edb`.
   *
   * No name prompt in the ordinary case. A workspace id and its file name are one
   * convention (`spaceFileName`), the folder grant already covers writing in it,
   * and being asked to name a file whose name is a foregone conclusion is the sort
   * of dialog that makes Save feel like paperwork.
   *
   * A name already in the folder is the one exception, and it is confirmed rather
   * than dodged: that file may hold work from another machine, and this Save writes
   * the WHOLE open database over it. Offering another NAME instead — which is what
   * this did — only moved the workspace into a file whose name denies it.
   */
  async function saveIntoFolder(dir: FileSystemDirectoryHandle): Promise<void> {
    const workspaceId = api.workspaceId();
    // Unreachable from the menu or the timer — boot resolves a workspace before
    // either exists — but the file has to be named after something.
    if (!workspaceId) return;
    const name = spaceFileName(workspaceId);
    const taken = (await listWorkspaceFiles(dir)).includes(name);
    if (taken && !(await api.ui.dialogs.confirm(`"${name}" is already in "${dir.name}". Replace it with the workspace open here?`, 'Save'))) return;
    const target = await fresh(dir, name);
    if (!target?.handle) return;
    setEdbHandle(target.handle);
    await rememberHandle(target.handle);
    setActiveEdbName(target.name);
    await save();
  }

  /**
   * A manual Save with no file behind it.
   *
   * Save always means "write to the user's disk", so the only question is where —
   * and the answer is a folder, never a lone file: a folder grant covers every
   * later save and every other workspace, where a per-file grant has to be
   * re-obtained from a gesture the autosave timer does not have.
   *
   * Runs from a click, so the picker has the user gesture it needs.
   */
  async function askForSaveTarget(): Promise<void> {
    if (!canPickFolder()) {
      await api.ui.dialogs.alert(NO_FILE_ACCESS, 'Save');
      return;
    }
    // A dismissed dialog is a cancelled Save, which writes nothing.
    const answer = await api.ui.dialogs.choice(NO_FOLDER_YET, [CONNECT_FOLDER], 'Save');
    if (answer !== CONNECT_FOLDER) return;
    const picked = await pickFolder();
    if (!picked) return;
    // Remembered, but NOT scanned: the user asked to save, not to rebuild the
    // workspace list.
    await connectFolder(picked);
    await saveIntoFolder(picked);
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
      const answer = await api.ui.dialogs.choice('Autosave has no folder to write to.', [...(canPickFolder() ? [CONNECT_FOLDER] : []), TURN_OFF_AUTOSAVE], 'Autosave');
      if (answer === CONNECT_FOLDER && canPickFolder()) {
        const picked = await pickFolder();
        if (picked) {
          await connectFolder(picked);
          await saveIntoFolder(picked);
          return;
        }
      }
      autosave.setEnabled(false);
      await api.settings.set(meta.id, AUTOSAVE_KEY, false, 'user');
      await refreshFileCommands();
      api.ui.dialogs.toast('Autosave is off until this workspace has a file.', { kind: 'info' });
    } finally {
      askingAboutAutosave = false;
    }
  }

  // Every write the worker reports marks the file unsaved. This is the store's
  // own change broadcast, so nothing has to remember to announce itself.
  edbBridge()?.onChanged(() => autosave.changed());

  // Separately, and NOT for every collection: written down, because a sync or a
  // `?space=` switch decides whether the copy of a file on disk may replace this
  // one, and both can run at boot, where the policy above does not exist yet.
  //
  // `settings` and `plugins` are left out on purpose. Running ANY command through
  // the palette upserts the recent-command list into `settings`, so counting that
  // as unsaved work would make "Sync workspace folder" report a conflict with
  // itself, every time. The cost is that a settings-only difference loses to the
  // file — the price of the file ever being able to win.
  edbBridge()?.onChanged((coll) => {
    if (coll === 'settings' || coll === 'plugins') return;
    markLocalChanges(activeEdbName());
  });

  // The worker's own warnings — a failed crash-recovery mirror, above all.
  edbBridge()?.onWarning((message) => api.ui.dialogs.toast(message, { kind: 'warning' }));

  // An import is many calls, and each one would otherwise arm the timer. Holding
  // the batch open means one save at the end instead of one per chunk.
  api.events.on('import:before', () => autosave.beginBatch());
  api.events.on('import:after', () => autosave.endBatch());

  /**
   * A dropped `.edb` brings its workspace INTO this browser.
   *
   * Not an Open: a drop must not repoint the tab at somebody's file and start
   * saving into it. The file is read and left alone, and what arrives is an
   * ordinary workspace of this browser's own — the same end state as New
   * workspace, with data in it.
   *
   * Which workspace, out of a file that may hold several: the one the FILE NAME
   * names (`northwind.edb` → `northwind`), because that is the convention Save and
   * Open already use. Failing that, the only one in the file, and failing that the
   * user is asked.
   */
  async function importDroppedFile(file: File): Promise<void> {
    const live = edbBridge();
    if (!live) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const inside = workspaceDocs(await live.peekWorkspaces(bytes));
    if (inside.length === 0) {
      await api.ui.dialogs.alert(`There is no easyDBAccess workspace in "${file.name}".`, 'Open workspace file');
      return;
    }
    const named = workspaceIdFromFileName(file.name);
    const source = pickWorkspaceIn(inside, named) ?? (await askWhichWorkspace(inside));
    if (!source) return;

    const taken = new Set((await api.store.workspaces.find()).map((w) => w.id));
    let target = source.id;
    let mode: 'fresh' | 'overwrite' | 'rename' = 'fresh';
    if (taken.has(source.id)) {
      const answer = await api.ui.dialogs.choice(
        `"${source.name}" is already a workspace here. Replace what is in this browser with the copy from "${file.name}", or keep both?${await bothCopies(source, file)}`,
        [OVERWRITE_LOCAL, KEEP_BOTH],
        'Open workspace file',
      );
      if (!answer) return;
      mode = answer === OVERWRITE_LOCAL ? 'overwrite' : 'rename';
      if (mode === 'rename') target = freeWorkspaceId(source.id, taken);
    }
    await bringWorkspaceIn(bytes, file.name, source, target, mode);
  }

  /**
   * The two copies, side by side, for the replace-or-keep-both question.
   *
   * Without it the question is about a name only, and both copies have the same
   * name — so "replace" was a decision taken blind, and it is the one that throws
   * work away. What is counted here is the workspace, and the dropped file's size
   * and date are the file's; a count this side cannot take is left out rather than
   * shown as zero.
   */
  async function bothCopies(source: WorkspaceDoc, file: File): Promise<string> {
    let here = {};
    try {
      const c = await countWorkspaceContents(storeBridge(), source.id, { countRows: false });
      here = { tables: c.tables, views: c.views };
    } catch {
      /* a build that cannot count — the file's side is still worth showing */
    }
    return compareCopies([
      { label: 'In this browser', facts: here },
      { label: file.name, facts: { tables: source.tables, views: source.views, size: file.size, mtime: file.lastModified } },
    ]);
  }

  /** The workspace a file name points at, or the only one in the file. */
  function pickWorkspaceIn(inside: readonly WorkspaceDoc[], named: string): WorkspaceDoc | null {
    return inside.find((w) => w.id === named) ?? (inside.length === 1 ? inside[0]! : null);
  }

  /** Several workspaces and no name to choose by, so the user chooses. */
  async function askWhichWorkspace(inside: readonly WorkspaceDoc[]): Promise<WorkspaceDoc | null> {
    const pick = await api.ui.dialogs.choice(
      'Which workspace should come in?',
      inside.map((w) => w.name),
      'Open workspace file',
    );
    return inside.find((w) => w.name === pick) ?? null;
  }

  /**
   * Copy `source` out of the dropped bytes and into this browser as `target`.
   *
   * The bytes go into a THROWAWAY worker, which lands on the memory substrate
   * because the pool is exclusive to the live session — the same arrangement
   * `overwriteInFile` and `peekWorkspaces` rely on.
   *
   * A rename is done INSIDE that throwaway (`cloneWorkspace`) rather than while
   * copying: `copyWorkspace` writes each document under the id it already carries,
   * so the id has to be settled before anything crosses over.
   */
  async function bringWorkspaceIn(bytes: Uint8Array, fileName: string, source: WorkspaceDoc, target: string, mode: 'fresh' | 'overwrite' | 'rename'): Promise<void> {
    const scratch = createEdbBridge();
    setAppProgress({ label: `Opening ${fileName}` });
    // The batch directly rather than through `import:before`: that event carries a
    // table id and a row count, and this is a whole workspace. The effect wanted is
    // the same — one save at the end, not one per chunk.
    autosave.beginBatch();
    try {
      await scratch.open(bytes, DROP_SCRATCH);
      if (mode === 'overwrite') await deleteWorkspace(storeBridge(), target);
      if (mode === 'rename') await cloneWorkspace(scratch, { from: source.id, to: target, name: target, mode: 'all' });
      const from = createIpcDataStore(scratch, () => target);
      const to = createIpcDataStore(storeBridge(), () => target);
      const result = await copyWorkspace(from, to, target, (p) => setAppProgress({ label: `Opening ${fileName}`, detail: p.label }));
      api.ui.dialogs.toast(`"${target}" is now a workspace here: ${result.tables} table(s), ${result.rows} row(s).`, { kind: 'success' });
    } catch (err) {
      await api.ui.dialogs.alert(`"${fileName}" could not be opened: ${err instanceof Error ? err.message : String(err)}`, 'Open workspace file');
      return;
    } finally {
      autosave.endBatch();
      clearAppProgress();
      scratch.terminate();
    }
    // Switch to what just arrived. A reload, because the store, the panels and the
    // plugin host all bind to one workspace at boot.
    reloadWithSpace(target);
  }

  api.ui.registerDropHandler(async (event) => {
    const dropped = filesFrom(event).filter((f) => f.name.toLowerCase().endsWith(EDB_EXTENSION));
    if (dropped.length === 0) return false;
    event.preventDefault();
    // One file per drop: each one asks its own questions and ends in a reload, so
    // a second would be answering into a page that is going away.
    if (dropped.length > 1) {
      api.ui.dialogs.toast('One workspace file at a time, please.', { kind: 'info' });
      return true;
    }
    await importDroppedFile(dropped[0]!);
    return true;
  });

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
      // A connected folder is already an answer to "where does this go?", so the
      // first Save after connecting one asks nothing.
      const dir = await connectedFolder();
      if (dir) await saveIntoFolder(dir);
      else await askForSaveTarget();
      return;
    }
    if (where === 'none') return;
    autosave.markClean();
    // Names the file. "Workspace saved" left the one question a save raises
    // unanswered — saved WHERE — and with a workspace folder in play the answer is
    // not obvious: the file is named after the workspace, not after what the user
    // last picked in a dialog.
    api.ui.dialogs.toast(`Workspace saved to ${activeEdbName()}`, { kind: 'success' });
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
    // "Connect" becomes "Change" from here on.
    await connectFolder(picked);
    await syncFolderNow(picked);
  }

  /**
   * Re-read the connected folder. Offered separately, because files change on disk.
   *
   * Says so rather than opening a picker when there is no folder: a palette is a
   * flat list of everything, so a command has to answer for the state it is run
   * in — and "connect a folder" is the command next to this one.
   */
  async function syncConnectedFolder(): Promise<void> {
    if ((await rememberedFolder()) === null) {
      api.ui.dialogs.toast('No workspace folder is connected yet.', { kind: 'info' });
      return;
    }
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

  /**
   * Make this tab use `name` from the next load on, and reload into the workspace
   * that file is named after.
   *
   * The store is built once per load, so adopting another file is a reload — the
   * same thing the desktop does when it opens another database.
   *
   * `a.edb` is the workspace `a` (`workspaceIdFromFileName`), and the reload asks
   * for it by name. The old `?space=` from whatever was open before must not
   * survive; dropping it and letting boot guess is what made Open land in
   * `default`, or in whichever workspace the file returned first.
   */
  async function adopt(target: EdbTarget, message: string): Promise<void> {
    await adoptEdbFile(target);
    await api.ui.dialogs.alert(message, 'Workspace file');
    reloadWithSpace(workspaceIdFromFileName(target.name));
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
    // This copy came straight out of that file, so the two agree.
    const opened = picked.handle ? await factsOfHandle(picked.handle) : null;
    if (opened) recordAgreement(picked.name, opened);
    await adopt({ name: picked.name, handle: picked.handle }, `Opening "${picked.name}" as the workspace "${workspaceIdFromFileName(picked.name)}". The page will reload.`);
  }

  async function leaveFileMode(): Promise<void> {
    // Reachable with no file behind it now that this is a command rather than a
    // menu item the file mode could hide.
    if (adoptedFileName() === null) {
      api.ui.dialogs.toast('This workspace is not in a file \u2014 there is nothing to come back from.', { kind: 'info' });
      return;
    }
    if (!(await api.ui.dialogs.confirm('Go back to this browser\u2019s own database? The file stays where it is.', 'Local database'))) return;
    await forgetHandle();
    setActiveEdbName(null);
    reloadWithoutSpace();
  }

  /**
   * The header's Save button, with the unsaved marker on its label.
   *
   * A `ButtonSpec` is static and the shell renders from a snapshot of the registry,
   * so the label is edited in place and the shell is asked to re-render. The
   * alternative — a live-updating button type in the plugin API — would be a new
   * contract for every plugin to support one dot.
   *
   * Not registered where the browser cannot produce a file at all: a permanent
   * button whose only answer is "this browser cannot save" is worse than no button.
   */
  const saveButton: ButtonSpec = {
    id: 'edb-file:save',
    label: 'Save',
    icon: 'save',
    tooltip: 'Save this workspace to its file',
    variant: 'primary',
    onClick: () => save(),
  };

  function refreshSaveButton(): void {
    const dirty = autosave.isDirty();
    // The red dot in the button's corner, drawn by the shell — the notification
    // convention, and the only marker that reads at a glance without changing the
    // button's width as the label did.
    saveButton.badge = dirty;
    saveButton.tooltip = dirty ? 'Unsaved changes — click to write them to the file' : 'Everything here is saved';
    document.dispatchEvent(new CustomEvent('easydb:refresh-buttons'));
  }

  if (canReachAFile()) api.ui.registerHeaderButton(saveButton);

  async function toggleAutosave(): Promise<void> {
    const next = !autosave.enabled();
    autosave.setEnabled(next);
    await api.settings.set(meta.id, AUTOSAVE_KEY, next, 'user');
    await refreshFileCommands();
    api.ui.dialogs.toast(`Autosave ${next ? 'on' : 'off'}`, { kind: 'info' });
  }

  /**
   * Two of the commands say what they will do, so their titles follow the state.
   *
   * Edited in place, with nothing told: the palette rebuilds its list on every
   * open and reads these very objects, so the next open is already right. Called
   * at boot, and again wherever the state behind a title changes.
   *
   * `rememberedFolder` is a plain read of what was granted before — never
   * `ensureWritable`, because working out a title must not raise a permission
   * prompt.
   */
  async function refreshFileCommands(): Promise<void> {
    autosaveCommand.title = `${autosave.enabled() ? 'Turn off' : 'Turn on'} autosave`;
    folderCommand.title = (await rememberedFolder()) ? 'Change workspace folder…' : 'Connect workspace folder…';
  }

  const autosaveCommand: CommandSpec = {
    id: 'edb-file:autosave',
    title: 'Turn on autosave',
    group: FILE_GROUP,
    icon: 'autorenew',
    keywords: ['auto', 'save', 'timer', 'file'],
    run: () => toggleAutosave(),
  };

  const folderCommand: CommandSpec = {
    id: 'edb-file:folder',
    title: 'Connect workspace folder…',
    group: FILE_GROUP,
    icon: 'folder_special',
    keywords: ['change', 'connect', 'directory', 'file'],
    run: () => chooseFolder(),
  };

  session = { autosave, refreshSaveButton, refreshFileCommands };

  api.ui.registerCommand({
    id: 'edb-file:open',
    title: 'Open workspace file…',
    group: FILE_GROUP,
    icon: 'folder_open',
    keywords: ['edb', 'file', 'load', 'switch'],
    run: () => open(),
  });

  // Save is a HEADER BUTTON, and the palette already lists every button under
  // "Actions" — so registering it as a command too would be the same entry twice.
  // Where the browser cannot produce a file the button is not there at all, and
  // then this is the only place left that can explain why.
  if (!canReachAFile()) {
    api.ui.registerCommand({
      id: 'edb-file:save',
      title: 'Save workspace to a file',
      group: FILE_GROUP,
      icon: 'save',
      keywords: ['write', 'disk', 'edb'],
      run: () => save(),
    });
  }

  api.ui.registerCommand(autosaveCommand);

  if (canPickFolder()) {
    api.ui.registerCommand(folderCommand);
    api.ui.registerCommand({
      id: 'edb-file:sync-folder',
      title: 'Sync workspace folder',
      group: FILE_GROUP,
      icon: 'sync',
      keywords: ['refresh', 're-read', 'folder', 'file'],
      run: () => syncConnectedFolder(),
    });
  }

  api.ui.registerCommand({
    id: 'edb-file:leave',
    title: 'Back to browser storage',
    group: FILE_GROUP,
    icon: 'logout',
    keywords: ['detach', 'forget', 'file'],
    run: () => leaveFileMode(),
  });

  void refreshFileCommands();
}

// The one-time "Storage has changed" notice used to live here. It told a
// returning user that their pre-SQLite IndexedDB data was NOT carried over, and
// pointed them at an older build to export from — advice a phone cannot follow,
// because there is no File System Access API to export through.
//
// `plugins/legacy-import.ts` replaces it with an offer to copy that data across,
// and owns the `easydb:legacy-idb-notice` flag this used to set.

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

  // The shell snapshots the registry during boot, and boot itself writes — the
  // workspace record, the seeded view templates — so the button can already be out
  // of date by its first paint. One push here settles it.
  session?.refreshSaveButton();

  // The file half. A workspace with no file needs no handle and no permission, but
  // everything below the `if` is about a file this tab has already adopted.
  if (adoptedFileName() !== null) {
    // Re-check the folder before the file. A folder the user has allowed on every
    // visit covers everything in it, so Save then needs no prompt at all — and
    // asking about the folder once beats asking about each file.
    const folder = await rememberedFolder();
    if (folder) await ensureWritable(folder, false);
    // The handle from the last session. Permission is READ, not asked for: asking
    // needs a gesture, and the workspace already loaded from the pool. A Chrome
    // user with a persisted grant reads back `granted` and saves silently.
    const remembered = await rememberedHandle();
    if (remembered) {
      setEdbHandle(remembered);
      await ensureWritable(remembered, false);
    }
  }

  // Autosave last, and for a workspace with or without a file: the timer must not
  // arm before the handle above is back, or the first tick would find none and ask
  // where to save a workspace that already has an answer.
  const on = await api.settings.get(meta.id, AUTOSAVE_KEY);
  if (on === true && session) {
    session.autosave.setEnabled(true);
    // So the palette says "Turn off autosave" rather than offering to turn on
    // what is already on.
    await session.refreshFileCommands();
    api.ui.dialogs.toast('Autosave is on for this workspace', { kind: 'info' });
  }
}
