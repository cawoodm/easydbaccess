import { setEdbBridge } from './active-bridge.js';
import { claimStoreOwnership } from './tab-lock.js';
import { createEdbBridge, type EdbBridge } from './worker-bridge.js';

/** Thrown when another tab already owns the database. Recognised by the caller. */
export class StoreBusyError extends Error {
  constructor() {
    super('easyDBAccess is already open in another tab. Only one tab can use the database at a time.');
    this.name = 'StoreBusyError';
  }
}

/**
 * Whether this tab is file-backed, and the bridge if it is.
 *
 * The choice is made ONCE at boot, because `app-context.ts` builds the
 * `DataStore` once. Switching between the local database and a file therefore reloads the
 * page — the same thing the desktop does when it opens another `.db`, and far
 * simpler than making every holder of a store handle re-bind mid-session.
 *
 * The marker is device-local (`localStorage`), not a workspace setting: which
 * file this tab has open is a property of the tab, not of the data.
 */

const ACTIVE_KEY = 'easydb:edb:active';

/**
 * Why the file-backed session did not start.
 *
 * Recorded rather than logged: this runs before there is a `HostApi` to show a
 * toast with, and falling back to local storage silently would leave the user
 * wondering where their file went. `plugins/edb-file.ts` reports it once the UI
 * exists.
 */
let lastError: unknown = null;

export function lastEdbError(): unknown {
  return lastError;
}

export interface EdbSession {
  bridge: EdbBridge;
  /** The file name this session is backed by — what the pool and the mirror key on. */
  name: string;
}

/**
 * The database this tab uses when the user has adopted no file of their own: the
 * **project index**, which holds the workspace list and every workspace that is
 * not in a file of its own.
 *
 * Every browser tab is SQLite now, so there is always a database. This is the one
 * that holds several workspaces — and the reason it is `.edp` rather than `.edb`.
 *
 * **`.edb` = exactly one workspace. `.edp` = the project index, which holds many.**
 * The two used to share the `.edb` extension, and that is the root of four
 * duplicate-workspace bugs: the rule "a `.edb` holds one workspace" was false of
 * the file the app itself writes most, so no reader could tell whether a `.edb`
 * with two workspaces in it was a bug or the normal case. Now the name says which.
 * See `db/edb/one-per-file.ts` and `docs/tech/EDB.md`.
 *
 * It is not a file the user ever sees: it lives in the origin-private OPFS pool,
 * never in the workspace folder. Nothing writes a `.edp` to disk.
 */
export const INDEX_DB_NAME = 'index.edp';

/**
 * What {@link INDEX_DB_NAME} was called up to v0.0.427.
 *
 * Kept only so the boot can move an existing browser's database onto the new name
 * — see {@link startEdbSession}. A user whose workspaces are in `local.edb` must
 * not lose them to a rename, and there is no reasonable "you have been upgraded"
 * dialog for a file they never knew existed.
 */
export const LEGACY_LOCAL_DB_NAME = 'local.edb';

/**
 * The database name this tab should open. Never null: with no adopted file it is
 * {@link INDEX_DB_NAME}.
 *
 * So the answer is either a `.edb` — one workspace, a file the user owns — or the
 * project index. Nothing else is ever a database name.
 */
export function activeEdbName(): string {
  return adoptedFileName() ?? INDEX_DB_NAME;
}

/**
 * The user's own file, when this tab has adopted one — null when it is on the
 * built-in local database.
 *
 * This is the distinction the file commands mean by "file mode". It is NOT "is
 * there a database?", which is now always yes.
 */
export function adoptedFileName(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_KEY) ?? null;
  } catch {
    return null; // private mode
  }
}

/**
 * Which file this tab is backed by, as an event.
 *
 * The marker is `localStorage`, which nothing can subscribe to, and one thing on
 * screen names it: the workspace list's tooltip. A first Save adopts a file
 * WITHOUT a reload, so without this the list went on saying the workspace was
 * "stored in this browser" until something else happened to re-render it.
 */
export const ACTIVE_FILE_CHANGED_EVENT = 'easydb:active-file-changed';

/** Make this tab file-backed on its next load. The caller reloads. */
export function setActiveEdbName(name: string | null): void {
  try {
    if (name === null) globalThis.localStorage?.removeItem(ACTIVE_KEY);
    else globalThis.localStorage?.setItem(ACTIVE_KEY, name);
  } catch {
    /* private mode — the tab keeps the local database, which is the safe direction */
  }
  // After the write, so a listener that re-reads sees the new value. Most callers
  // reload immediately and nothing hears it, which costs nothing.
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ACTIVE_FILE_CHANGED_EVENT));
}

