/**
 * One tab owns the database.
 *
 * This is not an OPFS detail, and it is elected BEFORE the substrate is chosen,
 * because both substrates need it for different reasons:
 *
 * - The `opfs-sahpool` VFS takes exclusive sync access handles on its pool
 *   files, origin-wide. A second tab's install simply fails.
 * - The memory fallback has the same hazard less visibly: two tabs would each
 *   hold their own copy of the database and each write whole-database
 *   snapshots, so the last one to write silently wins.
 *
 * Web Locks rather than a `localStorage` flag: the lock is released by the
 * browser when the tab dies, so there is no stale-lock cleanup and no timeout to
 * tune. The lock is held by a promise that never resolves, which is the
 * documented way to hold one for a page's lifetime.
 *
 * A browser without `navigator.locks` is treated as the owner. That is the same
 * risk it has today, and refusing to start would be a worse answer than the
 * status quo.
 */

const LOCK_NAME = 'easydb:store';

/**
 * Try to become the owning tab.
 *
 * Returns immediately: `ifAvailable` makes the request resolve with a null lock
 * rather than queueing, so a follower can render its notice at once instead of
 * hanging on a lock the owner will hold until it closes.
 *
 * The returned promise resolving does NOT release the lock — the callback's
 * promise is still pending, and stays pending for the life of the tab.
 */
export async function claimStoreOwnership(): Promise<boolean> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return true;
  return new Promise<boolean>((resolve) => {
    void locks
      .request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Held for the tab's lifetime when we won; released immediately when we
        // did not, because there is nothing to hold.
        return lock === null ? Promise.resolve() : new Promise<never>(() => {});
      })
      // A rejected request must not leave the caller awaiting forever; assume
      // ownership, matching the no-Web-Locks case above.
      .catch(() => resolve(true));
  });
}
