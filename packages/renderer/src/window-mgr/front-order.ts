/**
 * Monotonic front-rank source, SHARED by both table windows (`table-window-manager.ts`)
 * and view windows (`view-window-manager.ts`).
 *
 * `Date.now()` alone collides when several panels are fronted within the same
 * millisecond (a bulk restack, or panels opened back-to-back), tying their `z`
 * — and a tie loses the stacking order on the next reload/pull. This counter
 * only ever increases, so every stamp is unique and strictly ordered while
 * still tracking wall-clock time for cross-session comparisons.
 *
 * It MUST be shared across tables and views rather than one counter per kind:
 * the global restack (`restack.ts`) sorts a MERGED list of table + view
 * entries by this rank, so a table fronted a moment before a view (or vice
 * versa) has to compare correctly against it. Two independent counters could
 * hand out the same rank to a table and a view fronted moments apart, and the
 * merged sort would then have no way to tell which was actually later.
 */
let lastFrontZ = 0;

export function nextFrontZ(): number {
  lastFrontZ = Math.max(Date.now(), lastFrontZ + 1);
  return lastFrontZ;
}
