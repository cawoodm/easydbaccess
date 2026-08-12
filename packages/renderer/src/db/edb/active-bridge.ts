import type { EdbBridge } from './worker-bridge.js';

/**
 * The file-backed session's bridge and file handle, for the one plugin that
 * needs them.
 *
 * Module state rather than something on `HostApi`: only `plugins/edb-file.ts`
 * has any business exporting database bytes or writing the user's file, and
 * putting it on the plugin API would offer it to every plugin. `app-context.ts`
 * fills this in as it builds the store; a tab on Dexie leaves it empty.
 */

let bridge: EdbBridge | null = null;
let handle: FileSystemFileHandle | null = null;

export function setEdbBridge(next: EdbBridge | null): void {
  bridge = next;
}

/** The active bridge, or null when this tab is not file-backed. */
export function edbBridge(): EdbBridge | null {
  return bridge;
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
