// packages/renderer/src/db/edb/space-adopt.ts
//
// Acting on what `space-resolve.ts` decided: gathering the evidence, and doing
// the adopt.
//
// Split from the decision so the ordering rules stay testable without OPFS, a
// worker or a FileSystemAccess handle — none of which exist in a Vitest run.
//
// Everything here runs DURING boot, after the session is up but before the
// workspace is settled. That ordering is not a preference: probing the pool
// needs a worker, only one tab may own the pool (`tab-lock.ts`), and a
// throwaway probe worker would take the pool away from the real session.

import { edbBridge } from './active-bridge.js';
import { activeEdbName, setActiveEdbName } from './session.js';
import { canPickFolder, ensureWritable, fileInFolder, listWorkspaceFiles, readBytes, rememberHandle, rememberedFolder } from './file-handle.js';
import { decideSpace, spaceFileName, type SpaceAction } from './space-resolve.js';

/**
 * The `?space=` request that could not be answered without asking for a folder.
 *
 * Module state, read once the UI exists, because the answer needs a click:
 * `requestPermission` is only granted from a user gesture, and a boot has none.
 * `plugins/edb-file.ts` picks this up in `load()`, the same place it reports a
 * session that failed to start.
 */
let pendingFolderRequest: string | null = null;

export function pendingSpaceRequest(): string | null {
  return pendingFolderRequest;
}

export function clearPendingSpaceRequest(): void {
  pendingFolderRequest = null;
}

/**
 * One adopt attempt per file per tab.
 *
 * `sessionStorage`, so it dies with the tab rather than poisoning the next one.
 * Every adopt ends in `location.reload()`, and the reload re-runs this code: if
 * the adopt did not take — `localStorage` refused in private mode, the pool
 * import silently produced an empty database — the second pass would decide the
 * same thing and reload again, with nothing on screen to interrupt it.
 */
const ATTEMPT_KEY = 'eda:spaceAdopt';

function alreadyTried(file: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(ATTEMPT_KEY) === file;
  } catch {
    return false; // no sessionStorage — accept one extra attempt over none
  }
}

function markTried(file: string): void {
  try {
    globalThis.sessionStorage?.setItem(ATTEMPT_KEY, file);
  } catch {
    /* private mode — the loop guard degrades, the adopt still works */
  }
}

/** The folder, only if it is readable RIGHT NOW. Never prompts. */
async function grantedFolder(): Promise<FileSystemDirectoryHandle | null> {
  const dir = await rememberedFolder();
  if (!dir) return null;
  return (await ensureWritable(dir, false)) ? dir : null;
}

/**
 * What `?space=<workspaceId>` should do, given that the open database has no
 * workspace of that name.
 *
 * Returns `'create'` for the caller to carry on with what it always did. Any
 * other answer has already been acted on and ends in a reload, so the caller
 * must stop: see {@link adoptAndReload}.
 */
export async function planForMissingSpace(workspaceId: string): Promise<SpaceAction> {
  const file = spaceFileName(workspaceId);
  if (alreadyTried(file)) return 'create';

  const bridge = edbBridge();
  const dir = await grantedFolder();
  const action = decideSpace({
    inOpenDb: false, // the caller only asks after it has looked
    isActive: activeEdbName() === file,
    // No bridge means Electron, which has its own file operations and no pool.
    hasLocalDb: bridge ? await bridge.hasDatabase(file) : false,
    inGrantedFolder: dir ? (await listWorkspaceFiles(dir)).includes(file) : false,
    canAskForFolder: canPickFolder(),
  });

  if (action === 'ask-for-folder') pendingFolderRequest = workspaceId;
  return action;
}

/**
 * Point this tab at `file` and reload, so `?space=` lands in the right database.
 *
 * Never resolves. A reload is asynchronous — the page keeps running until the
 * navigation commits — and the caller is mid-boot, so returning would let it
 * finish wiring a store that is about to be thrown away.
 */
async function adoptAndReload(file: string, bytes: Uint8Array | null, handle: FileSystemFileHandle | null): Promise<never> {
  markTried(file);
  // Order matters: the bytes have to be in the pool before the marker points at
  // the name, or the reload opens a database that does not exist yet and the
  // pool obligingly creates it empty.
  if (bytes) await edbBridge()?.open(bytes, file);
  if (handle) await rememberHandle(handle);
  setActiveEdbName(file);
  location.reload();
  return new Promise<never>(() => {});
}

/** Switch to the browser's own database of that name. Nothing to import. */
export function adoptLocalDb(workspaceId: string): Promise<never> {
  return adoptAndReload(spaceFileName(workspaceId), null, null);
}

/**
 * Import the folder's file into this browser, then switch to it.
 *
 * Falls back to `'create'` when the file cannot be read after all — a folder
 * listing is a moment old, and the file may have gone.
 */
export async function adoptFolderFile(workspaceId: string): Promise<SpaceAction> {
  const file = spaceFileName(workspaceId);
  const dir = await grantedFolder();
  const handle = dir ? await fileInFolder(dir, file, false) : null;
  if (!handle) return 'create';
  return adoptAndReload(file, await readBytes(handle), handle);
}
