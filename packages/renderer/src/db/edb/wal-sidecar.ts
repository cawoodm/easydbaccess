// packages/renderer/src/db/edb/wal-sidecar.ts
//
// Whether the copy of a `.edb` on disk is the whole story.
//
// `wal-header.ts` makes a desktop-written file OPENABLE in the browser. This
// module answers the question that then becomes dangerous: in WAL mode a
// committed row can live in `<name>.edb-wal` and not yet in `<name>.edb`, so
// the bytes the browser reads may be an older state of the workspace than the
// desktop is showing its user.
//
// Reading that stale copy is survivable. WRITING over it is not: a merge
// rewrites the whole `.edb`, and the desktop's next checkpoint would then lay
// its own WAL frames over a database that is no longer the one they came from.
// So a non-empty sidecar stops the merge.
//
// The sidecar is a sibling file, and a `FileSystemFileHandle` cannot see its
// siblings — only the FOLDER handle can. Where there is no folder grant the
// answer is "cannot tell", which reads the same as "no sidecar": absence of
// evidence must not become an error message, or a user who opened a single file
// through the picker would be refused a merge for no reason.

import { ensureWritable, rememberedFolder } from './file-handle.js';

/** SQLite's own naming: the write-ahead log sits next to the database. */
const WAL_SUFFIX = '-wal';

/**
 * How many bytes are waiting in `<file>-wal`, or null when there is no answer.
 *
 * Zero and null are different and the caller must treat them so: zero is a
 * checkpointed sidecar (`wal_checkpoint(TRUNCATE)` leaves the file at length 0)
 * and means the `.edb` is complete; null means this browser cannot see the
 * folder and has no idea.
 */
export async function walBytesBeside(dir: FileSystemDirectoryHandle, file: string): Promise<number | null> {
  try {
    const handle = await dir.getFileHandle(`${file}${WAL_SUFFIX}`);
    return (await handle.getFile()).size;
  } catch {
    // `NotFoundError` is the ordinary case — no sidecar, so nothing is pending.
    // Anything else (a revoked grant, a folder that moved) is genuinely unknown.
    return null;
  }
}

/**
 * The same question without a folder in hand: resolve the remembered one first.
 *
 * Never prompts. `workspaceFolder()` would open a picker where the grant has
 * lapsed, and a picker in the middle of "may I compare these two copies" is a
 * question about the wrong thing.
 */
export async function pendingWalBytes(file: string): Promise<number | null> {
  try {
    const dir = await rememberedFolder();
    if (!dir || !(await ensureWritable(dir, false))) return null;
    return await walBytesBeside(dir, file);
  } catch {
    // This is a precondition, not the work. A folder handle that cannot answer
    // — no permission API on it, a revoked grant, private mode with no handle
    // store — must not be the thing that stops a merge the user asked for.
    return null;
  }
}

/**
 * What to tell the user about a file another process is holding open.
 *
 * Named after the desktop app because that is the only thing that writes one of
 * these — the browser's own saves go through `TRUNCATE` and leave no sidecar.
 */
export function describePendingWal(file: string, bytes: number): string {
  const kb = Math.max(1, Math.round(bytes / 1024));
  return (
    `${file} is open in the desktop app right now — ${kb} KB of its newest changes are still in ${file}${WAL_SUFFIX} and not yet in the file itself.\n\n` +
    `Comparing would work from an older copy, and merging would write over what the desktop is holding. Close the workspace in the desktop app, then try again.`
  );
}
