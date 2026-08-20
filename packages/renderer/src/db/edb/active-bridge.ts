import type { EdbBridge } from './worker-bridge.js';
import type { EasydbStoreBridge } from '../data-store-bridge.js';

/**
 * The file-backed session's bridge and file handle, for the one plugin that
 * needs them.
 *
 * Module state rather than something on `HostApi`: only `plugins/edb-file.ts`
 * has any business exporting database bytes or writing the user's file, and
 * putting it on the plugin API would offer it to every plugin. `app-context.ts`
 * fills this in as it builds the store; inside Electron it stays empty, because
 * the preload supplies the bridge instead.
 */

let bridge: EdbBridge | null = null;
let handle: FileSystemFileHandle | null = null;

export function setEdbBridge(next: EdbBridge | null): void {
  bridge = next;
}

/** The active worker bridge, or null inside Electron, which has its own. */
export function edbBridge(): EdbBridge | null {
  return bridge;
}

/**
 * The store bridge for THIS environment — the worker's in the browser, the
 * preload's in Electron.
 *
 * Whole-workspace operations need it: `DataStore` cannot express them, because
 * its `settings` view only ever sees the active workspace. Everything else
 * should keep using `DataStore` and stay unaware of which transport it is on.
 */
export function storeBridge(): EasydbStoreBridge {
  const found = window.easydb?.store ?? bridge;
  // Unreachable in a booted app: `app-context.ts` cannot finish without one of
  // the two, and it puts a blocking notice up if the worker will not start.
  if (!found) throw new Error('[storage] no store bridge — the app has not finished starting');
  return found;
}

/**
 * The file the session writes to.
 *
 * Null in two different situations that behave the same way: no file has been
 * chosen yet, and a browser with no picker where only a download is possible.
 */
export function setEdbHandle(next: FileSystemFileHandle | null): void {
  handle = next;
}

export function edbHandle(): FileSystemFileHandle | null {
  return handle;
}
