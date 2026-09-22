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

import type { Dialogs } from '@easydb/shared';
import { edbBridge } from './active-bridge.js';
import { activeEdbName, reloadWithSpace, setActiveEdbName } from './session.js';
import { canPickFolder, ensureWritable, fileInFolder, listWorkspaceFiles, readBytes, rememberHandle, rememberedFolder } from './file-handle.js';
import { factsOfHandle, readStamp, recordAgreement, verdictFor } from './file-stamp.js';
import type { FileVerdict } from './file-stamp.js';
import { askWhichCopy, type CopySides } from './copy-choice.js';
import { readFolderIndex } from './folder-index.js';
import type { CopyFacts } from './copy-facts.js';
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
 * What to do, and how the two copies stood when that was decided.
 *
 * The verdict rides along because `ask-which-copy` has to explain ITSELF — "the
 * other machine saved something" and "this browser has never read that file" are
 * different situations with the same three answers, and re-deriving it in the
 * caller would mean reading the file's facts a second time.
 */
interface Plan {
  action: SpaceAction;
  verdict: FileVerdict;
}

/**
 * Where a named `.edb` can be got from, by the rules in `space-resolve.ts`.
 *
 * Keyed on the FILE rather than on a workspace id, because the two do not always
 * agree: a workspace can be renamed, and two files can hold copies of one
 * workspace under one name. Whoever already knows which file it means must be
 * able to say so — see {@link openWorkspaceInFile}.
 *
 * `guard` is the boot-loop guard. Boot wants it (every adopt reloads, and a
 * reload re-runs the decision); a user who clicked something does not, or a
 * single failed boot would make that entry unclickable for the rest of the tab's
 * life.
 */
async function planForFile(file: string, guard: boolean): Promise<Plan> {
  if (guard && alreadyTried(file)) return { action: 'create', verdict: 'unknown' };

  const bridge = edbBridge();
  const remembered = await rememberedFolder();
  const dir = remembered && (await ensureWritable(remembered, false)) ? remembered : null;
  const inFolder = dir ? (await listWorkspaceFiles(dir)).includes(file) : false;
  // Only asked when the file is there to be compared: reading its facts costs a
  // `getFile()`, and the answer is `unknown` without a stamp from an earlier
  // import or save — which is the state this whole question exists for.
  const verdict: FileVerdict = dir && inFolder ? await verdictFor(file, await fileInFolder(dir, file, false)) : 'unknown';
  const action = decideSpace({
    inOpenDb: false, // the caller only asks after it has looked
    isActive: activeEdbName() === file,
    // No bridge means Electron, which has its own file operations and no pool.
    hasLocalDb: bridge ? await bridge.hasDatabase(file) : false,
    inGrantedFolder: inFolder,
    verdict,
    // A folder this user has ALREADY chosen, not merely a browser that could
    // show a picker. `canPickFolder()` alone is true of every Chromium, so a
    // user who has never used a workspace folder was asked to go looking in one
    // — and since `?space=<new name>` is how a workspace gets CREATED by URL,
    // that was every new workspace, every time. Nothing to look in means
    // nothing to ask about.
    canAskForFolder: remembered !== null && canPickFolder(),
  });
  return { action, verdict };
}

/**
 * The two copies, as much of each as could be counted without adopting either.
 *
 * Neither read is expensive, and that is the point — a question the user has to
 * stop and answer must not cost a copy of a 600k-row workspace:
 *
 * - **This browser's** come from `peekDatabase`, a second connection on the pool
 *   file. No rows are read.
 * - **The file's** come out of the folder index, which took them while the scan
 *   already had the file open (`FolderWorkspace`), and fall back to peeking the
 *   file itself where the index has nothing to say — an index written before
 *   v0.0.407 carries no counts, and a file can be opened that no scan has seen.
 *   Its size and date come off the handle either way, because the index may be a
 *   scan old.
 *
 * Reading the file is the one expensive thing here, and it is affordable exactly
 * here: once, behind a question the user has to stop and answer. `countsInFile`
 * in `plugins/edb-file.ts` pays the same price for the same reason.
 *
 * **A database we COULD read, holding no such workspace, is zero — not unknown.**
 * That distinction is the whole guard: an empty pool copy is precisely a database
 * with no workspace record in it, and reporting that as "could not count" would
 * leave the question one-sided and `overwriteLosesData` unable to fire on the one
 * answer that loses everything. Only a read that FAILED is left out.
 */
