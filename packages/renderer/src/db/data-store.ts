import type { RxCollection } from 'rxdb';
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
import type { EasyDatabase } from './rx-db.js';

/**
 * Wraps an RxCollection to satisfy the plugin-facing DataCollection<T> contract.
 * Keeps the plugin API stable even if we swap storage adapters or move off RxDB.
 */
function wrap<T extends { id: string } | { url: string } | { key: string }>(
  coll: RxCollection<T>,
  pk: keyof T,
): DataCollection<T> {
  return {
    async find(query) {
      const docs = await coll.find({ selector: (query as object) ?? {} }).exec();
      return docs.map((d) => d.toJSON() as T);
    },
    async findOne(id) {
      const doc = await coll.findOne(id as string).exec();
      return doc ? (doc.toJSON() as T) : null;
    },
    async insert(doc) {
      const inserted = await coll.insert(doc);
      return inserted.toJSON() as T;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      const res = await coll.bulkInsert(docs);
      return res.success.map((d) => d.toJSON() as T);
    },
    async upsert(doc) {
      const inserted = await coll.upsert(doc);
      return inserted.toJSON() as T;
    },
    async patch(id, patch) {
      const doc = await coll.findOne(id as string).exec();
      if (!doc) throw new Error(`patch: no doc with ${String(pk)}=${id}`);
      const updated = await doc.patch(patch as Partial<T>);
      return updated.toJSON() as T;
    },
    async remove(id) {
      const doc = await coll.findOne(id as string).exec();
      if (doc) await doc.remove();
    },
    subscribe(fn): Unsubscribe {
      const sub = coll
        .find()
        .$.subscribe((docs) => fn(docs.map((d) => d.toJSON() as T)));
      return () => sub.unsubscribe();
    },
  };
}

/**
 * `rows(tableId)` returns a DataCollection<Row> view scoped to one table.
 * Inserts auto-stamp tableId; queries auto-filter by it.
 */
function rowsView(coll: RxCollection<Row>, tableId: string): DataCollection<Row> {
  return {
    async find(query) {
      const selector = { ...(query as object), tableId };
      const docs = await coll.find({ selector }).exec();
      return docs.map((d) => d.toJSON() as Row);
    },
    async findOne(id) {
      const doc = await coll.findOne(id).exec();
      const json = doc?.toJSON() as Row | undefined;
      return json && json.tableId === tableId ? json : null;
    },
    async insert(doc) {
      const inserted = await coll.insert({ ...doc, tableId });
      return inserted.toJSON() as Row;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      const stamped = docs.map((d) => ({ ...d, tableId }));
      const res = await coll.bulkInsert(stamped);
      return res.success.map((d) => d.toJSON() as Row);
    },
    async upsert(doc) {
      const inserted = await coll.upsert({ ...doc, tableId });
      return inserted.toJSON() as Row;
    },
    async patch(id, patch) {
      const doc = await coll.findOne(id).exec();
      if (!doc) throw new Error(`row patch: no row ${id}`);
      const updated = await doc.patch(patch as Partial<Row>);
      return updated.toJSON() as Row;
    },
    async remove(id) {
      const doc = await coll.findOne(id).exec();
      if (doc) await doc.remove();
    },
    subscribe(fn): Unsubscribe {
      const sub = coll
        .find({ selector: { tableId } })
        .$.subscribe((docs) => fn(docs.map((d) => d.toJSON() as Row)));
      return () => sub.unsubscribe();
    },
  };
}

export function createDataStore(db: EasyDatabase): DataStore {
  return {
    workspaces: wrap<Workspace>(db.workspaces, 'id'),
    tables: wrap<Table>(db.tables, 'id'),
    settings: wrap<Setting>(db.settings, 'key'),
    plugins: wrap<PluginRecord>(db.plugins, 'url'),
    rows: (tableId: string) => rowsView(db.rows, tableId),
  };
}
