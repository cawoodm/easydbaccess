// packages/renderer/src/db/edb/file-stamp.ts
//
// What this browser last knew about a `.edb` on disk.
//
// The problem: a file in the workspace folder has more than one writer. Two tabs
// on different origins — `localhost:5190` and `localhost:5191` are different
// origins — share the folder and nothing else: the OPFS pool holding the imported
// copy, the IndexedDB handle store and the folder index are all origin-scoped, so
// each origin holds its own copy of the same file. The same is true of another
// browser profile, or a folder synced between machines.
//
// Nothing about a copy says whether the file has moved on since it was made: the
// pool exposes no timestamps and the FileSystem Access API has no change events.
// So we record what the file looked like at the moment our copy and it agreed —
// on import, and after every write — and compare that with the file now.
//
// Device-local, and a CACHE. No stamp, or one from another version of the app,
// answers `unknown`, and every caller treats that as "leave both copies alone".

/** What can be read about a file without reading the file. */
export interface FileFacts {
  mtime: number;
  size: number;
}

export interface FileStamp extends FileFacts {
  /**
   * Our copy holds changes this file does not.
   *
   * Recorded rather than derived: the autosave policy's dirty flag lives in
   * memory and the decisions that need this run at BOOT, before any of that
   * exists (see `space-adopt.ts`).
   */
  dirty?: boolean | undefined;
}

/** How our copy of a file stands against the file itself. */
export type FileVerdict =
  /** The file is as we left it. Nothing to do. */
  | 'same'
  /** Something else wrote the file. Ours is behind. */
  | 'file-newer'
  /** Both moved: the file was written AND we hold unsaved changes. */
  | 'conflict'
  /** We hold unsaved changes and the file has not moved. Ours is ahead. */
  | 'ahead'
  /** Never agreed, or the file is gone. Nothing can be concluded. */
  | 'unknown';

const KEY = 'eda:fileStamps';

function readAll(): Record<string, FileStamp> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, FileStamp>) : {};
  } catch {
    return {}; // private mode, or a value from another version
  }
}

function writeAll(all: Record<string, FileStamp>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode or out of room: every verdict becomes `unknown`, which changes nothing */
  }
}

export function readStamp(file: string): FileStamp | null {
  const s = readAll()[file];
  return s && typeof s.mtime === 'number' && typeof s.size === 'number' ? s : null;
}

/** Our copy and the file are the same right now — an import, or a write we just made. */
export function recordAgreement(file: string, facts: FileFacts): void {
  const all = readAll();
  all[file] = { mtime: facts.mtime, size: facts.size };
  writeAll(all);
}

/**
 * Our copy has moved on from the file.
 *
 * Only meaningful once there IS a stamp: a file we have never agreed with is
 * `unknown` either way, and inventing a stamp for it would claim knowledge of a
 * file nobody has read.
 */
export function markLocalChanges(file: string): void {
  const all = readAll();
  const stamp = all[file];
  if (!stamp) return;
  if (stamp.dirty === true) return;
  all[file] = { ...stamp, dirty: true };
  writeAll(all);
}

/**
 * We have just written our copy over the file, so we know both: what the file
 * looks like now, and that it is not a copy of this database.
 *
 * The honest stamp after an Overwrite. `clearStamp` was used here, which read as
 * modest — we can no longer describe the relationship — but it BLINDED the tab:
 * with no stamp every later verdict is `unknown`, so the one machine that had just
 * pushed its work out could never again be told that another had pushed theirs.
 * Recording the file's facts with `dirty` keeps the pair comparable, and the next
 * outside write comes back as `conflict` rather than as silence.
 */
export function recordDivergence(file: string, facts: FileFacts): void {
  const all = readAll();
  all[file] = { mtime: facts.mtime, size: facts.size, dirty: true };
  writeAll(all);
}

/** Forget what we knew, so the next comparison is `unknown` and touches nothing. */
export function clearStamp(file: string): void {
  const all = readAll();
  if (!(file in all)) return;
  delete all[file];
  writeAll(all);
}

export function factsOf(file: File): FileFacts {
  return { mtime: file.lastModified, size: file.size };
}

/** The file's facts, or null when it cannot be read (gone, or permission lapsed). */
export async function factsOfHandle(handle: FileSystemFileHandle): Promise<FileFacts | null> {
  try {
    return factsOf(await handle.getFile());
  } catch {
    return null;
  }
}

/**
 * Compare a recorded stamp with the file as it is now.
 *
 * `mtime` AND `size`, because a file written twice inside the same millisecond is
 * a real case for a program writing it — and because a filesystem that rounds
 * timestamps still changes the size when the contents do.
 */
export function compareWithFile(stamp: FileStamp | null, current: FileFacts | null): FileVerdict {
  if (!stamp || !current) return 'unknown';
  const moved = current.mtime !== stamp.mtime || current.size !== stamp.size;
  if (stamp.dirty === true) return moved ? 'conflict' : 'ahead';
  return moved ? 'file-newer' : 'same';
}

/** Convenience for the two callers that only ask about one file by name. */
export async function verdictFor(file: string, handle: FileSystemFileHandle | null): Promise<FileVerdict> {
  return compareWithFile(readStamp(file), handle ? await factsOfHandle(handle) : null);
}
