import { describe, expect, it } from 'vitest';
import { describePendingWal, walBytesBeside } from '../../../packages/renderer/src/db/edb/wal-sidecar.js';

/** A folder holding the named files at the given sizes, and nothing else. */
function folder(sizes: Record<string, number>): FileSystemDirectoryHandle {
  return {
    async getFileHandle(name: string) {
      const size = sizes[name];
      if (size === undefined) throw new DOMException('not found', 'NotFoundError');
      return {
        async getFile() {
          return { size };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe('walBytesBeside', () => {
  it('reports what is waiting in the sidecar of a file the desktop has open', async () => {
    expect(await walBytesBeside(folder({ 'finances.edb-wal': 32768 }), 'finances.edb')).toBe(32768);
  });

  it('reports zero for a checkpointed sidecar — the file itself is complete', async () => {
    // `wal_checkpoint(TRUNCATE)` leaves the sidecar in place at length 0, so
    // zero and "no sidecar" must both read as nothing pending.
    expect(await walBytesBeside(folder({ 'finances.edb-wal': 0 }), 'finances.edb')).toBe(0);
  });

  it('answers null where there is no sidecar, rather than throwing at the caller', async () => {
    expect(await walBytesBeside(folder({}), 'finances.edb')).toBeNull();
  });

  it('does not mistake another workspace’s sidecar for this one’s', async () => {
    expect(await walBytesBeside(folder({ 'sales.edb-wal': 4096 }), 'finances.edb')).toBeNull();
  });
});

describe('describePendingWal', () => {
  it('names the file, the sidecar and the way out', () => {
    const message = describePendingWal('finances.edb', 32768);
    expect(message).toContain('finances.edb-wal');
    expect(message).toContain('32 KB');
    expect(message).toContain('desktop');
  });

  it('never rounds a non-empty sidecar down to nothing', () => {
    // "0 KB of changes are still pending" would read as a bug report about the
    // message rather than about the file.
    expect(describePendingWal('finances.edb', 12)).toContain('1 KB');
  });
});
