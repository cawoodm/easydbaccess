/**
 * Serialize the geometry read-modify-writes of ONE window.
 *
 * jsPanel fires several callbacks for a single user action — maximizing a panel
 * both fronts it (`onfronted` → stamp the z rank) and changes its status
 * (`onstatuschange` → save the flags). Each handler reads `windowGeometry`,
 * changes its own field and patches the whole object back, so when they overlap
 * the slower reader writes stale values over the other's field: the maximized
 * flag was lost this way, and the front-order z before it.
 *
 * Chaining the jobs per window key makes the second one read what the first
 * wrote. Keys are namespaced by the caller (`table:<id>`, `view:<id>`).
 */

const chains = new Map<string, Promise<void>>();

export function queueGeometryWrite(key: string, job: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Run `job` whether the previous one resolved or rejected — a failed write
  // (deleted table) must not stall every later write for this window.
  const next = prev.then(job, job);
  chains.set(key, next);
  void next.finally(() => {
    // Drop the chain once it is idle so a long session does not keep one
    // resolved promise per window that was ever moved.
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}
