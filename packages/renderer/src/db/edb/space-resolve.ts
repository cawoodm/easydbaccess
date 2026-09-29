// packages/renderer/src/db/edb/space-resolve.ts
//
// What `?space=NAME` should do when the OPEN database has no such workspace.
//
// Until now it created one, silently, inside whichever database the tab happened
// to have open. So `?space=sales`, on a machine where `sales.edb` sits in the
// user's workspace folder, produced an empty `sales` in the project index — the
// real file untouched, and `persistLastWorkspace` making the empty one sticky.
// A link to a workspace has to be able to FIND that workspace.
//
// The decision is pure and the evidence is gathered by the caller, because every
// piece of it costs something different: reading the pool's file list is free,
// listing the user's folder needs a permission that may already be granted, and
// asking for that permission needs a gesture no boot sequence has.

import { EDB_EXTENSION } from './file-handle.js';
import { workspaceIdFromFileName } from '@easydb/shared';
import type { FileVerdict } from './file-stamp.js';

/**
 * The id ⇄ file name rules, re-exported from `@easydb/shared`.
 *
 * They USED to be defined here, and were copied into `shared` when `EdbStore`
 * started enforcing them — two byte-identical copies of "which workspace is this
 * file about", which is the exact shape of bug this module exists to prevent. The
 * store is what refuses a write, so the store's package owns the rule and this
 * one re-exports it: every importer keeps its import path and there is one answer
 * again.
 */
export { isCanonicalWorkspaceId, slugifyWorkspace, spaceFileName, workspaceIdFromFileName } from '@easydb/shared';

/**
 * A workspace id like `base` that nothing is using yet.
 *
 * `northwind` → `northwind-2` → `northwind-3`. What a dropped file needs when the
 * workspace it holds is already here and the user asks to keep both: an id is
 * derived from a name and two workspaces cannot share one, so the copy needs an id
 * of its own before anything is written.
 *
 * The suffix starts at 2 because the one already there is the first.
 */
export function freeWorkspaceId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
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
  /**
   * How this browser's copy and the file stand, from the recorded stamp.
   *
   * A VERDICT, not a boolean, and that is the whole of the fix for a workspace
   * opening empty. It used to be `fileIsNewer`, which collapsed five states into
   * two: `unknown` — no stamp, so nothing can be concluded — came out false and
   * was therefore indistinguishable from "our copy is fine". A stamp only exists
   * on the origin that imported or wrote the file, so `unknown` is every new
   * origin, every new profile and every new machine; the browser's copy won those
   * silently, and where that copy was an empty shell the user saw a workspace
   * with no tables while the data sat untouched in the file.
   *
   * `file-stamp.ts` is what can answer this at boot, where the in-memory dirty
   * flag does not exist yet.
   */
  verdict: FileVerdict;
  /**
   * A folder this user has already chosen, which could be re-permissioned.
   *
   * NOT "this browser has a directory picker" — that is true of every Chromium,
   * and `?space=<new name>` is also how a workspace is CREATED by URL, so it
   * would ask about a folder that does not exist on every new workspace.
   */
  canAskForFolder: boolean;
}

/**
 * May a workspace that exists nowhere be CREATED in the database this tab has open?
 *
 * The second half of "a `.edb` holds one workspace", and the half that has nothing
 * to do with Save. `?space=zz` in a tab that has `alpha.edb` open used to create
 * `zz` inside `alpha.edb` — a file named after one workspace, holding two. So did
 * every fall-through on the way to creating one: a folder that had to be asked
 * for, or an adopt whose target had since gone.
 *
 * The rule reads off the EXTENSION, which is what the extensions are for. A `.edb`
 * may only ever hold the workspace its name says; the project index (`.edp`) holds
 * any number, which is what makes it the place a homeless workspace goes.
 *
 * One rule in one function, called at the one line that creates a workspace at
 * boot (`app-context.ts`), rather than a case per route — four of those routes
 * existed and three of them got it wrong.
 */
export function mayCreateWorkspaceIn(dbName: string, workspaceId: string): boolean {
  if (!dbName.toLowerCase().endsWith(EDB_EXTENSION)) return true;
  return workspaceIdFromFileName(dbName) === workspaceId;
}