async function sidesFor(file: string, workspaceId: string, handle: FileSystemFileHandle | null): Promise<CopySides> {
  const bridge = edbBridge();
  const here: CopyFacts = {};
  // `hasDatabase` first: an empty array from `peekDatabase` means "no such
  // workspace" for a database this browser holds, and "nothing to count" for one
  // it does not, and the two must not read alike.
  const held = bridge ? await bridge.hasDatabase(file).catch(() => false) : false;
  const inside = held ? await bridge!.peekDatabase(file).catch(() => null) : null;
  if (inside) {
    const mine = inside.find((w) => String(w.doc['id'] ?? '') === workspaceId);
    here.tables = mine?.tables ?? 0;
    here.views = mine?.views ?? 0;
  }

  const there: CopyFacts = { ...(handle ? ((await factsOfHandle(handle)) ?? {}) : {}) };
  const indexed = readFolderIndex()?.workspaces.find((w) => w.file === file && w.id === workspaceId);
  if (indexed?.tables !== undefined) {
    there.tables = indexed.tables;
    if (indexed.views !== undefined) there.views = indexed.views;
  } else if (bridge && handle) {
    const peeked = await readBytes(handle)
      .then((bytes) => bridge.peekWorkspaces(bytes))
      .catch(() => null);
    const theirs = peeked?.find((w) => String(w.doc['id'] ?? '') === workspaceId);
    if (peeked) {
      there.tables = theirs?.tables ?? 0;
      there.views = theirs?.views ?? 0;
    }
  }
  return { here, there };
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
  const { action, verdict } = await planForFile(file, true);
  if (action === 'ask-for-folder') pendingFolderRequest = workspaceId;
  if (action === 'ask-which-copy') {
    // A boot has no dialogs and no gesture, so the question is left for the UI —
    // the same arrangement `pendingFolderRequest` already makes. Meanwhile the
    // tab takes the browser's copy, which is the answer that cannot destroy
    // anything: it leaves the file untouched, and the question that follows can
    // still reach it. The caller treats this exactly like `adopt-local-db`.
    rememberCopyQuestion({ workspaceId, file, verdict });
    return 'adopt-local-db';
  }
  return action;
}

/** The "which copy?" question a boot could not ask, as it waits for the UI. */
export interface CopyQuestionNote {
  workspaceId: string;
  file: string;
  verdict: FileVerdict;
}

/**
 * The pending question, in `sessionStorage` rather than in module state.
 *
 * `pendingSpaceRequest` can be module state because `ask-for-folder` does not
 * reload — the boot falls through and the UI asks in the same page. This one has
 * to survive exactly one reload: taking the browser's copy IS an adopt, so the
 * tab that recorded the question is replaced before anything can ask it. Module
 * state would be gone by then, which is the same silence this exists to end.
 *
 * It dies with the tab, which is right: the answer is about the session in front
 * of you, and a reload is a fresh look at both copies.
 */
const COPY_QUESTION_KEY = 'eda:copyQuestion';

function rememberCopyQuestion(note: CopyQuestionNote): void {
  try {
    globalThis.sessionStorage?.setItem(COPY_QUESTION_KEY, JSON.stringify(note));
  } catch {
    /* private mode — the adopt still happens, and Sync is the way to ask later */
  }
}

/**
 * The pending question, TAKEN rather than read.
 *
 * One shot. Answering it ends in a reload of its own, and a question that came
 * back after being answered would be a loop with a modal in it.
 */
export function takeCopyQuestion(): CopyQuestionNote | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(COPY_QUESTION_KEY);
    if (!raw) return null;
    globalThis.sessionStorage?.removeItem(COPY_QUESTION_KEY);
    const note = JSON.parse(raw) as Partial<CopyQuestionNote>;
    // A shape check, not a schema: anything unrecognisable means no question,
    // which is the state every other tab is in anyway.
    return typeof note?.workspaceId === 'string' && typeof note.file === 'string' && typeof note.verdict === 'string' ? { workspaceId: note.workspaceId, file: note.file, verdict: note.verdict as FileVerdict } : null;
  } catch {
    return null;
  }
}

/**
 * The file a "Compare them…" answer is waiting on.
 *
 * `sessionStorage`, and a one-shot: the comparison needs a live store bound to
 * the workspace (`merge-file.ts` opens the file BESIDE it), so it cannot run in
 * the tab that asked the question — that tab is about to be replaced by the
 * reload that adopts a copy. The marker survives exactly that reload and dies
 * with the tab.
 */
const COMPARE_KEY = 'eda:compareWithFile';

function askForComparison(file: string): void {
  try {
    globalThis.sessionStorage?.setItem(COMPARE_KEY, file);
  } catch {
    /* private mode — the adopt still happens, the comparison has to be asked for */
  }
}

/** The pending comparison, taken rather than read: it must not run twice. */
export function takeComparisonRequest(): string | null {
  try {
    const file = globalThis.sessionStorage?.getItem(COMPARE_KEY) ?? null;
    if (file !== null) globalThis.sessionStorage?.removeItem(COMPARE_KEY);
    return file;
  } catch {
    return null;
  }
}

/**
 * Answer the "which copy?" question, and carry it out.
 *
 * Shared by the two callers that HAVE a `Dialogs`: the workspace selector, which
 * asks before it switches, and `edb-file.ts`'s `load()`, which asks the question
 * boot had to leave behind. Both end in a reload unless the user dismissed.
 *
 * Returns what the caller should do next, in its own terms.
 */
