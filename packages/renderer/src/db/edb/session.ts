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

/** The file name this tab should open, or null for the Dexie path. */
export function activeEdbName(): string | null {
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
 * Start the file-backed session, or return null to leave this tab on Dexie.
 *
 * The bytes come from the OPFS mirror, never from the user's file: reading their
 * file needs a permission grant, and a grant needs a gesture a boot sequence does
 * not have. The mirror is origin-private and always readable, so the workspace
 * comes back straight away and the handle is only re-permissioned on the first
 * Save.
 *
 * A missing mirror is not a failure — it is the first run with a new file.
 */
export async function startEdbSession(): Promise<EdbSession | null> {
  const name = activeEdbName();
  if (!name) return null;
  const bridge = createEdbBridge();
  try {
    const bytes = await bridge.restore(name);
    await bridge.open(bytes, name);
    setEdbBridge(bridge);
    return { bridge, name };
  } catch (err) {
    // A worker that will not start must not take the app down with it. Falling
    // back to Dexie loses the file view, not the user's ability to work, and the
    // marker is cleared so the next load does not retry the same failure.
    lastError = err;
    bridge.terminate();
    setActiveEdbName(null);
    return null;
  }
}
