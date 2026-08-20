import { test, expect } from './fixtures.js';

/**
 * TODO § Quick Wins
 * - Opening a workspace file still works once several are in the browser's pool.
 *
 * The `opfs-sahpool` VFS holds a FIXED number of file slots — six to begin with,
 * which is a database and its journal apiece — and the count is persistent: every
 * file the app imports stays in the pool for good. So the third or fourth `.edb`
 * a user opened threw
 *
 *     Uncaught (in promise) Error: No available handles to import to.
 *
 * out of the worker, three times over, and `?space=NAME` came up with nothing.
 * Nothing was wrong with the file, the workspace or the folder.
 *
 * The pool grows on demand now (`ensureRoomToImport`). A slot is a file rather
 * than a quota — the pool reserves no space — so a bigger pool costs nothing
 * until it is used, which is why growing beats deciding which of the user's
 * workspaces to evict.
 */

/** More imports than the pool's initial capacity, journals included. */
const IMPORTS = 8;

test('importing more workspace files than the pool started with', async ({ page }) => {
  // The live session already holds the local database in the pool. Everything
  // below goes through that same worker, because the pool is exclusive to it.
  const result = await page.evaluate(async (count) => {
    const { createEdbBridge } = (await import('/src/db/edb/worker-bridge.ts')) as {
      createEdbBridge: () => { open(b: Uint8Array | null, n: string): Promise<unknown>; export(): Promise<Uint8Array>; terminate(): void };
    };
    const { edbBridge } = (await import('/src/db/edb/active-bridge.ts')) as {
      edbBridge: () => { importBytes(name: string, bytes: Uint8Array): Promise<void> } | null;
    };

    // One real, valid `.edb` to import over and over. Built in a throwaway worker
    // that never gets the pool, so this is only a source of bytes.
    const scratch = createEdbBridge();
    let bytes: Uint8Array;
    try {
      await scratch.open(null, 'capacity-source.edb');
      bytes = await scratch.export();
    } finally {
      scratch.terminate();
    }

    const live = edbBridge();
    if (!live) return { error: 'no live session — the pool is not in play' };
    const done: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = `capacity-probe-${i}.edb`;
      try {
        await live.importBytes(name, bytes);
        done.push(name);
      } catch (err) {
        return { error: `${name}: ${err instanceof Error ? err.message : String(err)}`, done };
      }
    }
    return { done };
  }, IMPORTS);

  expect(result.error).toBeUndefined();
  expect(result.done).toHaveLength(IMPORTS);
});
