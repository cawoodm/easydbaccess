import type { DataStore, Dialogs } from '@easydb/shared';
import { createIpcDataStore } from '../data-store-bridge.js';
import {
  canPickFolder,
  canSaveInPlace,
  downloadBytes,
  ensureWritable,
  fileInFolder,
  forgetHandle,
  listWorkspaceFiles,
  pickFileToSave,
  pickFolder,
  rememberFolder,
  rememberHandle,
  rememberedFolder,
  writeBytes,
  EDB_EXTENSION,
} from './file-handle.js';
import { rememberWorkspace } from './registry.js';
import { createEdbBridge } from './worker-bridge.js';

/**
 * Making a new `.edb` file and switching this tab to it.
 *
 * Two callers need exactly this: the File menu's "New .edb file", and creating a
 * workspace with the Advanced storage strategy. It lives here, in the storage
 * layer, rather than in either of them — and it takes {@link Dialogs} as an
 * argument instead of reaching for a `HostApi`, so the chrome can call it without
 * importing a plugin.
 */

export interface EdbTarget {
  /** Null where the browser has no save picker — the caller downloads instead. */
  handle: FileSystemFileHandle | null;
  name: string;
}

/**
 * The folder the workspace files live in, asking for it the first time.
 *
 * One grant covers every file in it, which is the point: without a folder the
 * browser asks again for every New and every Open. Null means this browser has no
 * directory picker, or the user declined — both fall back to per-file pickers.
 */
export async function workspaceFolder(): Promise<FileSystemDirectoryHandle | null> {
  const remembered = await rememberedFolder();
  if (remembered && (await ensureWritable(remembered, true))) return remembered;
  if (!canPickFolder()) return null;
  const picked = await pickFolder();
  if (!picked) return null;
  await rememberFolder(picked);
  return picked;
}

/**
 * Where to write a workspace file, and under what name.
 *
 * Inside the folder there is no OS dialog at all — the grant already covers it,
 * so the user just types a name.
 */
export async function chooseEdbTarget(dialogs: Dialogs, suggested: string): Promise<EdbTarget | null> {
  const dir = await workspaceFolder();
  if (dir) {
    const existing = await listWorkspaceFiles(dir);
    const typed = await dialogs.prompt(`Name for the workspace file in "${dir.name}"`, suggested, 'Workspace file');
    if (!typed) return null;
    const name = typed.toLowerCase().endsWith(EDB_EXTENSION) ? typed : `${typed}${EDB_EXTENSION}`;
    // `getFileHandle` with `create` opens an existing name rather than refusing,
    // so the only thing standing between the user and a lost file is this.
    if (existing.includes(name) && !(await dialogs.confirm(`"${name}" is already in this folder. Replace it?`, 'Workspace file'))) return null;
    const handle = await fileInFolder(dir, name, true);
    if (handle) return { handle, name };
    // The folder stopped working. Fall through rather than dead-ending.
  }
  if (!canSaveInPlace()) return { handle: null, name: suggested };
  const picked = await pickFileToSave(suggested);
  return picked ? { handle: picked, name: picked.name } : null;
}

/**
 * Build a database in a throwaway worker and put it on disk.
 *
 * `fill` writes the initial contents through a `DataStore` scoped to
 * `workspaceId` — a fresh workspace record, or a copy of an existing one. It is
 * optional: without it the file holds an empty database.
 *
 * The mirror is flushed before returning, because the caller reloads and the boot
 * after that reload reads the OPFS mirror. It never reads the user's file, which
 * would need a permission gesture no boot sequence has.
 */
export async function buildEdbFile(target: EdbTarget, workspaceId: string, fill?: (store: DataStore) => Promise<void>): Promise<void> {
  const bridge = createEdbBridge();
  try {
    await bridge.open(null, target.name);
    if (fill) await fill(createIpcDataStore(bridge, () => workspaceId));
    const bytes = await bridge.export();
    if (target.handle) await writeBytes(target.handle, bytes);
    else downloadBytes(target.name, bytes);
    await bridge.flush();
  } finally {
    bridge.terminate();
  }
}

/**
 * Record that `workspace` now lives in `target`, so the next load opens it there.
 *
 * The caller reloads. The store is built once per load, so binding a workspace to
 * a file is a reload — the same thing the desktop does when it opens another
 * database.
 *
 * The binding is per WORKSPACE. Every other workspace keeps the store it had, so
 * the selector still lists them and another tab is left alone.
 */
export async function adoptEdbFile(target: EdbTarget, workspace: { id: string; name: string }): Promise<void> {
  if (target.handle) await rememberHandle(target.handle);
  else await forgetHandle();
  rememberWorkspace({ id: workspace.id, name: workspace.name, file: target.name });
}
