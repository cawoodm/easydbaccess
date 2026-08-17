import { setEdbBridge } from './active-bridge.js';
import { createEdbBridge, type EdbBridge } from './worker-bridge.js';

/**
 * Whether this tab is file-backed, and the bridge if it is.
 *
 * The choice is made ONCE at boot, because `app-context.ts` builds the
 * `DataStore` once. Switching between Dexie and a file therefore reloads the
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
 * one that holds all workspaces, in place of the Dexie database it replaced.
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
    /* private mode — the tab stays on Dexie, which is the safe direction */
  }
}

/**
 * Start this tab's SQLite session. Always — there is no other store.
 *
 * The bytes come from the OPFS mirror, never from the user's file: reading their
 * file needs a permission grant, and a grant needs a gesture a boot sequence does
 * not have. The mirror is origin-private and always readable, so the workspace
 * comes back straight away and the handle is only re-permissioned on the first
 * Save.
 *
 * A missing mirror is not a failure — it is the first run.
 *
 * **This THROWS rather than degrading.** It used to fall back to Dexie, which
 * was a real alternative store; there is none now, so a caught failure would
 * leave the app looking like it worked while holding nothing. The caller shows a
 * blocking notice instead. The adopted-file marker is still cleared first, so a
 * reload after a bad user file lands on the local database rather than retrying
 * the same failure forever.
 */
export async function startEdbSession(): Promise<EdbSession> {
  const name = activeEdbName();
  const bridge = createEdbBridge();
  try {
    const bytes = await bridge.restore(name);
    await bridge.open(bytes, name);
    setEdbBridge(bridge);
    return { bridge, name };
  } catch (err) {
    lastError = err;
    bridge.terminate();
    if (adoptedFileName() !== null) setActiveEdbName(null);
    throw err;
  }
}
