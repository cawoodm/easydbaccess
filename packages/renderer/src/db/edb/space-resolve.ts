// packages/renderer/src/db/edb/space-resolve.ts
//
// What `?space=NAME` should do when the OPEN database has no such workspace.
//
// Until now it created one, silently, inside whichever database the tab happened
// to have open. So `?space=sales`, on a machine where `sales.edb` sits in the
// user's workspace folder, produced an empty `sales` inside `local.edb` — the
// real file untouched, and `persistLastWorkspace` making the empty one sticky.
// A link to a workspace has to be able to FIND that workspace.
//
// The decision is pure and the evidence is gathered by the caller, because every
// piece of it costs something different: reading the pool's file list is free,
// listing the user's folder needs a permission that may already be granted, and
// asking for that permission needs a gesture no boot sequence has.

import { EDB_EXTENSION } from './file-handle.js';

/**
 * The file name a workspace id maps to.
 *
 * By convention only — `chooseEdbTarget` suggests this name and the user may
 * type another, so a match here is a strong hint and never a guarantee. That is
 * why the caller still checks what is actually inside the file it opens.
 */
export function spaceFileName(workspaceId: string): string {
  return `${workspaceId}${EDB_EXTENSION}`;
}

/** Everything the decision below reads. Gathered by the caller, cheapest first. */
export interface SpaceEvidence {
  /** The requested workspace is already in the database this tab has open. */
  inOpenDb: boolean;
  /** This tab's database IS the candidate file. */
  isActive: boolean;
  /** This browser already holds a database of that name from an earlier session. */
  hasLocalDb: boolean;
  /** The candidate file is in a folder this app can already read, unprompted. */
  inGrantedFolder: boolean;
  /** An IndexedDB dump of that name exists — what a Save with no file writes. */
  hasSnapshot: boolean;
  /**
   * A folder this user has already chosen, which could be re-permissioned.
   *
   * NOT "this browser has a directory picker" — that is true of every Chromium,
   * and `?space=<new name>` is also how a workspace is CREATED by URL, so it
   * would ask about a folder that does not exist on every new workspace.
   */
  canAskForFolder: boolean;
}

export type SpaceAction =
  /** Use the workspace that is already here. No reload. */
  | 'use-open'
  /** Point the tab at the browser's own database of that name, then reload. */
  | 'adopt-local-db'
  /** Import the folder's file into this browser, then reload. */
  | 'adopt-folder-file'
  /** Restore the IndexedDB dump of that name, then reload. */
  | 'adopt-snapshot'
  /** Nothing found unprompted, but a folder could be granted. Needs a gesture. */
  | 'ask-for-folder'
  /** Create the workspace, which is what this always used to do. */
  | 'create';

/**
 * Which of the five to do.
 *
 * Two orderings here are deliberate and both are about not destroying data.
 *
 * `isActive` short-circuits to `create` rather than adopting anything. The
 * candidate file is already this tab's database and simply has no workspace of
 * that name in it, so there is nothing to switch to — and because every adopt
 * ends in `location.reload()`, an adopt here would reload into the same state
 * and decide the same thing again, forever.
 *
 * `hasLocalDb` is checked BEFORE `inGrantedFolder`, which reads backwards: the
 * user's own file ought to win over a browser-held copy. It does not, because
 * adopting the folder file means `SAHPoolUtil.importDb` over the copy this
 * browser holds, and that copy may contain edits never written back to the file
 * — boot has never read the user's file (no permission gesture), so unsaved work
 * lives only in the browser. Preferring the file would discard it without asking.
 * When there is no local copy there is nothing to lose and the file is used.
 *
 * The IndexedDB dump comes last of the three copies because it is the one the
 * user did not choose the location of: it is what a Save writes when there is no
 * file to write to (`idb-snapshot.ts`), so a real file of the same name is the
 * better answer whenever there is one.
 */
export function decideSpace(e: SpaceEvidence): SpaceAction {
  if (e.inOpenDb) return 'use-open';
  if (e.isActive) return 'create';
  if (e.hasLocalDb) return 'adopt-local-db';
  if (e.inGrantedFolder) return 'adopt-folder-file';
  if (e.hasSnapshot) return 'adopt-snapshot';
  if (e.canAskForFolder) return 'ask-for-folder';
  return 'create';
}
