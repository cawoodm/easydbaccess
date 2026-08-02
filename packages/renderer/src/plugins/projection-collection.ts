// packages/renderer/src/plugins/projection-collection.ts
//
// The live row collection behind a Projection (a virtual table / view / JOIN).
// A Table carrying `source: { type: 'projection', config: ProjectionSpec }`
// routes its rows here instead of Dexie. This factory resolves the spec's
// source tables (by name), reads their rows through the captured store, and
// runs the pure `computeProjection` pipeline — re-running whenever any source
// table changes so the projection stays live.
//
// Writeback: an edit is accepted only for a base-source, non-computed column
// (see `writebackTarget`); it is written to the underlying base row, whose
// change flows back through the subscriptions and recomputes the projection.
//
// The provider is created from the projection PLUGIN's `init(api)`, so it
// closes over `api.store` (the routed store — hence projection-on-projection
// composes) and needs nothing store-related from `RowSourceCtx`.

import type {
  DataCollection,
  DataStore,
  ProjectionSpec,
  Row,
  Table,
  Unsubscribe,
} from '@easydb/shared';
import {
  computeProjection,
  hasProjectionCycle,
  resolveWritability,
  writebackTarget,
  type SourceRowsByAlias,
} from './projection-compute.js';

/** Thrown when a write is attempted against a read-only projection cell. */
export class ProjectionReadOnlyError extends Error {
  constructor(detail = 'this cell is derived') {
    super(`Projection is read-only — ${detail}. Edit a base-table column, or import a copy.`);
    this.name = 'ProjectionReadOnlyError';
  }
}

function parseSpec(config: unknown): ProjectionSpec {
  const spec = config as Partial<ProjectionSpec> | undefined;
  if (!spec || !Array.isArray(spec.sources) || !Array.isArray(spec.columns)) {
    return { version: 1, sources: [], columns: [] };
  }
  return spec as ProjectionSpec;
}

function matchesQuery(row: Row, query: Partial<Row>): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (k === 'data') continue;
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

