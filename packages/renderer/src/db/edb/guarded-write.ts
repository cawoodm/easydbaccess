// packages/renderer/src/db/edb/guarded-write.ts
//
// One door for every write to a file the USER owns.
//
// `writeBytes` is the primitive and stays one: it opens a writable and closes it.
// This is the door in front of it, and the rule it enforces is the one in
// `empty-write.ts` — a write that would leave an empty database where a full one
// was has to be confirmed twice, in red, or it does not happen.
//
// Why here and not at each call site: there were five places that wrote a user's
// file, each with its own idea of what it was allowed to do, and the reported data
// loss came through one of them. A rule that lives at the door cannot be forgotten
// by the sixth.
//
// The cost is paid only in the dangerous case. The bytes about to be written are
// already in memory, so measuring THEM is free; the file on disk is read and
// deserialized only when those bytes turn out to hold nothing, which is the one
// case worth a whole-file read.

import { writeBytes } from './file-handle.js';
import { holdingOf, holdsNothing, wouldWipe, NOTHING, type Holding } from './empty-write.js';

/** What the guard needs from the world, so it can be tested without either. */
export interface WriteGuardDeps {
  /** Read a database's workspaces and their table/view counts. `peekWorkspaces`. */
  peek(bytes: Uint8Array): Promise<readonly { tables: number; views: number }[]>;
  /** Ask the two-step red question. Anything but an explicit double yes is false. */
  confirm(file: string, onDisk: Holding, writing: Holding): Promise<boolean>;
  /** Told when a write was stopped, so the caller can say so. Optional. */
  onRefused?: ((file: string, onDisk: Holding) => void) | undefined;
}

/** Where the bytes came from, for the log line when a wipe is stopped. */
export interface WriteContext {
  /** The file name, as the user knows it. Shown in the question. */
  file: string;
  /** Which route is writing — `Save`, `Sync`, `Giving beta.edb its own file`. */
  reason: string;
}

/**
 * The guard the app installed, if it has.
 *
 * A module-level slot rather than a parameter every caller threads through,
 * because the callers are five layers apart — the Save button, the folder sync,
 * `new-file.ts` building a file from a picker — and the one thing they must share
 * is exactly this. `edb-file.ts` installs it at `init`, since it owns the dialog
 * and the live worker the peek needs.
 */
let installed: WriteGuardDeps | null = null;

export function installWriteGuard(deps: WriteGuardDeps): void {
  installed = deps;
}

/** For tests, which must not leak a guard into the next one. */
export function clearWriteGuard(): void {
  installed = null;
}

/**
 * What happens with no guard installed: the write goes ahead, unmeasured.
 *
 * That is exactly today's behaviour, and it is the right default for the one
 * build that reaches this code without `edb-file.ts` — the desktop, whose files
 * are the `electron-db` plugin's business. A default that REFUSED would turn a
 * missing installation into an app that cannot save at all, which is a worse
 * failure than the one this module exists to prevent.
 */
const UNGUARDED: WriteGuardDeps = {
  peek: () => Promise.resolve([{ tables: 1, views: 0 }]),
  confirm: () => Promise.resolve(true),
};

/**
 * What the file holds now. `NOTHING` when it cannot be read.
 *
 * A file that cannot be read or is not one of our databases holds nothing as far
 * as this guard is concerned, so the write goes ahead: a new file is exactly that
 * case, and a guard that blocked every first save would be turned off within an
 * hour. The risk is one-sided on purpose — the guard exists to stop a write over
 * KNOWN work, not to stop writes it cannot reason about.
 */
async function holdingOnDisk(handle: FileSystemFileHandle, peek: WriteGuardDeps['peek']): Promise<Holding> {
  try {
    const file = await handle.getFile();
    if (file.size === 0) return NOTHING;
    return holdingOf(await peek(new Uint8Array(await file.arrayBuffer())));
  } catch {
    return NOTHING;
  }
}

/**
 * Write the bytes to a file the user owns, unless doing so would wipe it.
 *
 * Answers whether the bytes were written. A `false` is a refusal by the user, not
 * a failure: the caller must treat it as "nothing happened" — no stamp recorded,
 * no "saved" toast, and above all no marking the workspace clean, which would
 * turn a stopped write into the same data loss one reload later.
 */
export async function writeUserBytes(handle: FileSystemFileHandle, bytes: Uint8Array, ctx: WriteContext, override?: WriteGuardDeps): Promise<boolean> {
  const deps = override ?? installed ?? UNGUARDED;
  const writing = holdingOf(await deps.peek(bytes));
  // The overwhelmingly common case: we are writing work. Nothing to ask, and the
  // file on disk is never read.
  if (!holdsNothing(writing)) {
    await writeBytes(handle, bytes);
    return true;
  }
  const onDisk = await holdingOnDisk(handle, deps.peek);
  if (!wouldWipe(onDisk, writing)) {
    await writeBytes(handle, bytes);
    return true;
  }
  // eslint-disable-next-line no-console
  console.warn(`[edb] ${ctx.reason}: refusing to write an empty workspace over ${ctx.file} (${onDisk.tables} tables, ${onDisk.views} views) without confirmation`);
  if (!(await deps.confirm(ctx.file, onDisk, writing))) {
    deps.onRefused?.(ctx.file, onDisk);
    return false;
  }
  await writeBytes(handle, bytes);
  return true;
}
