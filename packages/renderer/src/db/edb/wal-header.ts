// packages/renderer/src/db/edb/wal-header.ts
//
// The two bytes that decide whether the browser can open a file the desktop
// wrote.
//
// `journal_mode` is not a connection setting. It is recorded IN the database
// header — bytes 18 and 19, the write and read format versions — and `2` there
// means WAL. So the desktop's `PRAGMA journal_mode = WAL`
// (`electron/src/sqlite-store.ts`) marks the `.edb` itself, permanently: a
// checkpoint folds the `-wal` sidecar back in and may delete it, but the header
// still says WAL, and every later reader has to cope with that.
//
// The browser cannot. It opens a `.edb` two ways and neither can host a WAL:
//
//   * `sqlite3_deserialize` into a throwaway — there is no file, so there can be
//     no `-wal` and no `-shm`;
//   * `opfs-sahpool` — its files have no shared memory either (see
//     `substrate.ts`, which is why the pooled database runs on `TRUNCATE`).
//
// SQLite's answer in both cases is `SQLITE_CANTOPEN` — "unable to open database
// file", naming a file that is right there and perfectly readable. That was the
// whole bug: a workspace opened once on the desktop could no longer be compared,
// adopted or even listed in the browser, and the error said nothing about why.
//
// The fix is to write `1` — a rollback journal — over those two bytes before the
// bytes reach SQLite. It is sound because the main database file is a complete,
// self-consistent database at its last checkpoint whatever mode the header
// claims; the mode only says where the NEXT writer would put its journal, and
// the next writer here is a copy in this browser that will use its own.
//
// What it cannot do is invent the commits still sitting in a `-wal` sidecar.
// That is a separate question with a separate answer — see `wal-sidecar.ts`.

/** `SQLite format 3\0`, the first sixteen bytes of every SQLite database. */
const MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

/** Nothing shorter than this is a database; the header is 100 bytes. */
const HEADER_BYTES = 100;

/** File format write version, and the read version right after it. */
const WRITE_VERSION = 18;
const READ_VERSION = 19;

const WAL = 2;
const ROLLBACK = 1;

/** Does this look like a SQLite database at all? */
export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.byteLength < HEADER_BYTES) return false;
  return MAGIC.every((b, i) => bytes[i] === b);
}

/** Is this database's header marked WAL — the state the browser cannot open? */
export function isWalMode(bytes: Uint8Array): boolean {
  if (!isSqliteFile(bytes)) return false;
  return bytes[WRITE_VERSION] === WAL || bytes[READ_VERSION] === WAL;
}

/**
 * Mark these bytes as a rollback-journal database, IN PLACE.
 *
 * Returns whether anything changed, so a caller can say so; most files are not
 * WAL and pay two array reads.
 *
 * In place, and not a copy, because these are whole databases: the caller is a
 * worker that has just received the bytes by structured clone and owns them
 * outright, and duplicating a 600 MB buffer to edit two bytes of it would be
 * the most expensive line in the app. Anything that is not a SQLite file is
 * left exactly as it is — `importDb` and `sqlite3_deserialize` both have their
 * own opinions about such a file and those are better errors than one from
 * here.
 */
export function clearWalHeader(bytes: Uint8Array): boolean {
  if (!isWalMode(bytes)) return false;
  bytes[WRITE_VERSION] = ROLLBACK;
  bytes[READ_VERSION] = ROLLBACK;
  return true;
}
