import { liveQuery, type Table as DexieTable } from 'dexie';
import type {
  DataCollection,
  DataStore,
  PluginRecord,
  Row,
  Setting,
  Table,
  Unsubscribe,
  Workspace,
} from '@easydb/shared';
import type { EasyDb } from './dexie-db.js';

/**
 * Dexie-backed DataStore. Implements `DataCollection<T>` from the plugin API;
 * plugins never see Dexie itself.
 *
 * Subscriptions use Dexie's `liveQuery`, which re-runs the query closure on
 * every write to the referenced table. Coarse, but chrome callers consume
 * the full result set anyway so the granularity doesn't matter.
 */
function wrap<T extends { id: string } | { url: string } | { key: string }>(
  coll: DexieTable<T, string>,
): DataCollection<T> {
  return {
    async find(query) {
      if (!query || Object.keys(query).length === 0) return coll.toArray();
      const entries = Object.entries(query as Record<string, unknown>);
      return coll.filter((doc) => matchesAll(doc as Record<string, unknown>, entries)).toArray();
    },
    async findOne(id) {
      const doc = await coll.get(id as string);
      return doc ?? null;
    },
    async insert(doc) {
      await coll.add(doc);
      return doc;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      await coll.bulkAdd(docs);
      return docs;
    },
    async upsert(doc) {
      await coll.put(doc);
      return doc;
    },
    async patch(id, patch) {
      const n = await coll.update(id as string, patch as object);
      if (n === 0) throw new Error(`patch: no doc with id=${id}`);
      const updated = await coll.get(id as string);
      if (!updated) throw new Error(`patch: doc id=${id} vanished after update`);
      return updated;
    },
    async remove(id) {
      await coll.delete(id as string);
    },
    async bulkRemove(ids) {
      if (ids.length === 0) return;
      await coll.bulkDelete(ids);
    },
    subscribe(fn): Unsubscribe {
      const obs = liveQuery(() => coll.toArray());
      const sub = obs.subscribe({
        next: (docs) => fn(docs),
      });
      return () => sub.unsubscribe();
    },
  };
}

/**
 * `rows(tableId)` returns a view scoped to one logical table. Inserts
 * auto-stamp `tableId`; queries auto-filter by it via the `tableId` index.
 */
function rowsView(coll: DexieTable<Row, string>, tableId: string): DataCollection<Row> {
  return {
    async find(query) {
      const base = coll.where('tableId').equals(tableId);
      if (!query || Object.keys(query).length === 0) return base.toArray();
      const entries = Object.entries(query as Record<string, unknown>);
      return base
        .filter((doc) => matchesAll(doc as unknown as Record<string, unknown>, entries))
        .toArray();
    },
    async findOne(id) {
      const doc = await coll.get(id);
      return doc && doc.tableId === tableId ? doc : null;
    },
    async insert(doc) {
      const stamped = { ...doc, tableId };
      await coll.add(stamped);
      return stamped;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      const stamped = docs.map((d) => ({ ...d, tableId }));
      await coll.bulkAdd(stamped);
      return stamped;
    },
    async upsert(doc) {
      const stamped = { ...doc, tableId };
      await coll.put(stamped);
      return stamped;
    },
    async patch(id, patch) {
      const n = await coll.update(id, patch as object);
      if (n === 0) throw new Error(`row patch: no row ${id}`);
      const updated = await coll.get(id);
      if (!updated) throw new Error(`row patch: row ${id} vanished after update`);
      return updated;
    },
    async remove(id) {
      await coll.delete(id);
    },
    async bulkRemove(ids) {
      if (ids.length === 0) return;
      await coll.bulkDelete(ids);
    },
    subscribe(fn): Unsubscribe {
      const obs = liveQuery(() => coll.where('tableId').equals(tableId).toArray());
      const sub = obs.subscribe({
        next: (docs) => fn(docs),
      });
      return () => sub.unsubscribe();
    },
  };
}

function matchesAll(doc: Record<string, unknown>, entries: Array<[string, unknown]>): boolean {
  for (const [k, v] of entries) if (doc[k] !== v) return false;
  return true;
}

export function createDataStore(db: EasyDb): DataStore {
  return {
    workspaces: wrap<Workspace>(db.workspaces),
    tables: wrap<Table>(db.tables),
    settings: wrap<Setting>(db.settings),
    plugins: wrap<PluginRecord>(db.plugins),
    rows: (tableId: string) => rowsView(db.rows, tableId),
  };
}
