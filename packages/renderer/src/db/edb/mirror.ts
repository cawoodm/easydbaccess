/**
 * The OPFS mirror: a copy of the database the browser owns.
 *
 * Two jobs, and the second is the one that shapes the design:
 *
 * 1. **Crash insurance.** The database lives in memory between saves, so a
 *    closed or crashed tab would lose everything since the last write.
 * 2. **Restoring on reload without asking.** A remembered `FileSystemFileHandle`
 *    usually needs a user GESTURE to re-grant write permission, which a boot
 *    sequence does not have. (Chrome can carry the grant across loads, but only
 *    if the user chose that, and only in Chrome.) The mirror is origin-private,
 *    so the worker reads it with no permission at all — the workspace comes back
 *    whatever the handle's permission state says.
 *
 * Worker-only: `createSyncAccessHandle` exists nowhere else. That is also what
 * keeps this working without the COOP/COEP headers GitHub Pages cannot set.
 */

const DIR = 'edb-mirror';

/** Everything about one mirrored workspace. `at` is when it was written. */
export interface MirrorRecord {
  bytes: Uint8Array;
  at: number;
}

async function mirrorDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/** The mirror file name for a workspace. One file per workspace, so switching keeps both. */
function fileName(workspaceId: string): string {
  return `${encodeURIComponent(workspaceId)}.edb`;
}

/**
 * Replace the mirror for this workspace.
 *
 * `truncate(0)` first: writing fewer bytes than are already there would otherwise
 * leave the tail of the previous database behind, and the result would not open.
 */
export async function writeMirror(workspaceId: string, bytes: Uint8Array): Promise<void> {
  const dir = await mirrorDir();
  const handle = await dir.getFileHandle(fileName(workspaceId), { create: true });
  const sync = await handle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    sync.write(bytes, { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }
}

/** The mirrored bytes, or null when this workspace has none. */
export async function readMirror(workspaceId: string): Promise<MirrorRecord | null> {
  try {
    const dir = await mirrorDir();
    const handle = await dir.getFileHandle(fileName(workspaceId));
    const file = await handle.getFile();
    if (file.size === 0) return null;
    return { bytes: new Uint8Array(await file.arrayBuffer()), at: file.lastModified };
  } catch {
    // No directory, no file, or no OPFS at all — all mean "nothing mirrored",
    // which is a normal first run and not an error worth surfacing.
    return null;
  }
}

/** Forget a workspace's mirror — after a successful save, or when it is deleted. */
export async function clearMirror(workspaceId: string): Promise<void> {
  try {
    const dir = await mirrorDir();
    await dir.removeEntry(fileName(workspaceId));
  } catch {
    /* already gone */
  }
}
