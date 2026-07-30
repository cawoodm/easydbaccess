/**
 * Remember that a panel was maximized when the user minimizes it, so restoring
 * it from the dock goes back to maximized instead of to the normal rect.
 *
 * jsPanel drops that fact itself: `minimize()` on a maximized panel and then
 * `normalize()` lands in the normal state, and `onstatuschange` reports only the
 * NEW status, so a caller cannot tell "restored from maximized" from "restored
 * from normal" either. We therefore track the previous status per panel here.
 *
 * Both window managers (table panels and view windows) share this, so the two
 * kinds behave the same. Keys are namespaced by the caller (`table:<id>`,
 * `view:<id>`) because a table id and a view-instance id are both uuids.
 */

type MinimalPanel = {
  status: 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
  maximize?: () => void;
};

const lastStatus = new Map<string, string>();
const wasMaximized = new Set<string>();

/**
 * Call from `onstatuschange` for every status. On the way down it records a
 * maximized→minimized step. On the way back up it re-maximizes, one tick later
 * so jsPanel can finish the transition it is currently reporting.
 */
export function trackMaximized(key: string, panel: MinimalPanel): void {
  const prev = lastStatus.get(key);
  lastStatus.set(key, panel.status);
  if (panel.status === 'minimized') {
    if (prev === 'maximized') wasMaximized.add(key);
    return;
  }
  if (panel.status === 'maximized') {
    wasMaximized.delete(key);
    return;
  }
  // Anything else (normalized, smallified) is the user coming back out of the
  // dock. Only re-maximize when we put the flag there.
  if (panel.status === 'normalized' && wasMaximized.delete(key)) {
    queueMicrotask(() => panel.maximize?.());
  }
}

/**
 * Seed the flag at boot for a window whose stored geometry says minimized AND
 * maximized — it was maximized when the user minimized it in an earlier
 * session, so the first restore must maximize as well.
 */
export function primeMaximized(key: string): void {
  wasMaximized.add(key);
  lastStatus.set(key, 'minimized');
}

/** Drop a closed panel's state so a reopened window starts clean. */
export function forgetMaximized(key: string): void {
  lastStatus.delete(key);
  wasMaximized.delete(key);
}
