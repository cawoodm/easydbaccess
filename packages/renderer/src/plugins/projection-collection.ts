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

/**
 * Guards against a projection that (directly or transitively) sources itself.
 * Shared across all projection collections: while a projection is mid-compute
 * its id sits here, so a re-entrant read of the same projection returns [] and
 * breaks the cycle instead of recursing forever.
 */
const computing = new Set<string>();

/** Depth backstop in case the id-based guard is ever defeated by aliasing. */
const MAX_DEPTH = 8;
let depth = 0;

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
  const sourceSubs = new Map<string, Unsubscribe>(); // source tableId → unsubscribe
  let tablesSub: Unsubscribe | null = null;
  let queued = false;

  /** alias → resolved source tableId (by name, `tableId` used only as a hint). */
  async function resolveSourceTableIds(): Promise<Map<string, string>> {
    const all = await store.tables.find({ workspaceId: table.workspaceId });
    const byName = new Map<string, Table>();
    for (const t of all) if (!byName.has(t.name)) byName.set(t.name, t);
    const map = new Map<string, string>();
    for (const s of spec.sources) {
      let resolved: Table | undefined;
      if (s.tableId) {
        const hit = all.find((t) => t.id === s.tableId);
        if (hit && hit.name === s.tableName) resolved = hit;
      }
      resolved ??= byName.get(s.tableName);
      if (resolved) map.set(s.alias, resolved.id);
    }
    return map;
  }

  async function compute(): Promise<Row[]> {
    if (computing.has(table.id) || depth >= MAX_DEPTH) return []; // cycle / depth guard
    computing.add(table.id);
    depth++;
    try {
      const ids = await resolveSourceTableIds();
      const sourceRows: SourceRowsByAlias = {};
      for (const s of spec.sources) {
        const tid = ids.get(s.alias);
        if (!tid) return []; // a source table is missing → render empty
        sourceRows[s.alias] = await store.rows(tid).find();
      }
      return computeProjection(spec, sourceRows).map((r) => ({ ...r, tableId: table.id }));
    } finally {
      computing.delete(table.id);
      depth--;
    }
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
      cache = await compute();
      loaded = true;
      for (const fn of subscribers) fn(cache);
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
      const rows = loaded ? cache : ((cache = await compute()), (loaded = true), cache);
      if (!query || Object.keys(query).length === 0) return rows;
      return rows.filter((r) => matchesQuery(r, query));
    },
    async findOne(id) {
      const rows = loaded ? cache : await compute();
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
      cache = await compute();
      loaded = true;
      for (const fn of subscribers) fn(cache);
    },
  };
}
