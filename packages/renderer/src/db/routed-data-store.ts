import type { DataCollection, DataStore, RowCollectionProvider, RowSourceCtx, Row, Table } from '@easydb/shared';

/**
 * Per-table row-collection routing (Phase 2a of the Datasette live connector).
 *
 * `createDataStore` returns a single Dexie-backed store whose `rows(tableId)`
 * always yields a local collection. This decorator sits in front of it and,
 * for tables that declare a `source`, delegates `rows(tableId)` to the
 * `RowCollectionProvider` registered for `source.type`. Everything else on the
 * store passes straight through.
 *
 * Invariant (verified by routed-data-store.test.ts): a table with no `source`,
 * or a `source` whose `type` has no registered provider, resolves to
 * `base.rows(tableId)` — byte-for-byte the same object the un-decorated store
 * would return. Registering a provider therefore cannot change how existing
 * local tables read or write.
 */
export interface RoutedDataStoreDeps {
  /** The underlying (Dexie) store. */
  base: DataStore;
  /** Registered providers, keyed by `RowCollectionProvider.type`. */
  providers: Map<string, RowCollectionProvider>;
  /**
   * Synchronous table lookup. `rows(tableId)` is called on user actions long
   * after the app has booted, so a cache primed from a `tables` subscription
   * is enough; a miss simply falls back to the local path.
   */
  tableById: (tableId: string) => Table | undefined;
  /** Context passed to `provider.create(table, ctx)`. */
  ctx: RowSourceCtx;
}

export function createRoutedDataStore(deps: RoutedDataStoreDeps): DataStore {
  const { base, providers, tableById, ctx } = deps;
  // Memoise the provider-backed collection per table. `rows(tableId)` is called
  // by every chrome component that touches a table (the grid subscribes AND
  // finds, the footer counts rows, search reads them). A local Dexie collection
  // is cheap to recreate, but a remote one holds a network-backed cache — giving
  // each caller its own instance would refetch on every call and, worse, fire a
  // burst of identical requests that bot-protection (datasette.io's Cloudflare)
  // blocks. Sharing one instance per table means one fetch, one cache, one set
  // of subscribers. Keyed by the source signature so a reconnect that changes
  // the config swaps in a fresh collection.
  const memo = new Map<string, { key: string; coll: DataCollection<Row> }>();
  return {
    ...base,
    rows(tableId: string): DataCollection<Row> {
      const table = tableById(tableId);
      const source = table?.source;
      if (source) {
        const provider = providers.get(source.type);
        // `table` is non-null here: `source` came off it.
        if (provider) {
          const key = JSON.stringify(source);
          const hit = memo.get(tableId);
          if (hit && hit.key === key) return hit.coll;
          const coll = provider.create(table, ctx);
          memo.set(tableId, { key, coll });
          return coll;
        }
      }
      memo.delete(tableId); // a table that lost its source no longer routes
      return base.rows(tableId);
    },
  };
}
