import { beforeAll, describe, expect, it } from 'vitest';
import { clearWalHeader, isSqliteFile, isWalMode } from '../../../packages/renderer/src/db/edb/wal-header.js';

const MAGIC = 'SQLite format 3\0';

/** A 100-byte SQLite header with the journal mode the caller asks for. */
function header(mode: 'wal' | 'rollback' = 'rollback'): Uint8Array {
  const bytes = new Uint8Array(100);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  bytes[18] = mode === 'wal' ? 2 : 1;
  bytes[19] = mode === 'wal' ? 2 : 1;
  return bytes;
}

describe('isSqliteFile', () => {
  it('knows a database by its first sixteen bytes', () => {
    expect(isSqliteFile(header())).toBe(true);
  });

  it('refuses anything shorter than a header, so a truncated file is not read as one', () => {
    expect(isSqliteFile(header().slice(0, 99))).toBe(false);
  });

  it('refuses a file that is not a database at all', () => {
    expect(isSqliteFile(new Uint8Array(200))).toBe(false);
  });
});

describe('isWalMode', () => {
  it('reports the mode the desktop leaves in the header', () => {
    expect(isWalMode(header('wal'))).toBe(true);
  });

  it('says no for the rollback journal the browser writes', () => {
    expect(isWalMode(header('rollback'))).toBe(false);
  });

  it('says no for something that is not a database, rather than reading byte 18 of it', () => {
    const notADatabase = new Uint8Array(200);
    notADatabase[18] = 2;
    expect(isWalMode(notADatabase)).toBe(false);
  });
});

describe('clearWalHeader', () => {
  it('rewrites both version bytes, which is what stops SQLITE_CANTOPEN', () => {
    const bytes = header('wal');
    expect(clearWalHeader(bytes)).toBe(true);
    expect([bytes[18], bytes[19]]).toEqual([1, 1]);
    expect(isWalMode(bytes)).toBe(false);
  });

  it('leaves a rollback-journal file untouched and says it changed nothing', () => {
    const bytes = header('rollback');
    expect(clearWalHeader(bytes)).toBe(false);
    expect([bytes[18], bytes[19]]).toEqual([1, 1]);
  });

  it('touches nothing outside the two bytes — the rest of the database is the database', () => {
    const bytes = header('wal');
    bytes[16] = 0x10; // page size, as an example of a field that must survive
    bytes[20] = 0x20;
    clearWalHeader(bytes);
    expect([bytes[16], bytes[20]]).toEqual([0x10, 0x20]);
  });

  it('stands aside for a file that is not a database, leaving its own error to be raised', () => {
    const notADatabase = new Uint8Array(200);
    notADatabase[18] = 2;
    expect(clearWalHeader(notADatabase)).toBe(false);
    expect(notADatabase[18]).toBe(2);
  });
});

/**
 * The bug itself, against the engine the browser really runs.
 *
 * The unit tests above pin two bytes. This pins what those two bytes DO: a
 * database whose header says WAL cannot be deserialized at all, and the error
 * SQLite gives — `SQLITE_CANTOPEN: unable to open database file` — names a file
 * that was read perfectly well a moment earlier. That mismatch is what made the
 * reported bug unreadable, and it is why the fix belongs before SQLite sees the
 * bytes rather than in a nicer error message afterwards.
 *
 * sqlite-wasm ships a Node entry, so this runs under plain vitest — no browser,
 * no worker, no OPFS. Same as `wasm-driver.test.ts`.
 */
describe('a WAL-marked database, in the real engine', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sqlite3: any;

  beforeAll(async () => {
    const mod = await import('@sqlite.org/sqlite-wasm');
    sqlite3 = await mod.default();
  });

  /** A small database, marked the way the desktop's WAL pragma leaves a file. */
  function walDatabaseBytes(): Uint8Array {
    const db = new sqlite3.oo1.DB(':memory:');
    try {
      db.exec(`CREATE TABLE t(a); INSERT INTO t VALUES ('hello')`);
      const bytes: Uint8Array = sqlite3.capi.sqlite3_js_db_export(db);
      bytes[18] = 2;
      bytes[19] = 2;
      return bytes;
    } finally {
      db.close();
    }
  }

  /** Read the row back out of a deserialized copy, or throw the way SQLite does. */
  function readThrough(bytes: Uint8Array): unknown[] {
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    const probe = new sqlite3.oo1.DB();
    try {
      probe.checkRc(sqlite3.capi.sqlite3_deserialize(probe.pointer, 'main', pointer, bytes.byteLength, bytes.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE));
      return probe.selectObjects('SELECT a FROM t');
    } finally {
      try {
        probe.close();
      } catch {
        /* a connection that never opened has nothing to close */
      }
    }
  }

  it('refuses to open, with the error the user reported', () => {
    expect(() => readThrough(walDatabaseBytes())).toThrow(/SQLITE_CANTOPEN|unable to open database file/);
  });

  it('opens and reads once the header is neutralised', () => {
    const bytes = walDatabaseBytes();
    expect(clearWalHeader(bytes)).toBe(true);
    expect(readThrough(bytes)).toEqual([{ a: 'hello' }]);
  });
});
