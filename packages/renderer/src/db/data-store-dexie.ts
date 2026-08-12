import Dexie, { liveQuery, type ObservabilitySet, type Table as DexieTable } from 'dexie';
import type { DataCollection, DataStore, DistinctPage, DistinctQuery, PluginRecord, Row, RowPage, RowQuery, Setting, Table, Unsubscribe, ViewInstance, ViewTemplate, Workspace } from '@easydb/shared';
import { isPlainSlice } from '@easydb/shared';
import { settingId, type EasyDb } from './dexie-db.js';
import { applyRowRequest, projectFields } from './row-reader.js';
import { ROW_FETCH_CAP } from './data-store-bridge.js';
import { FACET_MAX_OPTIONS, facetCounts } from '../search/facet-values.js';

/**
 * Dexie-backed DataStore. Implements `DataCollection<T>` from the plugin API;
 * plugins never see Dexie itself.
 *
 * Subscriptions use Dexie's `liveQuery`, which re-runs the query closure on
 * every write to the referenced table. Coarse, but chrome callers consume
 * the full result set anyway so the granularity doesn't matter.
 */
function wrap<T extends { id: string } | { url: string } | { key: string }>(coll: DexieTable<T, string>): DataCollection<T> {
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
 * Call `fn` whenever anything is written to `coll`, without reading a row.
 *
 * `storagemutated` is the event `liveQuery` itself listens to, so this is the same
 * signal with the read left out. That read is the whole point: a caller that runs
 * its own narrow query used `subscribe`, and `subscribe` has to materialize the
 * collection to have an argument to pass — 609,283 rows to be told that one
 * changed.
 *
 * The set names each mutated part as `idb://<db>/<table>/<index>`, so the prefix
 * test scopes this to one Dexie table. It is NOT scoped to one `tableId`: the
 * answer to the signal is to re-run the caller's own query, which is right however
 * coarse the signal is, and an index range would have to be matched against
 * Dexie's own range trees to do better.
 */
function watchDexieTable<T>(coll: DexieTable<T, string>, fn: () => void): Unsubscribe {
  const prefix = `idb://${coll.db.name}/${coll.name}/`;
  const listener = (parts: ObservabilitySet) => {
    for (const part of Object.keys(parts)) {
      if (part.startsWith(prefix)) {
        fn();
        return;
      }
    }
  };
  Dexie.on('storagemutated', listener);
  return () => Dexie.on.storagemutated.unsubscribe(listener);
}

/**
 * `rows(tableId)` returns a view scoped to one logical table. Inserts
 * auto-stamp `tableId`, and queries auto-filter by it through the `tableId` index.
 *
 * `tables` is here for `query` alone: the filter language reads an `array` column
 * per MEMBER and skips a scripted column, so narrowing needs the `ColumnSpec`s and
 * a `RowQuery` does not carry them.
 */
function rowsView(coll: DexieTable<Row, string>, tableId: string, tables: DexieTable<Table, string>): DataCollection<Row> {
  return {
    async find(query) {
      const base = coll.where('tableId').equals(tableId);
      if (!query || Object.keys(query).length === 0) return base.toArray();
      const entries = Object.entries(query as Record<string, unknown>);
      return base.filter((doc) => matchesAll(doc as unknown as Record<string, unknown>, entries)).toArray();
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
    /**
     * Rows in this table, counted on the `tableId` index without reading any of
     * them — the denominator for a panel title, which is a different number from
     * how many a filter matched.
     */
    async count() {
      return coll.where('tableId').equals(tableId).count();
    },
    /**
     * Answers a `RowQuery`: these fields, filtered, sorted, this slice, plus how
     * many rows MATCH.
     *
     * Two paths, because IndexedDB can honor one of them and not the other.
     *
     * A PLAIN SLICE — no filter, no search, no sort — is a real windowed read.
     * `offset().limit()` walks the `tableId` index and reads only the page, and
     * `count()` answers the total without reading a row. This is the case that
     * matters: a big table is scrolled far more often than it is filtered, and
     * before this the browser read all 609,283 rows to draw about thirty.
     *
     * ANYTHING ELSE has to read the rows to match them. Our filter language is not
     * an IndexedDB query, and no index exists on the fields inside `data`. So the
     * read is capped, exactly as `readRows` capped it before, and a capped answer
     * says `truncated` instead of looking complete.
     *
     * Narrowing calls `applyRowRequest` — the same function the reader uses on the
     * rows it holds. Not a second implementation: a filter that means one thing in
     * the store and another in the renderer returns a wrong answer that looks
     * right, which is the failure this whole contract exists to prevent.
     */
    async query(q: RowQuery): Promise<RowPage> {
      const base = () => coll.where('tableId').equals(tableId);
      if (isPlainSlice(q)) {
        // No sort was asked for, so the index order is the answer — stable between
        // calls, which is what stops a page from shifting under the scrollbar.
        if (q.limit != null && q.limit > 0) {
          // A real page, so the total has to be counted separately. `offset`/`limit`
          // make Dexie walk the index with a cursor, one step per record skipped —
          // the price of no index on position, and cheap next to materialising the
          // whole table.
          //
          // The count is the OTHER walk of that index, and this store is the reason
          // `countTotal` exists: 730 ms per 100,000 rows, which on a 609,283-row
          // table doubled the time to first paint for a number no pixel needed yet.
          // Honored here, so a caller can take the rows now and count afterwards.
          const from = Math.max(0, q.offset ?? 0);
          const total = q.countTotal === false ? -1 : await base().count();
          const c = from > 0 ? base().offset(from).limit(q.limit) : base().limit(q.limit);
          return { rows: projectFields(await c.toArray(), q.fields), total };
        }
        // No page asked for: read in bulk and cap here. Capping with `limit()`
        // instead looks tidier and is much slower — it puts Dexie on the cursor
        // path for the whole read, where a plain `toArray()` uses IndexedDB's bulk
        // `getAll`.
        //
        // And no `count()` on this path: the rows in hand ARE the count unless the
        // cap bit, so counting first would be a second pass over the same index for
        // a number we already have. Measured on 20 000 rows it cost 629 ms of a
        // 2.5 s read, four times over while a view window started up.
        const all = await base().toArray();
        if (all.length <= ROW_FETCH_CAP) return { rows: projectFields(all, q.fields), total: all.length };
        return { rows: projectFields(all.slice(0, ROW_FETCH_CAP), q.fields), total: await base().count(), truncated: true };
      }
      // Bulk read — see the note above on why `limit()` is the slow way to bound a
      // read that is not a page.
      const all = await base().toArray();
      const columns = (await tables.get(tableId))?.columns ?? [];
      // Narrow FIRST, cap the answer second. The other way round answers "these of
      // the first 20,000" to a question about the table: a row matching at 30,000 is
      // simply absent, and the grid looks like it filtered correctly. `total` then
      // counts every match, so the truncation note can say how many were left out.
      const page = applyRowRequest(all, { columns, ...q });
      const capped = page.rows.length > ROW_FETCH_CAP;
      return { ...page, ...(capped ? { rows: page.rows.slice(0, ROW_FETCH_CAP), truncated: true } : {}) };
    },
    /**
     * The distinct values of one field, for the funnel's picker.
     *
     * IndexedDB has nothing to group by here — the values live inside `data`, which
     * no index covers — so this reads the rows and counts them. That is exactly why
     * it is behind a refresh button: correct on demand beats a scan on every funnel
     * click. The read is capped like every other, and a capped answer says
     * `truncated` rather than passing a partial list off as the column's values.
     *
     * The counting is `facetCounts`, the same function that builds the list from the
     * rows in memory. Blanks, the commonest-first order, `array` members counted one
     * by one, `boolean` always offering both sides — all of it has to agree with the
     * list this replaces, and one implementation cannot disagree with itself.
     */
    async distinct(q: DistinctQuery): Promise<DistinctPage> {
      // Every row, not the first 20,000: this is the whole point of the refresh the
      // user pressed. A value that only appears at row 30,000 must be offered, or
      // the "whole column" is another partial list wearing a different label.
      const all = await coll.where('tableId').equals(tableId).toArray();
      const columns = (await tables.get(tableId))?.columns ?? [];
      // The other columns' filters, applied here so the list stays faceted. The
      // caller already left this field's own filter out of `where`.
      const narrowed = q.where ? applyRowRequest(all, { columns, ...q.where, offset: 0, limit: 0 }).rows : all;
      const type = columns.find((c) => c.field === q.field)?.type;
      const { values, blanks } = facetCounts(narrowed, q.field, { type });
      const max = q.limit && q.limit > 0 ? q.limit : FACET_MAX_OPTIONS;
      return {
        values: values.slice(0, max),
        blanks,
        ...(values.length > max ? { truncated: true } : {}),
      };
    },
    subscribe(fn): Unsubscribe {
      const obs = liveQuery(() => coll.where('tableId').equals(tableId).toArray());
      const sub = obs.subscribe({
        next: (docs) => fn(docs),
      });
      return () => sub.unsubscribe();
    },
    /**
     * The bare change signal, so a caller running its own query does not pay for
     * every row to learn that one of them moved.
     *
     * This once read "no `watch` here on purpose", on the grounds that a cheap
     * `liveQuery` key would stay silent when a cell is edited in place. That is
     * true of a key, and beside the point: `storagemutated` fires on the write
     * itself, before any query is re-run, so an in-place edit is signalled like
     * any other mutation. Reading the rows was never the only reliable signal, and
     * in a table of 609,283 rows it cost seconds per write.
     *
     * Fires once immediately, matching `subscribe` and the IPC store's `watch`, so
     * a caller has one code path for "load now" and "load again".
     */
    watch(fn): Unsubscribe {
      fn();
      return watchDexieTable(coll, fn);
    },
  };
}

/**
 * A view over the settings of ONE workspace. Callers address a setting by its
 * logical `name` — `findOne('gist-sync:user')`, `upsert({ name, value })` — and
 * this maps it to the physical `<workspaceId>::<name>` key, so the same name can
 * exist once per workspace.
 *
 * `workspaceId` is read per call: the store is built before the active workspace
 * is resolved (see `app-context.ts`).
 *
 * An incoming `key`/`workspaceId` on a write is IGNORED and re-derived. That is
 * what lets a gist pull upsert another device's settings straight into the local
 * workspace instead of carrying its workspace id along.
 */
function settingsView(coll: DexieTable<Setting, string>, workspaceId: () => string): DataCollection<Setting> {
  const stamp = (doc: Partial<Setting> & { name: string }): Setting => ({
    ...doc,
    workspaceId: workspaceId(),
    key: settingId(workspaceId(), doc.name),
    name: doc.name,
    value: doc.value,
  });
  const mine = () => coll.where('workspaceId').equals(workspaceId());
  return {
    async find(query) {
      const all = await mine().toArray();
      if (!query || Object.keys(query).length === 0) return all;
      const entries = Object.entries(query as Record<string, unknown>);
      return all.filter((doc) => matchesAll(doc as unknown as Record<string, unknown>, entries));
    },
    async findOne(name) {
      const doc = await coll.get(settingId(workspaceId(), name as string));
      return doc ?? null;
    },
    async insert(doc) {
      const stamped = stamp(doc as Setting);
      await coll.add(stamped);
      return stamped;
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      const stamped = docs.map((d) => stamp(d as Setting));
      await coll.bulkAdd(stamped);
      return stamped;
    },
    async upsert(doc) {
      const stamped = stamp(doc as Setting);
      await coll.put(stamped);
      return stamped;
    },
    async patch(name, patch) {
      const key = settingId(workspaceId(), name as string);
      const n = await coll.update(key, patch as object);
      if (n === 0) throw new Error(`setting patch: no setting ${name}`);
      const updated = await coll.get(key);
      if (!updated) throw new Error(`setting patch: ${name} vanished after update`);
      return updated;
    },
    async remove(name) {
      await coll.delete(settingId(workspaceId(), name as string));
    },
    async bulkRemove(names) {
      if (names.length === 0) return;
      await coll.bulkDelete(names.map((n) => settingId(workspaceId(), n as string)));
    },
    subscribe(fn): Unsubscribe {
      const obs = liveQuery(() => mine().toArray());
      const sub = obs.subscribe({ next: (docs) => fn(docs) });
      return () => sub.unsubscribe();
    },
  };
}

function matchesAll(doc: Record<string, unknown>, entries: Array<[string, unknown]>): boolean {
  for (const [k, v] of entries) if (doc[k] !== v) return false;
  return true;
}

/**
 * `workspaceId` is a getter, not a value: `app-context.ts` builds the store first
 * and resolves the active workspace with it, so the id is not known yet here.
 */
export function createDataStore(db: EasyDb, workspaceId: () => string): DataStore {
  return {
    workspaces: wrap<Workspace>(db.workspaces),
    tables: wrap<Table>(db.tables),
    settings: settingsView(db.settings, workspaceId),
    plugins: wrap<PluginRecord>(db.plugins),
    viewTemplates: wrap<ViewTemplate>(db.viewTemplates),
    viewInstances: wrap<ViewInstance>(db.viewInstances),
    rows: (tableId: string) => rowsView(db.rows, tableId, db.tables),
  };
}
