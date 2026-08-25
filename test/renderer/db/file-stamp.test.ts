import { beforeEach, describe, expect, it } from 'vitest';
import { clearStamp, compareWithFile, markLocalChanges, readStamp, recordAgreement, recordDivergence, type FileStamp } from '../../../packages/renderer/src/db/edb/file-stamp.js';

/**
 * What this browser last knew about a `.edb` on disk.
 *
 * The verdicts are the whole point: they are what lets a sync tell "another origin
 * wrote this file" from "we wrote it ourselves", without which two tabs sharing a
 * folder each keep re-opening their own stale copy.
 */

/** A `localStorage` that lives in this process only. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

beforeEach(() => {
  // The module reads `globalThis.localStorage` per call, so replacing it is enough.
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage(), configurable: true, writable: true });
});

describe('the stamp store', () => {
  it('remembers what a file looked like, per file', () => {
    recordAgreement('a.edb', { mtime: 10, size: 100 });
    recordAgreement('b.edb', { mtime: 20, size: 200 });

    expect(readStamp('a.edb')).toEqual({ mtime: 10, size: 100 });
    expect(readStamp('b.edb')).toEqual({ mtime: 20, size: 200 });
    expect(readStamp('c.edb')).toBeNull();
  });

  it('records local changes on top of a stamp, and a fresh agreement clears them', () => {
    recordAgreement('a.edb', { mtime: 10, size: 100 });
    markLocalChanges('a.edb');
    expect(readStamp('a.edb')?.dirty).toBe(true);

    // A save writes the file, so the two agree again — with nothing outstanding.
    recordAgreement('a.edb', { mtime: 11, size: 120 });
    expect(readStamp('a.edb')).toEqual({ mtime: 11, size: 120 });
  });

  it('will not invent a stamp for a file it has never read', () => {
    // Otherwise "we have unsaved changes to a file nobody has compared" would read
    // as a conflict with a file we know nothing about.
    markLocalChanges('never-seen.edb');
    expect(readStamp('never-seen.edb')).toBeNull();
  });

  it('clears one file without touching the others', () => {
    recordAgreement('a.edb', { mtime: 10, size: 100 });
    recordAgreement('b.edb', { mtime: 20, size: 200 });
    clearStamp('a.edb');
    expect(readStamp('a.edb')).toBeNull();
    expect(readStamp('b.edb')).not.toBeNull();
  });

  it('records a divergence, so the pair stays comparable after an Overwrite', () => {
    // The bug: an Overwrite used to CLEAR the stamp, which blinded the tab. Every
    // later verdict was `unknown`, so the machine that had just pushed its work out
    // could never be told that another had pushed theirs.
    recordAgreement('a.edb', { mtime: 10, size: 100 });
    recordDivergence('a.edb', { mtime: 30, size: 300 });

    expect(readStamp('a.edb')).toEqual({ mtime: 30, size: 300, dirty: true });
    // The file as it is now, plus "this database is not a copy of it" — so an
    // outside write comes back as a conflict rather than as silence.
    expect(compareWithFile(readStamp('a.edb'), { mtime: 30, size: 300 })).toBe('ahead');
    expect(compareWithFile(readStamp('a.edb'), { mtime: 31, size: 300 })).toBe('conflict');
  });

  it('records a divergence for a file it has never seen', () => {
    // Unlike `markLocalChanges`, this one HAS just read the file, so there is
    // something real to write down.
    recordDivergence('new.edb', { mtime: 5, size: 50 });
    expect(readStamp('new.edb')).toEqual({ mtime: 5, size: 50, dirty: true });
  });

  it('survives rubbish in the key rather than throwing', () => {
    globalThis.localStorage.setItem('eda:fileStamps', '{{not json');
    expect(readStamp('a.edb')).toBeNull();
    recordAgreement('a.edb', { mtime: 1, size: 2 });
    expect(readStamp('a.edb')).toEqual({ mtime: 1, size: 2 });
  });
});

describe('compareWithFile', () => {
  const clean: FileStamp = { mtime: 10, size: 100 };
  const dirty: FileStamp = { mtime: 10, size: 100, dirty: true };

  it('says nothing happened when the file is as we left it', () => {
    expect(compareWithFile(clean, { mtime: 10, size: 100 })).toBe('same');
  });

  it('says the file is newer when something else wrote it', () => {
    expect(compareWithFile(clean, { mtime: 11, size: 100 })).toBe('file-newer');
    // A write inside the same millisecond still changes the size.
    expect(compareWithFile(clean, { mtime: 10, size: 101 })).toBe('file-newer');
  });

  it('is a conflict when both sides moved', () => {
    expect(compareWithFile(dirty, { mtime: 11, size: 100 })).toBe('conflict');
  });

  it('is only "ahead" when we hold changes and the file stood still', () => {
    expect(compareWithFile(dirty, { mtime: 10, size: 100 })).toBe('ahead');
  });

  it('knows nothing without a stamp, or without a file', () => {
    expect(compareWithFile(null, { mtime: 10, size: 100 })).toBe('unknown');
    expect(compareWithFile(clean, null)).toBe('unknown');
  });
});
