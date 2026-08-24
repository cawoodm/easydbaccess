// packages/renderer/src/db/legacy-idb/legacy-store.ts
//
// The legacy IndexedDB database, dressed as a `DataStore`.
//
// This is the whole trick of the migration. `db/edb/convert.ts` already copies
// one workspace from one `DataStore` into another, additively and in row
// batches — it is what "Save this workspace as a file" runs. Presenting the old
// database as a (read-only) `DataStore` means the migration needs no copy engine
// of its own, and inherits the batching, the progress reports and the
// provider-owned-table skip for free.
//
// Read-only, and every write throws rather than quietly doing nothing: a caller
// that tries to write HERE has misunderstood the direction of the copy, and a
// silent no-op would look like a successful migration that moved nothing.

import type { DataCollection, DataStore, PluginRecord, Row, Setting, Table, ViewInstance, ViewTemplate, Workspace } from '@easydb/shared';
import { type LegacyDb, type LegacyWorkspaceMeta, readLegacyRows } from './read.js';
import { applyRemap, legacyTableIds, remapRow, type Remap } from './remap.js';

/** Thrown on any attempt to write. */
function readOnly(): never {
  throw new Error('[legacy] the old browser store is read-only');
}

/** Shallow match, which is all `copyWorkspace` asks of `find`. */
function matches<T extends object>(doc: T, query: Partial<T>): boolean {
  return Object.entries(query).every(([k, v]) => (doc as Record<string, unknown>)[k] === v);
}

/**
 * A collection over documents already in hand.
 *
 * `subscribe` is a no-op that never fires: this is a snapshot of a database
 * nothing is writing to, so there is nothing to be notified about.
 */
function snapshot<T extends object>(docs: readonly T[], idOf: (doc: T) => string): DataCollection<T> {
  return {
    async find(query) {
      return query ? docs.filter((d) => matches(d, query)) : [...docs];
    },
    async findOne(id) {
      return docs.find((d) => idOf(d) === id) ?? null;
    },
    insert: readOnly,
    bulkInsert: readOnly,
    upsert: readOnly,
    patch: readOnly,
    remove: readOnly,
    bulkRemove: readOnly,
    subscribe: () => () => {},
    async count() {
      return docs.length;
    },
  };
}

/** A collection whose documents are fetched on the first read. */
function lazy<T extends object>(load: () => Promise<T[]>, idOf: (doc: T) => string): DataCollection<T> {
  let cached: Promise<T[]> | null = null;
  const docs = () => (cached ??= load());
  return {
    async find(query) {
      const all = await docs();
      return query ? all.filter((d) => matches(d, query)) : [...all];
    },
    async findOne(id) {
      return (await docs()).find((d) => idOf(d) === id) ?? null;
    },
    insert: readOnly,
    bulkInsert: readOnly,
    upsert: readOnly,
    patch: readOnly,
    remove: readOnly,
    bulkRemove: readOnly,
    subscribe: () => () => {},
    async count() {
      return (await docs()).length;
    },
  };
}

/**
 * Present one legacy workspace as a `DataStore`, under the ids `remap` gives it.
 *
 * `meta` is read up front because it is bounded — a workspace's tables, views and
 * settings — and `copyWorkspace` needs the table list before it can do anything.
 * Rows are NOT: each table's rows are fetched when that table's turn comes, and
 * released when the next one starts, so the peak cost is the largest single
 * table rather than the whole workspace.
 */
export function legacyWorkspaceStore(db: LegacyDb, meta: LegacyWorkspaceMeta, remap: Remap): DataStore {
  const seen = applyRemap(meta, remap);
  // The copy asks for rows by the id the table will HAVE; the database holds them
  // under the id it had.
  const legacyIdOf = legacyTableIds(remap);

  return {
    workspaces: snapshot<Workspace>([seen.workspace], (w) => w.id),
    tables: snapshot<Table>(seen.tables, (t) => t.id),
    settings: snapshot<Setting>(seen.settings, (s) => s.name),
    plugins: snapshot<PluginRecord>(seen.plugins, (p) => p.url),
    viewTemplates: snapshot<ViewTemplate>(seen.viewTemplates, (v) => v.id),
    viewInstances: snapshot<ViewInstance>(seen.viewInstances, (v) => v.id),
    rows(tableId) {
      const legacyTableId = legacyIdOf.get(tableId) ?? tableId;
      return lazy<Row>(
        async () => (await readLegacyRows(db, legacyTableId)).map((r) => remapRow(r, remap)),
        (r) => r.id,
      );
    },
  };
}
