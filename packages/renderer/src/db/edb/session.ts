import { setEdbBridge } from './active-bridge.js';
import { createEdbBridge, type EdbBridge } from './worker-bridge.js';

/**
 * Whether this load is file-backed, and the bridge if it is.
 *
 * The choice is made ONCE per load, because `app-context.ts` builds the
 * `DataStore` once. Switching stores therefore reloads the page — which costs
 * nothing extra, since switching workspace already reloads (see
 * `chrome/workspace-actions.ts`), and it is what the desktop does when it opens
 * another `.db`.
 *
 * WHICH file is not decided here and is not global. It comes from the workspace
 * this load resolved, through `edb/registry.ts`. It used to be one `localStorage`
 * key naming "the open file" — but `localStorage` is per ORIGIN, like IndexedDB,
 * so that one name applied to every tab and every workspace, and every workspace
 * kept in IndexedDB vanished from the selector while a file was open.
 */

/**
 * The file this load opened, in memory only.
 *
 * Deliberately NOT persisted: a persisted answer is what made a second tab adopt
 * the first tab's file. Two tabs on two workspaces now hold two different files,
 * and each one knows only its own.
 */
let activeFile: string | null = null;

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

/** The file this load is backed by, or null when it is on IndexedDB. */
export function activeEdbName(): string | null {
  return activeFile;
}

/**
 * Point the current load at another file, without reloading.
 *
 * Only Save As needs this: the workspace has just been written somewhere else, so
 * a later Save must go to the new file rather than the one this load opened. The
 * lasting record of the move is `rememberWorkspace`.
 */
export function setActiveEdbName(name: string | null): void {
  activeFile = name;
}

/**
 * Start the file-backed session for `file`, or return null to stay on IndexedDB.
 *
 * The bytes come from the OPFS mirror, never from the user's file: reading their
 * file needs a permission grant, and a grant needs a gesture a boot sequence does
 * not have. The mirror is origin-private and always readable, so the workspace
 * comes back straight away and the handle is only re-permissioned on the first
 * Save.
 *
 * A missing mirror is not a failure — it is the first run with a new file.
 */
export async function startEdbSession(file: string | null): Promise<EdbSession | null> {
  if (!file) return null;
  const bridge = createEdbBridge();
  try {
    const bytes = await bridge.restore(file);
    await bridge.open(bytes, file);
    setEdbBridge(bridge);
    activeFile = file;
    return { bridge, name: file };
  } catch (err) {
    // A worker that will not start must not take the app down with it. Falling
    // back to IndexedDB loses the file view, not the user's ability to work. The
    // registry entry is LEFT ALONE: it is the only record that this workspace
    // belongs in a file, and dropping it here would strand the workspace in a
    // store that does not hold its data.
    lastError = err;
    bridge.terminate();
    activeFile = null;
    return null;
  }
}