/**
 * Start this tab's SQLite session. Always — there is no other store.
 *
 * The database comes from the OPFS pool, never from the user's file. Reading
 * their file needs a live write grant, which a boot usually does not have — and
 * even where Chrome persisted one, the pool copy may hold edits never written
 * back, so the file is not the newer of the two. The pool is always readable, so
 * the workspace comes back straight away and the handle is only
 * re-permissioned on the first Save. (It is also why Open and Convert push
 * their bytes into the pool through the LIVE worker before reloading — see
 * `new-file.ts`'s `placeForNextBoot`.)
 *
 * A pool file that is not there yet is not a failure — it is the first run.
 *
 * **This THROWS rather than degrading.** It used to fall back to a second,
 * IndexedDB-backed store; there is none now, so a caught failure would
 * leave the app looking like it worked while holding nothing. The caller shows a
 * blocking notice instead. The adopted-file marker is still cleared first, so a
 * reload after a bad user file lands on the local database rather than retrying
 * the same failure forever.
 */
export async function startEdbSession(): Promise<EdbSession> {
  // Before the substrate, and independent of it: the pool's files are exclusive
  // origin-wide, and the memory fallback would let two tabs overwrite each
  // other's snapshots without any error at all. See `tab-lock.ts`.
  if (!(await claimStoreOwnership())) throw new StoreBusyError();
  const name = activeEdbName();
  const bridge = createEdbBridge();
  try {
    // BEFORE the open, because opening `index.edp` would create it empty and there
    // would then be nothing to move onto. Only for the index: an adopted `.edb`
    // never had another name. A failure here is not fatal — the rename leaves the
    // old name in place unless the new one holds the bytes — so a browser that
    // cannot do it opens an empty index rather than refusing to start, which is
    // also what a first run looks like.
    if (name === INDEX_DB_NAME) await bridge.renameDatabase(LEGACY_LOCAL_DB_NAME, INDEX_DB_NAME);
    // No bytes: a pooled database opens its own file, and the memory fallback
    // reads its own mirror. Bytes are only passed when ADOPTING a user's file.
    await bridge.open(null, name);
    setEdbBridge(bridge);
    return { bridge, name };
  } catch (err) {
    lastError = err;
    bridge.terminate();
    if (adoptedFileName() !== null) setActiveEdbName(null);
    throw err;
  }
}

/**
 * Reload onto the database this tab has just adopted, WITHOUT the `?space=` the
 * old one left in the URL.
 *
 * `openWorkspace` writes `?space=NAME` and nothing ever takes it out again, so it
 * survives every later reload. `location.reload()` re-requests the same URL,
 * query string included — so opening `simon.edb` while the URL still said
 * `?space=powerplants` resolved a workspace that file has never held, created an
 * empty one inside it, and showed a workspace with no tables. The file the user
 * just chose decides which workspace is active; a parameter from the last one
 * must not outrank it.
 *
 * `?space=` driven adopts are the exception and must keep it — the reload has to
 * re-resolve the same name against the file it just took on. See
 * `space-adopt.ts`.
 */
export function reloadWithoutSpace(): void {
  const url = new URL(location.href);
  url.searchParams.delete('space');
  url.searchParams.delete('workspace');
  location.replace(url.toString());
}

/**
 * Reload onto the adopted database, asking for ONE named workspace inside it.
 *
 * What Open uses: `a.edb` is the workspace `a`, so the stale `?space=` goes and
 * the file's own name takes its place. Dropping the parameter entirely (above)
 * left boot to guess from the device-global last-workspace id and then from
 * whichever record the file happened to return first, which is how opening
 * `a.edb` could land in a workspace called `default`.
 *
 * A file that holds no workspace of that name does NOT get one created inside it.
 * It would then hold two workspaces under a name that names one of them, which is
 * the bug `one-per-file.ts` exists to stop — so `decideSpace` answers
 * `create-in-index`: leave the file, create the workspace in the project index.
 * Up to v0.0.427 the `isActive` short-circuit created it in the file instead.
 */
export function reloadWithSpace(workspaceId: string): void {
  const url = new URL(location.href);
  url.searchParams.delete('workspace');
  url.searchParams.set('space', workspaceId);
  location.replace(url.toString());
}
