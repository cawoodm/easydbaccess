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
 * A workspace id from anything a user typed.
 *
 * Lives here rather than in `app-context.ts` because it is half of the id ⇄ file
 * name pair below, and the two rules have to agree: a workspace created from the
 * name "My Data" gets the id `my-data`, so opening `My Data.edb` has to arrive at
 * the same id or it would land in a workspace of its own.
 *
 * Only `a-z0-9_-` survive, so an id never contains the `::` that separates a
 * setting's workspace from its name (see `settingId`).
 */
export function slugifyWorkspace(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}

/**
 * The file name a workspace id maps to.
 *
 * Nothing asks the user to name a file any more (`edbTargetNamed` takes the name),
 * so inside the workspace folder this holds. It is still only a convention: an OS
 * save dialog lets the name be changed, and a file can arrive from anywhere. That
 * is why the caller still checks what is actually inside the file it opens.
 */
export function spaceFileName(workspaceId: string): string {
  return `${workspaceId}${EDB_EXTENSION}`;
}

/**
 * The workspace a file is about: `a.edb` is the workspace `a`.
 *
 * The same convention as {@link spaceFileName}, read the other way, and it is
 * what Open uses to decide which workspace to land in. A path is accepted because
 * `pickFileToOpen` hands back whatever the OS dialog gave it.
 */
export function workspaceIdFromFileName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const stem = base.toLowerCase().endsWith(EDB_EXTENSION) ? base.slice(0, -EDB_EXTENSION.length) : base;
  return slugifyWorkspace(stem);
}

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
   * The file has been written since this browser's copy was made from it, and
   * that copy holds nothing unsaved — so the file is simply the newer of the two.
   *
   * This is how two origins sharing one folder converge: each holds its own
   * imported copy (OPFS and the handle store are per-origin), and whoever opens
   * the workspace next reads what the other one saved. `file-stamp.ts` is what
   * can answer this at boot, where the in-memory dirty flag does not exist yet.
   */
  fileIsNewer: boolean;
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
  /** Nothing found unprompted, but a folder could be granted. Needs a gesture. */
  | 'ask-for-folder'
  /** Create the workspace, which is what this always used to do. */
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
 * `fileIsNewer` is the one thing that lets the file win over a copy this browser
 * already holds, and it is narrow on purpose: the file was written after our copy
 * was made from it, and our copy holds nothing unsaved. Without it two tabs on
 * different origins never converge — each keeps re-opening its own stale import
 * of the same file, because everything except the folder is origin-scoped.
 *
 * `hasLocalDb` is otherwise checked BEFORE `inGrantedFolder`, which reads backwards: the
 * user's own file ought to win over a browser-held copy. It does not, because
 * adopting the folder file means `SAHPoolUtil.importDb` over the copy this
 * browser holds, and that copy may contain edits never written back to the file
 * — boot never reads the user's file at all (see `session.ts`), so unsaved work
 * lives only in the browser. Preferring the file would discard it without asking.
 * When there is no local copy there is nothing to lose and the file is used.
 */
export function decideSpace(e: SpaceEvidence): SpaceAction {
  if (e.inOpenDb) return 'use-open';
  if (e.isActive) return 'create';
  if (e.hasLocalDb) return e.inGrantedFolder && e.fileIsNewer ? 'adopt-folder-file' : 'adopt-local-db';
  if (e.inGrantedFolder) return 'adopt-folder-file';
  if (e.canAskForFolder) return 'ask-for-folder';
  return 'create';
}
