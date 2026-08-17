/**
 * Which table a write touched, for a scoped `changed` broadcast.
 *
 * A store broadcasts "collection X changed" after every write, and every
 * subscriber of X re-runs its query. For `rows` that is far too broad: a
 * subscriber is a `rows(tableId)` view, and waking all of them makes a
 * multi-table import quadratic — finishing each of `northwind.db`'s 13 tables
 * made all 13 panels re-fetch, one of them holding 609k rows.
 *
 * So the scope is derived HERE, from what the write returned, and both
 * transports use the same rule: the browser worker and the Electron main
 * process. Deriving it from the REQUEST instead does not work — a `remove` or
 * `bulkRemove` request names row ids and nothing else, and a `patch` request
 * carries only the fields being changed, so none of the three can say which
 * table they hit until the store has looked.
 *
 * `undefined` means unscoped: every subscriber re-reads. That is the honest
 * answer for a non-row collection, for a no-op write, and for a bulk delete
 * spanning several tables — a scope names one table, so the alternative would be
 * to pick one and leave the others stale.
 */

/** The one collection whose subscribers are per-table rather than per-collection. */
export const ROW_COLLECTION = 'rows';

/**
 * Every collection a subscriber can be watching.
 *
 * Needed because raw SQL can change anything and reports nothing about what it
 * touched — it could have rewritten the registry itself — so a `runSql` write
 * announces all of them. Anything narrower would leave a stale panel on screen
 * after a hand-written UPDATE. Both transports need this, which is why it is
 * here rather than in either one's protocol.
 */
export const ALL_COLLECTIONS = ['workspaces', 'tables', 'rows', 'settings', 'plugins', 'viewTemplates', 'viewInstances'] as const;

/** A write's result, as much of it as this rule reads. */
function tableIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value; // `remove` returns the table id itself
  if (value && typeof value === 'object' && 'tableId' in value) {
    const id = (value as { tableId?: unknown }).tableId;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/**
 * @param coll   the collection the write named
 * @param result what the store returned — a doc, a list of docs, a table id, or
 *               a list of table ids, depending on the operation
 */
export function changeScopeOf(coll: string, result: unknown): string | undefined {
  if (coll !== ROW_COLLECTION) return undefined;
  if (!Array.isArray(result)) return tableIdOf(result);
  // A batch scopes only when every member agrees; one dissenter and the whole
  // broadcast has to go wide, because there is room for a single table in it.
  let only: string | undefined;
  for (const item of result) {
    const tableId = tableIdOf(item);
    if (tableId === undefined) return undefined;
    if (only === undefined) only = tableId;
    else if (only !== tableId) return undefined;
  }
  return only;
}