export type SpaceAction =
  /** Use the workspace that is already here. No reload. */
  | 'use-open'
  /** Point the tab at the browser's own database of that name, then reload. */
  | 'adopt-local-db'
  /** Import the folder's file into this browser, then reload. */
  | 'adopt-folder-file'
  /**
   * Two copies exist and nothing here can say which the user means. Ask.
   *
   * The answer to "never prefer the browser's copy silently". Whoever acts on
   * this must have a `Dialogs` and a user gesture, so a click asks straight away
   * (`openWorkspaceInFile`) and a boot records the question for the UI to put
   * once it exists — the same arrangement {@link SpaceAction} already makes for
   * `ask-for-folder`.
   */
  | 'ask-which-copy'
  /** Nothing found unprompted, but a folder could be granted. Needs a gesture. */
  | 'ask-for-folder'
  /**
   * Create the workspace, which is what this always used to do.
   *
   * WHERE it gets created is not this decision's business: see
   * {@link mayCreateWorkspaceIn}, which the caller checks before creating anything
   * — a `.edb` may only hold the workspace its name says, so a create can land in
   * the project index instead, whichever route reached it.
   */
  | 'create';

/**
 * Which of the four to do.
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
 * — boot never reads the user's file at all (see `session.ts`), so unsaved work
 * lives only in the browser. Preferring the file would discard it without asking.
 * When there is no local copy there is nothing to lose and the file is used.
 *
 * But "do not discard it without asking" is not the same as "keep it without
 * asking", and for four versions this did the second. See {@link settleTwoCopies}.
 */
export function decideSpace(e: SpaceEvidence): SpaceAction {
  if (e.inOpenDb) return 'use-open';
  if (e.isActive) return 'create';
  if (e.hasLocalDb) return e.inGrantedFolder ? settleTwoCopies(e.verdict) : 'adopt-local-db';
  if (e.inGrantedFolder) return 'adopt-folder-file';
  if (e.canAskForFolder) return 'ask-for-folder';
  return 'create';
}

/**
 * Both copies exist: this browser's, and the file in the granted folder.
 *
 * ONE table, and it is the only place this question is answered — `decideSpace`
 * and `decideActiveFileSync` used to read the same verdict two opposite ways,
 * which is how a workspace could open empty here and be asked about there.
 *
 * Three verdicts are safe to settle without the user, because in each of them the
 * stamp PROVES which copy is current and the other holds nothing the first does
 * not:
 *
 * - `same` — the file is exactly as we left it, so the two copies are one thing
 *   and there is nothing to choose between them.
 * - `ahead` — we hold changes and the file has not moved, so this copy is the
 *   file plus work. Taking the file would throw that work away.
 * - `file-newer` — the mirror image: the file was written after our copy was made
 *   from it and nothing here is unsaved, so the file is this copy plus work.
 *   Taking it is what "prefer the disk" MEANS, and it is also the only way two
 *   origins sharing a folder ever converge — everything but the folder is
 *   origin-scoped, so each would otherwise re-open its own stale import forever.
 *
 * The other two ask, because in both of them each side may hold something the
 * other does not and no stamp can say which the user wants:
 *
 * - `conflict` — the file was written AND we hold unsaved changes.
 * - `unknown` — no stamp at all. We have never read this file on this origin, so
 *   the browser's copy under that name may be anything, including the empty
 *   database a boot creates when the pool is asked for a name it does not hold.
 *   That case is why this function exists.
 *
 * (A Sync asks about `file-newer` too — `decideActiveFileSync` — and the
 * difference is the moment, not the rule. There the workspace is already on
 * screen and a Sync would replace it under the user; here they are OPENING that
 * workspace, and handing them the current copy is what they asked for.)
 */
function settleTwoCopies(verdict: FileVerdict): SpaceAction {
  if (verdict === 'same' || verdict === 'ahead') return 'adopt-local-db';
  return verdict === 'file-newer' ? 'adopt-folder-file' : 'ask-which-copy';
}
