import { describe, expect, it } from 'vitest';
import type { SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { renameInPool } from '../../../packages/renderer/src/db/edb/substrate.js';

/**
 * Moving a pooled database from one name to another.
 *
 * The one caller is the boot that renames this browser's own database from
 * `local.edb` to `index.edp` (see `db/edb/session.ts`), which runs once on the
 * first load after the upgrade and must not lose a workspace doing it.
 *
 * The pool is faked: `renameInPool` only ever touches four of its methods, and the
 * real one needs OPFS, a worker and `createSyncAccessHandle` — none of which exist
 * in a Vitest run. What matters here is the ORDER, which is what makes a failure
 * half-way harmless.
 */

interface Recorded {
  imported: Array<{ name: string; bytes: Uint8Array }>;
  unlinked: string[];
  grown: number;
}

function fakePool(files: Record<string, Uint8Array>): { pool: SAHPoolUtil; log: Recorded } {
  const log: Recorded = { imported: [], unlinked: [], grown: 0 };
  const pool = {
    getFileNames: () => Object.keys(files),
    getFileCount: () => Object.keys(files).length,
    getCapacity: () => 6,
    addCapacity: async (n: number) => {
      log.grown += n;
      return 6 + n;
    },
    exportFile: async (path: string) => {
      const bytes = files[path];
      if (!bytes) throw new Error(`no such file: ${path}`);
      return bytes;
    },
    importDb: async (path: string, data: Uint8Array) => {
      files[path] = data;
      log.imported.push({ name: path, bytes: data });
      return data.byteLength;
    },
    unlink: (path: string) => {
      const had = path in files;
      delete files[path];
      log.unlinked.push(path);
      return had;
    },
  } as unknown as SAHPoolUtil;
  return { pool, log };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('renameInPool', () => {
  it('copies the database to the new name and drops the old one', async () => {
    const files: Record<string, Uint8Array> = { '/local.edb': BYTES };
    const { pool, log } = fakePool(files);

    expect(await renameInPool(pool, 'local.edb', 'index.edp')).toBe(true);
    expect(Object.keys(files)).toEqual(['/index.edp']);
    expect(log.imported).toEqual([{ name: '/index.edp', bytes: BYTES }]);
    expect(log.unlinked).toEqual(['/local.edb']);
  });

  it('imports BEFORE unlinking, so a failure half-way leaves the old name intact', async () => {
    const files: Record<string, Uint8Array> = { '/local.edb': BYTES };
    const { pool } = fakePool(files);
    const order: string[] = [];
    const patched = {
      ...pool,
      importDb: async (path: string, data: Uint8Array) => {
        order.push(`import ${path}`);
        files[path] = data as Uint8Array;
        return 4;
      },
      unlink: (path: string) => {
        order.push(`unlink ${path}`);
        delete files[path];
        return true;
      },
    } as unknown as SAHPoolUtil;

    await renameInPool(patched, 'local.edb', 'index.edp');
    expect(order).toEqual(['import /index.edp', 'unlink /local.edb']);
  });

  it('does nothing when there is no database under the old name', async () => {
    // Every boot after the first, and every fresh browser.
    const files: Record<string, Uint8Array> = { '/index.edp': BYTES };
    const { pool, log } = fakePool(files);

    expect(await renameInPool(pool, 'local.edb', 'index.edp')).toBe(false);
    expect(log.imported).toEqual([]);
    expect(log.unlinked).toEqual([]);
  });

  it('leaves both alone when the new name is already taken', async () => {
    // Never overwrite the database in use with a leftover under the old name: the
    // index has been the live database since the upgrade, the old file has not.
    const live = new Uint8Array([9, 9]);
    const files: Record<string, Uint8Array> = { '/local.edb': BYTES, '/index.edp': live };
    const { pool, log } = fakePool(files);

    expect(await renameInPool(pool, 'local.edb', 'index.edp')).toBe(false);
    expect(files['/index.edp']).toBe(live);
    expect(files['/local.edb']).toBe(BYTES);
    expect(log.unlinked).toEqual([]);
  });

  it('grows the pool when there is no free slot to import into', async () => {
    // A slot is a file, not a quota — see `ensureRoomToImport`. Without this the
    // rename throws "No available handles to import to." on a full pool.
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) files[`/f${i}.edb`] = BYTES;
    files['/local.edb'] = BYTES;
    const { pool, log } = fakePool(files);

    expect(await renameInPool(pool, 'local.edb', 'index.edp')).toBe(true);
    expect(log.grown).toBeGreaterThan(0);
  });

  it('accepts names with or without a leading slash', async () => {
    const files: Record<string, Uint8Array> = { '/local.edb': BYTES };
    const { pool } = fakePool(files);

    expect(await renameInPool(pool, '/local.edb', '/index.edp')).toBe(true);
    expect(Object.keys(files)).toEqual(['/index.edp']);
  });
});
