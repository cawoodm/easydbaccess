import type {
  DataCollection,
  DataStore,
  RowCollectionProvider,
  RowSourceCtx,
  Row,
  Table,
} from '@easydb/shared';

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
  return {
    ...base,
    rows(tableId: string): DataCollection<Row> {
      const table = tableById(tableId);
      const source = table?.source;
      if (source) {
        const provider = providers.get(source.type);
        // `table` is non-null here: `source` came off it.
        if (provider) return provider.create(table, ctx);
      }
      return base.rows(tableId);
    },
  };
}