export function createProjectionCollection(store: DataStore, table: Table): DataCollection<Row> {
  const spec = parseSpec(table.source?.config);

  const subscribers = new Set<(rows: Row[]) => void>();
  let cache: Row[] = [];
  let loaded = false;
  let inFlight: Promise<Row[]> | null = null;
  const sourceSubs = new Map<string, Unsubscribe>(); // source tableId → unsubscribe
  let tablesSub: Unsubscribe | null = null;
  let queued = false;

  /**
   * alias → the id of the table that source currently NAMES.
   *
   * Re-derived from the live table list on every run rather than remembered:
   * a source table that is deleted and re-imported comes back under the same
   * name with a different id, and this projection must follow it there.
   */
  function mapSourceIds(all: Table[]): Map<string, string> {
    const byName = new Map<string, Table>();
    for (const t of all) if (!byName.has(t.name)) byName.set(t.name, t);
    const map = new Map<string, string>();
    for (const s of spec.sources) {
      const resolved = byName.get(s.tableName);
      if (resolved) map.set(s.alias, resolved.id);
    }
    return map;
  }

  async function resolveSourceTableIds(): Promise<Map<string, string>> {
    return mapSourceIds(await store.tables.find({ workspaceId: table.workspaceId }));
  }

  async function compute(): Promise<Row[]> {
    const all = await store.tables.find({ workspaceId: table.workspaceId });
    // A cycle is a property of how the projections are DEFINED, so it is decided
    // from the spec graph. (An ambient "already computing" flag cannot tell a
    // real cycle from two ordinary concurrent reads, and guessing wrong would
    // publish an empty result for a perfectly good projection.)
    if (hasProjectionCycle(table.id, all)) return [];
    const ids = mapSourceIds(all);
    const sourceRows: SourceRowsByAlias = {};
    for (const s of spec.sources) {
      const tid = ids.get(s.alias);
      if (!tid) return []; // a source table is missing → render empty
      sourceRows[s.alias] = await store.rows(tid).find();
    }
    return computeProjection(spec, sourceRows).map((r) => ({ ...r, tableId: table.id }));
  }

  /** Recompute and adopt the result as the cache. */
  async function recompute(): Promise<Row[]> {
    const rows = await compute();
    cache = rows;
    loaded = true;
    return rows;
  }

  /**
   * First read: collapse concurrent callers onto ONE compute. The grid both
   * `find()`s and `subscribe()`s in the same tick, so without this the same
   * projection would be computed twice on open.
   */
  function loadAll(): Promise<Row[]> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await recompute();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** (Re)subscribe to exactly the current set of source tables' row streams. */
  async function refreshSubscriptions(): Promise<void> {
    const ids = await resolveSourceTableIds();
    const wanted = new Set(ids.values());
    for (const [tid, unsub] of sourceSubs) {
      if (!wanted.has(tid)) {
        unsub();
        sourceSubs.delete(tid);
      }
    }
    for (const tid of wanted) {
      if (!sourceSubs.has(tid)) sourceSubs.set(tid, store.rows(tid).subscribe(scheduleRecompute));
    }
  }

  function scheduleRecompute(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(async () => {
      queued = false;
      await refreshSubscriptions();
      // The very first delivery may share an in-flight `find()`; a recompute
      // triggered by a CHANGE must not reuse a snapshot that predates it.
      const rows = loaded ? await recompute() : await loadAll();
      for (const fn of subscribers) fn(rows);
    });
  }

  async function writeBack(rowId: string, data: Record<string, unknown>): Promise<Row> {
    const writable = resolveWritability(spec);
    const updates: Record<string, unknown> = {};
    let baseRowId: string | null = null;
    for (const [outField, value] of Object.entries(data)) {
      if (!writable.has(outField)) continue;
      const target = writebackTarget(spec, rowId, outField);
      if (!target) continue;
      baseRowId = target.baseRowId;
      updates[target.field] = value;
    }
    if (!baseRowId || Object.keys(updates).length === 0) throw new ProjectionReadOnlyError();

    const ids = await resolveSourceTableIds();
    const baseAlias = spec.sources[0]?.alias;
    const baseTableId = baseAlias ? ids.get(baseAlias) : undefined;
    if (!baseTableId) throw new ProjectionReadOnlyError('the base table is not available');

    const base = store.rows(baseTableId);
    const existing = await base.findOne(baseRowId);
    if (!existing) throw new ProjectionReadOnlyError('the underlying row no longer exists');
    await base.patch(baseRowId, { data: { ...existing.data, ...updates }, updatedAt: Date.now() });
    return { id: rowId, tableId: table.id, data, updatedAt: Date.now() };
  }

  return {
    async find(query) {
      const rows = loaded ? cache : await loadAll();
      if (!query || Object.keys(query).length === 0) return rows;
      return rows.filter((r) => matchesQuery(r, query));
    },
    async findOne(id) {
      const rows = loaded ? cache : await loadAll();
      return rows.find((r) => r.id === id) ?? null;
    },
    async insert() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    async bulkInsert() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    async upsert(doc) {
      return writeBack(doc.id, doc.data);
    },
    async patch(id, patch) {
      if (!patch.data) throw new ProjectionReadOnlyError('a cell edit must carry row data');
      return writeBack(id, patch.data);
    },
    async remove() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    async bulkRemove() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    subscribe(fn): Unsubscribe {
      subscribers.add(fn);
      if (!tablesSub) tablesSub = store.tables.subscribe(scheduleRecompute);
      if (loaded) fn(cache);
      else scheduleRecompute();
      return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) {
          tablesSub?.();
          tablesSub = null;
          for (const unsub of sourceSubs.values()) unsub();
          sourceSubs.clear();
          loaded = false;
        }
      };
    },
    async refresh() {
      await refreshSubscriptions();
      const rows = await recompute();
      for (const fn of subscribers) fn(rows);
    },
  };
}
