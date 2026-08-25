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
import { activeEdbName, reloadWithSpace, setActiveEdbName } from './session.js';
import { canPickFolder, ensureWritable, fileInFolder, listWorkspaceFiles, readBytes, rememberHandle, rememberedFolder } from './file-handle.js';
import { factsOfHandle, recordAgreement, verdictFor } from './file-stamp.js';
import { placeForNextBoot } from './new-file.js';
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

/**
 * Spend the guard once the adopt has demonstrably landed.
 *
 * Called at boot with the database that actually opened. A marker matching it
 * means the import took, so it has done its job — and leaving it would turn the
 * NEXT switch into this file into a `create`: go back to browser storage, follow
 * a `?space=` link to that workspace again, and the tab would make an empty one
 * instead of re-reading the file. The guard is for an adopt that did NOT take, so
 * only that case keeps it.
 */
export function noteSessionOpened(name: string): void {
  try {
    if (globalThis.sessionStorage?.getItem(ATTEMPT_KEY) === name) globalThis.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    /* no sessionStorage — nothing was recorded to spend */
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
  const remembered = await rememberedFolder();
  const dir = remembered && (await ensureWritable(remembered, false)) ? remembered : null;
  const inFolder = dir ? (await listWorkspaceFiles(dir)).includes(file) : false;
  const action = decideSpace({
    inOpenDb: false, // the caller only asks after it has looked
    isActive: activeEdbName() === file,
    // No bridge means Electron, which has its own file operations and no pool.
    hasLocalDb: bridge ? await bridge.hasDatabase(file) : false,
    inGrantedFolder: inFolder,
    // Only asked when the file is there to be compared: reading its facts costs a
    // `getFile()`, and the answer is `unknown` — never "newer" — without a stamp
    // from an earlier import or save.
    fileIsNewer: dir && inFolder ? (await verdictFor(file, await fileInFolder(dir, file, false))) === 'file-newer' : false,
    // A folder this user has ALREADY chosen, not merely a browser that could
    // show a picker. `canPickFolder()` alone is true of every Chromium, so a
    // user who has never used a workspace folder was asked to go looking in one
    // — and since `?space=<new name>` is how a workspace gets CREATED by URL,
    // that was every new workspace, every time. Nothing to look in means
    // nothing to ask about.
    canAskForFolder: remembered !== null && canPickFolder(),
  });

  if (action === 'ask-for-folder') pendingFolderRequest = workspaceId;
  return action;
}

/**
 * Leave the adopted `.edb` for the project index, then reload to create the
 * workspace there.
 *
 * The answer to `?space=<a workspace nobody has>` in a tab that has a file open.
 * Creating it where the tab happens to be would put a second workspace inside a
 * `.edb` named after the first — the duplicate-workspace bug, arrived at by URL
 * instead of by Save.
 *
 * Never resolves, for the same reason as {@link adoptAndReload}: the caller is
 * mid-boot and the page is about to be replaced.
 *
 * `markTried` is keyed on the file being LEFT, so a reload that somehow lands here
 * again with the same file still open stops instead of bouncing.
 */
export async function leaveFileForIndex(workspaceId: string): Promise<void> {
  const leaving = activeEdbName();
  // One attempt, for the same reason `alreadyTried` exists: `setActiveEdbName`
  // swallows a `localStorage` failure (private mode), so the reload would come
  // back on the same file and decide the same thing forever — a blank page in a
  // loop, with nothing on screen to interrupt it. A second pass returns instead,
  // and the caller creates the workspace where it is. That leaves a `.edb` holding
  // two workspaces, which is the thing this exists to prevent — but only in a
  // browser that cannot remember anything, and a wrong file beats no app at all.
  if (alreadyTried(leaving)) return;
  markTried(leaving);
  setActiveEdbName(null);
  reloadWithSpace(workspaceId);
  // Never resolves on the way out: the page is being replaced and the caller is
  // mid-boot, so returning would let it finish wiring a store about to be thrown
  // away.
  return new Promise<void>(() => {});
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
  // pool obligingly creates it empty. `placeForNextBoot` imports WITHOUT
  // switching the live session, which `open` would do — pointless work on a page
  // that is about to be replaced, and a store the rest of the app still holds.
  if (bytes) await placeForNextBoot(file, bytes);
  if (handle) await rememberHandle(handle);
  setActiveEdbName(file);
  location.reload();
  return new Promise<never>(() => {});
}

/**
 * Re-read the file this tab ALREADY has open, then reload onto it.
 *
 * What "the file moved on" comes to: another origin, profile or machine wrote the
 * `.edb` this tab imported, and our copy is behind. The workspace does not change
 * and neither does the adopted-file marker — only the bytes underneath.
 *
 * Deliberately not `adoptFolderFile`: that one is keyed on a workspace id (a file
 * is named after its workspace) and it marks the file as tried, which is a
 * boot-loop guard. This runs from a Sync the user asked for, and after it the
 * stamp matches, so a second Sync does nothing without any marker.
 *
 * Returns false when the file cannot be read after all; otherwise never returns —
 * the reload is on its way. See {@link adoptAndReload}.
 */
export async function reloadActiveFromFile(file: string): Promise<boolean> {
  const dir = await grantedFolder();
  const handle = dir ? await fileInFolder(dir, file, false) : null;
  if (!handle) return false;
  const facts = await factsOfHandle(handle);
  const bytes = await readBytes(handle);
  await placeForNextBoot(file, bytes);
  await rememberHandle(handle);
  if (facts) recordAgreement(file, facts);
  location.reload();
  await new Promise<never>(() => {});
  return true;
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
export async function adoptFolderFile(workspaceId: string, fileName?: string): Promise<SpaceAction> {
  // The caller may KNOW the file, and knowing beats deriving: a clash is matched
  // on the workspace name now, so the file holding it need not be named after the
  // id on this side. `spaceFileName` stays the default for every caller that has
  // only an id.
  const file = fileName ?? spaceFileName(workspaceId);
  const dir = await grantedFolder();
  const handle = dir ? await fileInFolder(dir, file, false) : null;
  if (!handle) return 'create';
  // The facts are read from the same handle as the bytes, so the stamp describes
  // exactly what was imported. A write landing between the two would leave us
  // believing we match a file we do not — one Sync away from being noticed, and
  // the alternative is a lock the API does not have.
  const facts = await factsOfHandle(handle);
  const bytes = await readBytes(handle);
  if (facts) recordAgreement(file, facts);
  return adoptAndReload(file, bytes, handle);
}