export async function settleCopyQuestion(dialogs: Dialogs, file: string, workspaceId: string, verdict: FileVerdict): Promise<'file' | 'browser' | 'compare' | 'none'> {
  const dir = await grantedFolder();
  const handle = dir ? await fileInFolder(dir, file, false) : null;
  const sides = await sidesFor(file, workspaceId, handle);
  const stamp = readStamp(file);
  return askWhichCopy(dialogs, { file, verdict, ...sides, ...(stamp ? { knownSize: stamp.size } : {}) });
}

/**
 * Switch this tab to the workspace `workspaceId` **in the file `file`**, said
 * outright rather than derived from a name.
 *
 * This is what the workspace selector needs and `?space=` cannot give it. A
 * `?space=` link carries a NAME, and boot turns that name into a file
 * (`spaceFileName`) — so two files holding a workspace of one name are one
 * destination, and picking either sent the user to whichever the name spelled.
 * Two copies of `simon` in `simon.edb` and `powerplants.edb` both opened
 * `simon.edb`, which is precisely the pair the list shows to tell them apart.
 *
 * The file decides the database and the id decides the workspace inside it. Both
 * come from the folder index, which read them out of that file, so neither is
 * inferred from the other.
 *
 * Three outcomes, because a deliberate Cancel and a file that has gone are not
 * the same news. `unavailable` is worth a message — the index is a cache, so the
 * file may have been moved or renamed since the scan — and `cancelled` is worth
 * none at all. Reporting the second as the first is how "which copy?" would read
 * as a fault. On `switched` this never really returns: the page is being replaced.
 */
export type SwitchOutcome = 'switched' | 'cancelled' | 'unavailable';

export async function openWorkspaceInFile(file: string, workspaceId: string, dialogs: Dialogs): Promise<SwitchOutcome> {
  // Already the open database: nothing to adopt, just ask for the workspace.
  if (activeEdbName() === file) {
    reloadWithSpace(workspaceId);
    return 'switched';
  }

  let { action, verdict } = await planForFile(file, false);

  // A folder this user already chose, whose grant has lapsed — which is every
  // fresh browser session unless Chrome persisted it. Boot cannot ask
  // (`requestPermission` needs a gesture and a boot has none) so it answers
  // `ask-for-folder` and leaves a note for the UI; a click IS a gesture, so ask
  // here. Without this the list would go on offering every file in the folder and
  // refusing to open any of them until the user reconnected a folder the app still
  // remembers perfectly well.
  if (action === 'ask-for-folder') {
    const dir = await rememberedFolder();
    if (dir && (await ensureWritable(dir, true))) ({ action, verdict } = await planForFile(file, false));
  }

  // Both copies exist and the stamp cannot say which is current. A click has a
  // gesture and a shell, so this is asked HERE — before anything is switched —
  // rather than left for the UI the way boot has to leave it.
  if (action === 'ask-which-copy') {
    const answer = await settleCopyQuestion(dialogs, file, workspaceId, verdict);
    if (answer === 'none') return 'cancelled';
    if (answer === 'compare') askForComparison(file);
    // Comparing opens the browser's copy first: it is the side that destroys
    // nothing, and the comparison then settles the two against the file.
    action = answer === 'file' ? 'adopt-folder-file' : 'adopt-local-db';
  }

  if (action === 'adopt-folder-file') {
    const dir = await grantedFolder();
    const handle = dir ? await fileInFolder(dir, file, false) : null;
    if (!handle) return 'unavailable'; // the listing was a moment old
    // Facts and bytes off the one handle, so the stamp describes exactly what was
    // imported — the same pairing `adoptFolderFile` makes, and for the same reason.
    const facts = await factsOfHandle(handle);
    const bytes = await readBytes(handle);
    if (facts) recordAgreement(file, facts);
    await placeForNextBoot(file, bytes);
    await rememberHandle(handle);
  } else if (action === 'adopt-local-db') {
    // The file is not imported, but the HANDLE still has to be remembered: this
    // tab is about to be backed by a database named after that file, and
    // everything downstream — Save, Sync, and the comparison a "Compare them…"
    // answer has just asked for — finds the file through `rememberedHandle`.
    const dir = await grantedFolder();
    const handle = dir ? await fileInFolder(dir, file, false) : null;
    if (handle) await rememberHandle(handle);
  } else {
    // 'create', or a folder whose prompt was just declined. Neither is a switch:
    // the user picked something that exists, so inventing an empty workspace in
    // its place would be a lie the list told them.
    return 'unavailable';
  }

  setActiveEdbName(file);
  // `reloadWithSpace`, not `location.reload()`: the URL still carries the
  // `?space=` of the workspace being left, and it would outrank the file just
  // adopted. See `session.ts`.
  reloadWithSpace(workspaceId);
  return 'switched';
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
