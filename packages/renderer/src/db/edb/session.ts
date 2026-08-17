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
  /** The file name this session is backed by, used for the mirror and Save As. */
  name: string;
}

/**
 * The database this tab uses when the user has adopted no file of their own.
 *
 * Every browser tab is SQLite now, so there is always a database — this is the
 * one that holds all workspaces, in place of the IndexedDB database it replaced.
 */
export const LOCAL_DB_NAME = 'local.edb';

/**
 * The file name this tab should open. Never null: with no adopted file it is
 * {@link LOCAL_DB_NAME}.
 */
export function activeEdbName(): string {
  return adoptedFileName() ?? LOCAL_DB_NAME;
}

/**
 * The user's own file, when this tab has adopted one — null when it is on the
 * built-in local database.
 *
 * This is the distinction the File menu means by "file mode". It is NOT "is
 * there a database?", which is now always yes.
 */
export function adoptedFileName(): string | null {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_KEY) ?? null;
  } catch {
    return null; // private mode
  }
}

/** Make this tab file-backed on its next load. The caller reloads. */
export function setActiveEdbName(name: string | null): void {
  try {
    if (name === null) globalThis.localStorage?.removeItem(ACTIVE_KEY);
    else globalThis.localStorage?.setItem(ACTIVE_KEY, name);
  } catch {
    /* private mode — the tab keeps the local database, which is the safe direction */
  }
}

/**
 * Start this tab's SQLite session. Always — there is no other store.
 *
 * The database comes from the OPFS pool, never from the user's file: reading
 * their file needs a permission grant, and a grant needs a gesture a boot
 * sequence does not have. The pool is origin-private and always readable, so
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
