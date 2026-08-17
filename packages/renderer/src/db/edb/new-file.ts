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
import { edbBridge } from './active-bridge.js';
import { setActiveEdbName } from './session.js';
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
 * Build a database in a throwaway worker, put it on disk, and hand it to the
 * live worker so the reload that follows lands on it.
 *
 * `fill` writes the initial contents through a `DataStore` scoped to
 * `workspaceId` — a fresh workspace record, or a copy of an existing one. It is
 * optional: without it the file holds an empty database.
 *
 * The throwaway worker cannot place the result itself. The `opfs-sahpool` VFS is
 * exclusive origin-wide and the live worker holds it, so a second worker falls
 * back to memory and writes its copy where no boot looks. The bytes therefore go
 * back through `importBytes` on the bridge this tab is actually using. Nothing
 * reads the user's FILE at boot — that would need a permission gesture no boot
 * sequence has.
 */
export async function buildEdbFile(target: EdbTarget, workspaceId: string, fill?: (store: DataStore) => Promise<void>): Promise<void> {
  const bridge = createEdbBridge();
  let bytes: Uint8Array;
  try {
    await bridge.open(null, target.name);
    if (fill) await fill(createIpcDataStore(bridge, () => workspaceId));
    bytes = await bridge.export();
  } finally {
    bridge.terminate();
  }
  if (target.handle) await writeBytes(target.handle, bytes);
  else downloadBytes(target.name, bytes);
  await placeForNextBoot(target.name, bytes);
}

/**
 * Put `bytes` where the next boot will find them, under `name`.
 *
 * Shared by Convert (above) and Open (`plugins/edb-file.ts`), which have the
 * same shape: produce a database, then reload into it.
 */
export async function placeForNextBoot(name: string, bytes: Uint8Array): Promise<void> {
  const live = edbBridge();
  if (live) {
    await live.importBytes(name, bytes);
    return;
  }
  // No live session — the very first boot could not start one. Fall back to a
  // worker of our own, which then DOES get the pool.
  const bridge = createEdbBridge();
  try {
    await bridge.importBytes(name, bytes);
  } finally {
    bridge.terminate();
  }
}

/**
 * Make this tab use `target` from its next load on.
 *
 * The caller reloads. The store is built once per load, so adopting another file
 * is a reload — the same thing the desktop does when it opens another database.
 */
export async function adoptEdbFile(target: EdbTarget): Promise<void> {
  if (target.handle) await rememberHandle(target.handle);
  else await forgetHandle();
  setActiveEdbName(target.name);
}
